import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPreset } from '@agnes/code'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { sqlitePersistenceProvider } from '@agnes/host-infrastructure/adapters/storage-provider'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

it('business consent: narrowing before commit and revocation inside SQLite roll back the signed write', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-business-commit-')))
  const h = await createTestHost({
    dataDir,
    allowed: ['standard'],
    presets: {
      'permission-full-access': loadPreset('permission-full-access'),
    },
  })
  mkdirSync(join(dataDir, 'business'))
  const persistence = await sqlitePersistenceProvider.open({ dataDir: join(dataDir, 'business') })
  if (!persistence.metadata) throw new Error('Missing fixture metadata')
  const store = ownedStore(persistence.metadata.namespace('@fixture/business', 'quality'), () => {}, true)
  try {
    for (const gap of ['before-transaction', 'inside-transaction']) {
      const session = await h.host.createSession({
        key: gap,
        cwd: dataDir,
        preset: 'standard',
        permission: 'full-access',
      })
      const port = session.decisions.port({
        owner: '@fixture/business',
        sourcePackage: '@fixture/business',
        packageVersion: '1',
        operationId: 'release',
        alive() {},
      })
      const handle = await port.request({
        key: 'release',
        purpose: 'business.confirm',
        subject: { object: 'B-001', revision: 1, evidence: ['EV-001'] },
        prompt: 'Sign release?',
        options: ['allowed-once', 'rejected'],
        responseSchema: { type: 'string', const: 'I approve release.' },
        presentation: { en: { title: 'Release', fields: [], responseValue: 'I approve release.' } },
      })
      expect((await port.get(handle)).result).toMatchObject({
        code: 'full-access',
        answeredBy: { id: session.d.actor.id, role: session.d.actor.role },
      })
      const admission = await port.admit!(handle)
      await admission.verify()
      if (gap === 'before-transaction') await session.setPreset(h.host.validatePresetSwitch('standard').view)
      expect(() =>
        store.transaction(() => {
          store.set('certificate', { signer: session.d.actor.id, decisionId: handle.id })
          if (gap === 'inside-transaction') session.revokeAutomaticPermissions()
        }, admission),
      ).toThrow()
      expect(store.get('certificate')).toBeUndefined()
      expect((await port.get(handle)).consumption).not.toBeNull()
    }
  } finally {
    await persistence.close()
    await h.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('review: a genuinely forked child narrowed from a full-access parent has no automatic permission', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-full-access-child-')))
  const h = await createTestHost({
    dataDir,
    allowed: ['standard'],
    presets: {
      'permission-full-access': loadPreset('permission-full-access'),
      'permission-read-only': loadPreset('permission-read-only'),
    },
    script: [
      () => [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const parent = await h.host.createSession({
      key: 'review-parent',
      cwd: dataDir,
      preset: 'standard',
      permission: 'full-access',
    })
    const parentPermissions = parent.decisions.port({
      permission: true,
      owner: 'core/review',
      sourcePackage: '@agnes/core',
      packageVersion: '1',
      operationId: 'parent',
      alive() {},
    })
    const inherited = await parentPermissions.request({
      key: 'inherited',
      purpose: 'tool.permission',
      subject: { call: 'parent' },
      prompt: 'Allow?',
      options: ['allowed-once', 'rejected'],
    })
    await parent.enqueue('next-turn', {
      content: [{ type: 'text', text: 'establish boundary' }],
      actor: parent.d.actor,
    })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    const [end] = await parent.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    if (!end) throw new Error('No parent turn boundary')
    const child = await h.host.createSession({
      key: 'review-child',
      cwd: dataDir,
      parent: { key: parent.key, boundarySeq: end.seq },
    })
    const readOnly = h.host.validatePresetSwitch('standard').view
    await child.setPreset({
      ...readOnly,
      permission: 'read-only',
      approval: { ...readOnly.approval, policy: 'read-only' },
    })
    expect((await parentPermissions.get(inherited)).invalidation).toBeNull()
    const inheritedRows = (await child.scan({ type: 'decision/state', limit: 20 })).filter(
      (row) => (row.data as { handle: { id: string } }).handle.id === inherited.id,
    )
    expect(inheritedRows.length).toBeGreaterThan(0)
    expect(inheritedRows.every((row) => !(row.data as { invalidation: unknown }).invalidation)).toBe(true)
    const port = child.decisions.port({
      owner: 'fixture/review',
      sourcePackage: '@fixture/review',
      packageVersion: '1.0.0',
      operationId: 'child-operation',
      alive() {},
    })
    const handle = await port.request({
      key: 'child-permission',
      purpose: 'tool.permission',
      subject: { call: 'child' },
      prompt: 'Allow?',
      options: ['allowed-once', 'rejected'],
    })
    expect(parent.preset.permission).toBe('full-access')
    expect(child.preset.permission).toBe('read-only')
    expect((await port.get(handle)).result).toBeNull()
  } finally {
    await h.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('review: full access retains private-home and must-read-first hard refusals', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-full-access-hard-refusals-')))
  writeFileSync(join(dataDir, 'existing.txt'), 'original content')
  const h = await createTestHost({
    dataDir,
    allowed: ['standard'],
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    presets: {
      'permission-full-access': loadPreset('permission-full-access'),
    },
    approval: async () => {
      throw new Error('Unexpected human permission request')
    },
    script: [
      () => [
        {
          type: 'toolcall_end',
          call: {
            toolUseId: '',
            name: 'write',
            args: { path: 'existing.txt', content: 'replacement' },
            ordinal: 0,
          },
          via: 'native',
        },
        {
          type: 'toolcall_end',
          call: {
            toolUseId: '',
            name: 'edit',
            args: { path: 'existing.txt', edits: [{ oldText: 'original', newText: 'replacement' }] },
            ordinal: 1,
          },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ],
      () => [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const session = await h.host.createSession({
      cwd: dataDir,
      preset: 'standard',
      permission: 'full-access',
    })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'exercise hard refusals' }],
      actor: session.d.actor,
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const results = await session.scan({ type: 'tool/result', limit: 10 })
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.data).toMatchObject({ isError: true })
    }
    for (const text of [
      'write refused: read "existing.txt" with the read tool in this session before overwriting it',
      'edit refused: read "existing.txt" with the read tool in this session before editing it',
    ])
      expect(results.map((result) => result.data)).toContainEqual(
        expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ type: 'text', text })]),
        }),
      )
    expect(readFileSync(join(dataDir, 'existing.txt'), 'utf8')).toBe('original content')
    const port = session.d.workspaceInvocation
    if (!port) throw new Error('No workspace invocation')
    await port.run(async (view) => {
      for (const directory of ['secrets', 'auth', 'profiles']) {
        mkdirSync(join(dataDir, directory), { recursive: true })
        const relative = `${directory}/review-synthetic`
        writeFileSync(join(dataDir, relative), 'synthetic-private-value')
        await expect(view.fs().read(relative)).rejects.toThrow(/E_FS_DENIED/)
        await expect(view.fs().write(relative, new TextEncoder().encode('changed'))).rejects.toThrow(
          /E_FS_DENIED/,
        )
        expect(readFileSync(join(dataDir, relative), 'utf8')).toBe('synthetic-private-value')
      }
    })
  } finally {
    await h.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('round6: nested signed writes retain admission until the outer SQLite commit', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-business-commit-')))
  const h = await createTestHost({
    dataDir,
    allowed: ['standard'],
    presets: {
      'permission-full-access': loadPreset('permission-full-access'),
    },
  })
  mkdirSync(join(dataDir, 'business'))
  const persistence = await sqlitePersistenceProvider.open({ dataDir: join(dataDir, 'business') })
  if (!persistence.metadata) throw new Error('Missing fixture metadata')
  const store = ownedStore(persistence.metadata.namespace('@fixture/business', 'quality'), () => {}, true)
  try {
    for (const gap of ['after-inner-transaction']) {
      const session = await h.host.createSession({
        key: gap,
        cwd: dataDir,
        preset: 'standard',
        permission: 'full-access',
      })
      const port = session.decisions.port({
        owner: '@fixture/business',
        sourcePackage: '@fixture/business',
        packageVersion: '1',
        operationId: 'release',
        alive() {},
      })
      const handle = await port.request({
        key: 'release',
        purpose: 'business.confirm',
        subject: { object: 'B-001', revision: 1, evidence: ['EV-001'] },
        prompt: 'Sign release?',
        options: ['allowed-once', 'rejected'],
        responseSchema: { type: 'string', const: 'I approve release.' },
        presentation: { en: { title: 'Release', fields: [], responseValue: 'I approve release.' } },
      })
      expect((await port.get(handle)).result).toMatchObject({
        code: 'full-access',
        answeredBy: { id: session.d.actor.id, role: session.d.actor.role },
      })
      const admission = await port.admit!(handle)
      await admission.verify()
      if (gap === 'before-transaction') await session.setPreset(h.host.validatePresetSwitch('standard').view)
      let refused = false
      try {
        store.transaction(() => {
          store.transaction(() => {
            store.set('certificate', { signer: session.d.actor.id, decisionId: handle.id })
          }, admission)
          session.revokeAutomaticPermissions()
        })
      } catch {
        refused = true
      }
      expect.soft(store.get('certificate')).toBeUndefined()
      expect.soft(refused).toBe(true)
      expect((await port.get(handle)).consumption).not.toBeNull()
    }
  } finally {
    await persistence.close()
    await h.host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

it('review: a genuinely forked child narrowed from a full-access parent has no automatic permission', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-full-access-child-')))
  const h = await createTestHost({
    dataDir,
    allowed: ['standard', 'full-access', 'read-only'],
    presets: {
      'full-access': { name: 'full-access', extends: 'standard' },
      'read-only': { name: 'read-only', extends: 'standard' },
    },
    script: [
      () => [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const parent = await h.host.createSession({ key: 'review-parent', cwd: dataDir, preset: 'full-access' })
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
    await child.setPreset(h.host.validatePresetSwitch('read-only').view)
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
    expect(parent.preset.name).toBe('full-access')
    expect(child.preset.name).toBe('read-only')
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
    allowed: ['standard', 'full-access'],
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    presets: { 'full-access': { name: 'full-access', extends: 'standard' } },
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
    const session = await h.host.createSession({ cwd: dataDir, preset: 'full-access' })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'exercise hard refusals' }],
      actor: session.d.actor,
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const results = await session.scan({ type: 'tool/result', limit: 10 })
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.data).toMatchObject({ isError: true })
      expect(JSON.stringify(result.data)).toContain('read existing.txt in this session before')
    }
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

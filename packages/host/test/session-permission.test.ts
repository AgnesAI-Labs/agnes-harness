import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimes } from '@agnes/code'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { sessionSelection } from '../src/runtime/sessions/session.js'
import { createTestHost } from '../testkit/index.js'

const dirs = ['../../base/presets/', '../../code/presets/'].map((p) => new URL(p, import.meta.url))
const docs: Record<string, PresetDoc> = Object.fromEntries(
  dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => {
        const doc = parse(readFileSync(new URL(name, dir), 'utf8')) as PresetDoc
        return [doc.name, doc] as const
      }),
  ),
)
docs['app-role'] = { name: 'app-role', extends: 'standard', approval: { command_policy: [] } }
docs.confined = {
  name: 'confined',
  extends: 'standard',
  sandbox: { level: 'L1', required: true, on_unavailable: 'deny' },
}
docs.default = { name: 'default', extends: 'standard' }
const recipes = Object.keys(docs).filter((name) => !name.startsWith('permission-'))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function open() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-session-permission-'))
  roots.push(dataDir)
  const { base, ...product } = docs
  const options = {
    dataDir,
    allowed: recipes,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: { '@agnes/base': { presets: { base: base! } }, '@agnes/code': { presets: product, runtimes } },
  }
  const { host } = await createTestHost(options)
  return { host, dataDir, options }
}

const startRow = async (session: { scan: (q: object) => Promise<Array<{ data: unknown }>> }) =>
  (await session.scan({ type: 'session/start', limit: 1 }))[0]?.data as {
    preset: string
    permission?: string
  }

describe('a session opens under a recipe and a permission, and keeps both', () => {
  it('runs ptc under read-only, records it, and restores it when reopened', async () => {
    const { host, dataDir, options } = await open()
    const session = await host.createSession({ cwd: dataDir, preset: 'ptc', permission: 'read-only' })
    const key = session.key
    expect(session.preset.name).toBe('ptc')
    expect(session.preset.permission).toBe('read-only')
    expect(session.toolPolicy().id).toBe('read-only')
    await expect(session.setYolo(true, session.d.actor)).rejects.toThrow('requires a new session')
    expect(session.yolo).toBe(false)
    expect(await startRow(session)).toMatchObject({ preset: 'ptc', permission: 'read-only' })
    await session.close()
    await host.close()
    // A fresh host and no options: the recorded level, not the default, decides.
    const second = (await createTestHost(options)).host
    const reopened = await second.createSession({ key, cwd: dataDir })
    expect(reopened.preset.name).toBe('ptc')
    expect(reopened.preset.permission).toBe('read-only')
    expect(reopened.toolPolicy().id).toBe('read-only')
    await reopened.close()
    await second.close()
  })

  it.each(
    ['standard', 'minimal', 'ptc'].flatMap((preset) =>
      (['read-only', 'workspace-write', 'full-access'] as const).map((permission) => ({
        preset,
        permission,
      })),
    ),
  )(
    'uses the resolved $permission axis for $preset automatic permission authority',
    async ({ preset, permission }) => {
      const { host, dataDir } = await open()
      try {
        const session = await host.createSession({ cwd: dataDir, preset, permission })
        expect(session.permissionContext.policy).toBe(permission)
        const port = session.decisions.port({
          permission: true,
          owner: 'core/permission-axis',
          sourcePackage: '@agnes/core',
          packageVersion: '1',
          operationId: 'axis',
          alive() {},
        })
        for (const purpose of [
          'tool.permission',
          'skills.install',
          'budget',
          'business.confirm',
          'plan.exit',
          'unknown-outcome',
          'ask_user',
        ]) {
          const handle = await port.request({
            key: purpose,
            purpose,
            subject: { binding: purpose },
            prompt: 'Allow?',
            options: ['allowed-once', 'rejected'],
          })
          const value = await port.get(handle)
          if (
            permission === 'full-access' &&
            ['tool.permission', 'skills.install', 'budget'].includes(purpose)
          )
            expect(value.result).toMatchObject({ code: 'full-access', response: { option: 'allowed-once' } })
          else expect(value.result).toBeNull()
        }
        const before = session.permissionContext
        await session.setPreset(
          host.validatePresetSwitch(preset === 'standard' ? 'minimal' : 'standard', session.key).view,
        )
        expect(session.permissionContext).toMatchObject({
          policy: permission,
          sessionId: before.sessionId,
          epoch: before.epoch + 1,
        })
        await session.close()
      } finally {
        await host.close()
      }
    },
  )

  it('refuses to reopen a stored session under another level instead of ignoring the request', async () => {
    const { host, dataDir, options } = await open()
    const session = await host.createSession({ cwd: dataDir, preset: 'ptc', permission: 'full-access' })
    const key = session.key
    await session.close()
    await host.close()
    const second = (await createTestHost(options)).host
    await expect(second.createSession({ key, cwd: dataDir, permission: 'read-only' })).rejects.toMatchObject({
      code: 'E_PRESET_UNSUPPORTED',
    })
    // The same level, or following the default, is not a conflict.
    for (const permission of ['full-access', 'default'] as const) {
      const again = await second.createSession({ key, cwd: dataDir, permission })
      expect(again.preset.permission).toBe('full-access')
      await again.close()
    }
    await second.close()
  })

  it('reopens a session that switched to a recipe fixing its own permission', async () => {
    const { host, dataDir, options } = await open()
    const session = await host.createSession({
      cwd: dataDir,
      preset: 'standard',
      permission: 'workspace-write',
    })
    const key = session.key
    await session.setPreset(host.validatePresetSwitch('standard-windows', key).view)
    await session.close()
    await host.close()
    const second = (await createTestHost(options)).host
    const reopened = await second.createSession({ key, cwd: dataDir })
    expect(reopened.preset.name).toBe('standard-windows')
    await reopened.close()
    await second.close()
  })

  it('follows the deployment permission for real recipes, including a recipe named default', async () => {
    const { host, dataDir } = await open()
    const cases = [
      ['default', 'workspace-write'],
      ['ptc', 'workspace-write'],
      ['minimal', 'workspace-write'],
    ] as const
    for (const [preset, permission] of cases) {
      const session = await host.createSession({ key: `recipe-${preset}`, cwd: dataDir, preset })
      expect(session.preset.name).toBe(preset)
      expect(session.preset.permission, preset).toBe(permission)
      expect(session.permissionContext.policy, preset).toBe(permission)
      await session.close()
    }
    await host.close()
  })

  it('refuses retired permission-level recipe aliases with any permission selection', async () => {
    const { host, dataDir } = await open()
    for (const preset of ['read-only', 'workspace-write', 'full-access'])
      for (const permission of [undefined, preset, 'full-access'])
        await expect(
          host.createSession({ cwd: dataDir, preset, ...(permission === undefined ? {} : { permission }) }),
        ).rejects.toThrow(/Retired.*clean home/)
    await host.close()
  })

  it.each(['read-only', 'full-access'] as const)(
    'keeps %s across a recipe switch and refuses a live level change through Host',
    async (permission) => {
      const { host, dataDir, options } = await open()
      const session = await host.createSession({ cwd: dataDir, preset: 'ptc', permission })
      const key = session.key
      const next = host.validatePresetSwitch('standard', key)
      expect(next.permission).toBe(permission)
      expect((next.doc.providers as { 'tool-policy': { provider: string } })['tool-policy'].provider).toBe(
        permission,
      )
      await host.setSessionPreset(key, 'standard')
      const before = session.permissionContext
      const seq = session.lastSeq
      for (const target of ['workspace-write', permission === 'read-only' ? 'full-access' : 'read-only']) {
        expect(() => host.validatePresetSwitch(target, key)).toThrow('Retired permission-as-preset alias')
        await expect(host.setSessionPreset(key, target)).rejects.toThrow('Retired permission-as-preset alias')
        expect(session.permissionContext).toEqual(before)
        expect(session.preset).toMatchObject({ name: 'standard', permission })
        expect(session.lastSeq).toBe(seq)
      }
      await expect(host.setSessionPreset(key, 'confined')).rejects.toMatchObject({
        code: 'E_PRESET_UNSUPPORTED',
        detail: { reason: 'workspace-sandbox-change' },
      })
      expect(session.permissionContext).toEqual(before)
      expect(session.lastSeq).toBe(seq)
      await session.close()
      await host.close()
      const reopenedHost = (await createTestHost(options)).host
      try {
        const reopened = await reopenedHost.createSession({ key, cwd: dataDir })
        expect(reopened.preset).toMatchObject({ name: 'standard', permission })
        expect(reopened.permissionContext.policy).toBe(permission)
      } finally {
        await reopenedHost.close()
      }
    },
  )
})

describe('sessionSelection', () => {
  const profile = { presets: { default: 'standard', allowed: [] } } as unknown as ResolvedProfile
  it('lets a child inherit both from its parent', () => {
    expect(
      sessionSelection(profile, { parent: { name: 'ptc', permission: 'read-only' }, preset: 'minimal' }),
    ).toEqual({ name: 'ptc', permission: 'read-only' })
  })
  it('uses the deployment default for an omitted permission whether or not a recipe is named', () => {
    expect(sessionSelection(profile, { preset: 'ptc', defaultPermission: 'read-only' })).toEqual({
      name: 'ptc',
      fallback: 'read-only',
    })
    expect(sessionSelection(profile, {})).toEqual({ name: 'standard', fallback: 'workspace-write' })
    expect(sessionSelection(profile, { preset: 'default', permission: 'default' })).toEqual({
      name: 'default',
      fallback: 'workspace-write',
    })
  })
  it.each(['read-only', 'workspace-write', 'full-access'])('refuses a retired default recipe %s', (name) => {
    const old = { presets: { default: name, allowed: [name] } } as unknown as ResolvedProfile
    expect(() => sessionSelection(old, {})).toThrow(/Retired.*clean home/)
  })
  it('turns the follow-default marker into the deployment default and refuses unknown levels', () => {
    expect(
      sessionSelection(profile, { preset: 'ptc', permission: 'default', defaultPermission: 'read-only' }),
    ).toEqual({ name: 'ptc', fallback: 'read-only' })
    expect(() => sessionSelection(profile, { preset: 'ptc', permission: 'root' })).toThrow(
      'unknown permission',
    )
  })
})

it('a live full-access choice governs a fixed application recipe and restores its chooser on reopen', async () => {
  const { host, dataDir, options } = await open()
  const session = await host.createSession({ cwd: dataDir, preset: 'app-role' })
  const key = session.key
  const preset = structuredClone(session.preset)
  const chooser = { ...session.d.actor, id: 'full-access-chooser' }
  try {
    expect(session.permissionContext.policy).toBe('')
    await session.setYolo(true, chooser)
    expect(session.preset).toEqual(preset)
    const port = session.decisions.port({
      owner: 'fixture/app',
      sourcePackage: '@fixture/app',
      packageVersion: '1',
      operationId: 'sign',
      alive() {},
    })
    const handle = await port.request({
      key: 'signature',
      purpose: 'business.confirm',
      subject: { revision: 0 },
      prompt: 'Sign?',
      options: ['allowed-once', 'rejected'],
      presentation: { en: { title: 'Sign', fields: [], responseValue: 'I confirm.' } },
      responseSchema: { type: 'string', enum: ['I confirm.'] },
    })
    expect((await port.get(handle)).result).toMatchObject({
      code: 'full-access',
      answeredBy: { id: chooser.id, attrs: { confirmationMode: 'auto-confirmed under full access' } },
      response: { value: 'I confirm.' },
    })
    const admission = await port.admit!(handle)
    await admission.verify()
  } finally {
    await session.close()
    await host.close()
  }
  const next = (await createTestHost(options)).host
  try {
    const reopened = await next.createSession({ key, cwd: dataDir })
    expect(reopened.permissionContext).toMatchObject({ policy: 'full-access', actor: chooser })
    await reopened.setYolo(false, chooser)
    expect(reopened.permissionContext.policy).not.toBe('full-access')
    await reopened.close()
  } finally {
    await next.close()
  }
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteTransport } from '@agnes/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAdapters } from '../../src/adapters/index.js'
import { createJitiPackageLoader, type PackageModule, readNamedExports } from '../../src/assemble/packages.js'
import { createLoader } from '../../src/ext-host/loader.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import { WorkspaceBindingAuthority } from '../../src/workspace-authority.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const env = {
  platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
  agnesVersion: '1',
  now: '2026-09-17',
}
const vendor = '@acme/vendor'
const config = { rootTemplate: '/remote/sessions/{session}', keepOnClose: false }
const transport = () => {
  let alive = true
  return {
    alive: () => alive,
    close: vi.fn(async () => {
      alive = false
    }),
    exec: vi.fn<RemoteTransport['exec']>(async () => ({ code: 0, stdout: '', stderr: '', truncated: false })),
    upload: vi.fn<RemoteTransport['upload']>(async () => {}),
    download: vi.fn<RemoteTransport['download']>(async () => []),
  }
}
const setup = async (over: { config?: typeof config; vault?: boolean } = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'b1-open-'))
  dirs.push(dataDir)
  const p = await resolveProfile(
    {
      builtin: 'local-dev',
      builtinPackages: ['@agnes/base', '@agnes/code', '@agnes/ai', vendor],
      user: {
        name: 'p',
        seams: { sandbox: vendor },
        packages: [{ id: vendor, source: 'test', config: over.config ?? config }],
        adapters: { secrets: { kind: over.vault ? 'vault' : 'env' } },
      },
    },
    env,
  )
  return { p, opts: { dataDir, workspaceRoot: dataDir } }
}
const modules = (openTransport: NonNullable<PackageModule['openTransport']>) =>
  new Map([[vendor, { id: vendor, openTransport }]])
const binding = (sessionKey = 'session-a') =>
  new WorkspaceBindingAuthority().accept(
    { version: 1, sessionKey, workspaceId: 'a'.repeat(64), revision: 1, canonicalRoot: '/source' },
    sessionKey,
  )

describe('B1 generic transport opening', () => {
  it('validates a bare function export', () => {
    expect(() => readNamedExports(vendor, 'test', { openTransport: {} })).toThrow(/openTransport/)
  })
  it('rejects a malformed export through the real jiti package loader', async () => {
    const { opts } = await setup()
    writeFileSync(join(opts.dataDir, 'package.json'), JSON.stringify({ name: vendor, main: './index.ts' }))
    writeFileSync(join(opts.dataDir, 'index.ts'), 'export const openTransport = {}')
    await expect(
      createJitiPackageLoader(
        createLoader({ cacheDir: opts.dataDir, hostRoot: process.cwd(), agnesVersion: '1' }),
      ).importPackage(vendor, opts.dataDir),
    ).rejects.toMatchObject({ code: 'E_EXT_LOAD' })
  })
  it('passes config, callable secrets and the caller signal to the selected package', async () => {
    const { p, opts } = await setup()
    const t = transport()
    const ac = new AbortController()
    const open = vi.fn(async (c, ctx) => {
      expect(c).toEqual(config)
      expect(typeof ctx.secret).toBe('function')
      expect(ctx.signal).toBe(ac.signal)
      expect(ctx.secret('secret://b1/token')).toBe('test-value')
      return t
    })
    process.env.AGNES_SECRET_B1_TOKEN = 'test-value'
    try {
      const b = await openAdapters(p, { ...opts, modules: modules(open), signal: ac.signal })
      expect(open).toHaveBeenCalledOnce()
      expect(b.transport).toBe(t)
      await b.close()
      expect(t.close).toHaveBeenCalledOnce()
    } finally {
      delete process.env.AGNES_SECRET_B1_TOKEN
    }
  })
  it('refuses vault before calling the package', async () => {
    const { p, opts } = await setup({ vault: true })
    const open = vi.fn(async () => transport())
    await expect(openAdapters(p, { ...opts, modules: modules(open) })).rejects.toMatchObject({
      code: 'E_SEAM_INIT',
    })
    expect(open).not.toHaveBeenCalled()
  })
  it('closes a malformed returned transport and refuses it', async () => {
    const { p, opts } = await setup()
    const close = vi.fn(async () => {})
    await expect(
      openAdapters(p, { ...opts, modules: modules(async () => ({ close }) as unknown as RemoteTransport) }),
    ).rejects.toMatchObject({ code: 'E_SEAM_INIT' })
    expect(close).toHaveBeenCalledOnce()
  })
  it('closes the channel after workspace creation failure', async () => {
    const { p, opts } = await setup()
    const t = transport()
    t.exec.mockRejectedValue(new Error('mkdir failed'))
    const b = await openAdapters(p, { ...opts, modules: modules(async () => t) })
    await expect(b.openWorkspace(binding())).rejects.toThrow('mkdir failed')
    await b.close()
    expect(t.close).toHaveBeenCalledOnce()
  })
  it('still closes remote resources when storage close fails', async () => {
    const { p, opts } = await setup()
    const t = transport()
    const b = await openAdapters(p, { ...opts, modules: modules(async () => t) })
    const closeStorage = b.storage.close.bind(b.storage)
    vi.spyOn(b.storage, 'close').mockRejectedValueOnce(new Error('storage failed'))
    try {
      await expect(b.close()).rejects.toThrow('storage failed')
      expect(t.close).toHaveBeenCalledOnce()
    } finally {
      await closeStorage()
    }
  })
  it.each([
    'relative/{session}',
    '/',
    '/fixed',
    '/a/../{session}',
    '/a/{session}/{session}',
    '/a/\0{session}',
  ])('refuses unsafe workspace template %s before opening', async (rootTemplate) => {
    const { p, opts } = await setup({ config: { ...config, rootTemplate } })
    const open = vi.fn(async () => transport())
    await expect(openAdapters(p, { ...opts, modules: modules(open) })).rejects.toMatchObject({
      code: 'E_SEAM_INIT',
    })
    expect(open).not.toHaveBeenCalled()
  })
  it('closes a channel returned after cancellation without creating a workspace', async () => {
    const { p, opts } = await setup()
    const t = transport()
    const ac = new AbortController()
    await expect(
      openAdapters(p, {
        ...opts,
        signal: ac.signal,
        modules: modules(async () => {
          ac.abort()
          return t
        }),
      }),
    ).rejects.toThrow()
    expect(t.exec).not.toHaveBeenCalled()
    expect(t.close).toHaveBeenCalledOnce()
  })
  it('defers remote workspace creation until a session binding opens', async () => {
    const { p, opts } = await setup()
    const t = transport()
    const ac = new AbortController()
    const b = await openAdapters(p, { ...opts, signal: ac.signal, modules: modules(async () => t) })
    expect(t.exec).not.toHaveBeenCalled()
    await b.close()
    expect(t.close).toHaveBeenCalledOnce()
  })
  it('creates and removes a workspace only for the owning session handle', async () => {
    const { p, opts } = await setup()
    const t = transport()
    const b = await openAdapters(p, { ...opts, modules: modules(async () => t) })
    const workspace = await b.openWorkspace(binding())
    await workspace.close()
    await b.close()
    expect(t.exec.mock.calls.map(([cmd]) => cmd[0])).toEqual(['mkdir', 'rm'])
    expect(t.exec.mock.calls[0]?.[1].signal).toBeUndefined()
    expect(t.exec.mock.calls[1]?.[1].signal).toBeUndefined()
    expect(t.close).toHaveBeenCalledOnce()
  })
  it('honors keepOnClose without leaving the channel alive', async () => {
    const { p, opts } = await setup({ config: { ...config, keepOnClose: true } })
    const t = transport()
    const b = await openAdapters(p, { ...opts, modules: modules(async () => t) })
    const workspace = await b.openWorkspace(binding())
    await workspace.close()
    await b.close()
    expect(t.exec.mock.calls.map(([cmd]) => cmd[0])).toEqual(['mkdir'])
    expect(t.close).toHaveBeenCalledOnce()
  })
  it('still closes the channel if removing the workspace fails', async () => {
    const { p, opts } = await setup()
    const t = transport()
    const b = await openAdapters(p, { ...opts, modules: modules(async () => t) })
    const workspace = await b.openWorkspace(binding())
    t.exec.mockRejectedValue(new Error('remove failed'))
    await expect(workspace.close()).rejects.toThrow('E_REMOTE_WORKSPACE: remove failed')
    await b.close()
    expect(t.close).toHaveBeenCalledOnce()
  })
  it('refuses already aborted opens before contacting the vendor', async () => {
    const { p, opts } = await setup()
    const open = vi.fn(async () => transport())
    await expect(
      openAdapters(p, { ...opts, modules: modules(open), signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
})

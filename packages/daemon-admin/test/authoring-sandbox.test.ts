import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { BWRAP_BACKEND, detectBackend, NONE_BACKEND, SEATBELT_BACKEND } from '@agnes/base/sandbox'
import { createPlatform } from '@agnes/host'
import { runIsolatedCommand } from '@agnes/package-isolation'
import { AGH_DIR } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { authoringSandbox } from '../src/packages/authoring-sandbox.js'

vi.mock('@agnes/base/sandbox', async (original) => ({
  ...(await original<typeof import('@agnes/base/sandbox')>()),
  detectBackend: vi.fn(),
}))
vi.mock('@agnes/host', async (original) => {
  const host = await original<typeof import('@agnes/host')>()
  const { sep } = await import('node:path')
  return {
    ...host,
    // The simulated OS changes the backend, not the real temp paths: compile them in this
    // machine's own path flavor (a Windows temp path is not an absolute POSIX path).
    compileWorkspacePolicy: (input: Parameters<typeof host.compileWorkspacePolicy>[0]) =>
      host.compileWorkspacePolicy({
        ...input,
        semantics: { flavor: sep === '\\' ? 'win32' : 'posix', caseSensitive: true },
      }),
    createPlatform: vi.fn(),
    createFs: () => ({ canonicalize: async (path: string) => resolve(path) }),
    createExec: () => ({ run: vi.fn() }),
    // Keep the simulated Linux read view inside this test's filesystem, not the host's '/'.
    sandboxReadPaths: (denyPaths: readonly string[]) => {
      const root = roots[0]
      if (!root) throw new Error('Sandbox read fixture was not initialized')
      return host.sandboxReadPaths(denyPaths, root)
    },
    prepareSandboxWorkspaceAncestor: async (root: string) => {
      mkdirSync(join(root, AGH_DIR), { recursive: true })
    },
  }
})
vi.mock('@agnes/package-isolation', () => ({
  runIsolatedCommand: vi.fn(async () => ({ stdout: 'bounded output' })),
}))
const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const setup = (os: 'darwin' | 'linux' | 'win32') => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-author-policy-')))
  roots.push(root)
  for (const name of ['public', 'private', '.git']) mkdirSync(join(root, name))
  vi.mocked(createPlatform).mockReturnValue({
    os,
    fs: () => ({ caseSensitive: true }),
    shell: () => (os === 'win32' ? 'powershell' : 'posix'),
  } as never)
  return root
}
// Seatbelt and bwrap compile host-canonical POSIX paths and only run on POSIX hosts; a Windows
// temp directory cannot be expressed in their profiles, so these simulations need a POSIX host.
const posixHost = sep === '/'
it.runIf(posixHost).each(['darwin', 'linux'] as const)(
  'confines %s candidate execution with Host hard denies and session network rules',
  async (os) => {
    const root = setup(os),
      home = join(root, 'private'),
      protectedPath = join(root, '.git')
    vi.mocked(detectBackend).mockResolvedValue(os === 'darwin' ? SEATBELT_BACKEND : BWRAP_BACKEND)
    for (const network of ['deny', 'allow'] as const) {
      const signal = new AbortController().signal
      const result = await authoringSandbox(
        {
          home,
          session: {
            local: true,
            network,
            policy: {
              workspaceRoot: root,
              rules: [{ path: protectedPath, effect: 'deny', hard: true, source: 'host-integrity' }],
              digest: 'a'.repeat(64),
              networkAllow: [],
            },
          },
        },
        root,
        signal,
      )
      expect(result.isolated).toBe(true)
      if (os === 'linux') expect(existsSync(join(root, AGH_DIR))).toBe(true)
      await result.sandbox.exec(['node', 'test.mjs'], {
        cwd: root,
        env: { HOME: root },
        timeoutMs: 45,
        maxOutputBytes: 256,
        signal,
      })
      const call = vi.mocked(runIsolatedCommand).mock.calls.at(-1)
      if (!call) throw new Error('Candidate command did not reach execution')
      const [command, args, options] = call
      expect(command).toBe(os === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap')
      expect(args.join(' ')).toContain(home)
      expect(args.join(' ')).toContain(protectedPath)
      expect(options).toMatchObject({
        cwd: root,
        env: { HOME: root },
        timeoutMs: 45,
        maxOutputBytes: 256,
        signal,
      })
      if (os === 'darwin') {
        expect(args.join(' ')).toContain(`(${network} network*)`)
        expect(args.join(' ')).toContain(`(deny file-read* file-write* (subpath "${home}"))`)
      } else {
        expect(args.includes('--unshare-net')).toBe(network === 'deny')
        const probe = vi.mocked(detectBackend).mock.calls.at(-1)?.[0]
        const readPaths = probe?.options.readPaths
        expect(readPaths).toContain(join(root, 'public'))
        expect(readPaths?.every((path) => path.startsWith(`${root}${sep}`))).toBe(true)
        expect(readPaths?.some((path) => path === home || path.startsWith(`${home}${sep}`))).toBe(false)
        expect(
          readPaths?.some((path) => path === protectedPath || path.startsWith(`${protectedPath}${sep}`)),
        ).toBe(false)
      }
    }
  },
)
it('reports Windows as unisolated and refuses missing POSIX isolation or a remote session', async () => {
  const root = setup('win32')
  vi.mocked(detectBackend).mockResolvedValue(NONE_BACKEND)
  const result = await authoringSandbox({ home: join(root, 'private') }, root, new AbortController().signal)
  expect(result.isolated).toBe(false)
  // The Linux simulation uses POSIX fixture paths; Windows paths cannot be expressed by bwrap.
  for (const os of posixHost ? (['darwin', 'linux'] as const) : (['darwin'] as const)) {
    setup(os)
    await expect(
      authoringSandbox({ home: join(root, 'private') }, root, new AbortController().signal),
    ).rejects.toThrow('SANDBOX_UNAVAILABLE')
  }
  await expect(
    authoringSandbox({ home: root, session: { local: false } as never }, root, new AbortController().signal),
  ).rejects.toThrow('local sandbox')
  expect(runIsolatedCommand).not.toHaveBeenCalled()
})

it('rechecks the candidate test lease after sandbox setup before spawning the command', async () => {
  // The lease check precedes the spawn on every backend; use one this host can compile.
  const root = setup(posixHost ? 'darwin' : 'win32')
  vi.mocked(detectBackend).mockResolvedValue(posixHost ? SEATBELT_BACKEND : NONE_BACKEND)
  let live = true
  const assertActive = () => {
    if (!live) throw Error('permission unavailable')
  }
  const result = await authoringSandbox(
    { home: join(root, 'private'), admission: { verify: async () => assertActive(), assertActive } },
    root,
    new AbortController().signal,
  )
  live = false
  await expect(
    result.sandbox.exec(['node', 'test.mjs'], { cwd: root, signal: new AbortController().signal }),
  ).rejects.toThrow('permission unavailable')
  expect(runIsolatedCommand).not.toHaveBeenCalled()
})

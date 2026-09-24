import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost, resolveProfile } from '@agnes/host'
import { expect, it, vi } from 'vitest'
import { resolveLaunchResources } from '../launch/resources.js'
import { assembleLocalHost } from '../src/boot/local.js'
import { TEST_LOCK, testDeps } from './boot-host.js'

vi.mock('@agnes/host', async (original) => ({
  ...(await original<typeof import('@agnes/host')>()),
  createHost: vi.fn(async () => {
    throw new Error('assembly reached')
  }),
}))
vi.mock('../launch/resources.js', () => ({ resolveLaunchResources: vi.fn() }))

it.each([false, true])('passes the packaged Node runtime only for SEA=%s', async (seaMode) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-local-runtime-'))
  const sea = vi.spyOn(process.getBuiltinModule('node:sea'), 'isSea').mockReturnValue(seaMode)
  try {
    const runtimeNode = join(root, 'runtime', 'node.exe')
    vi.mocked(resolveLaunchResources).mockReturnValue({
      mode: 'sea',
      root,
      runtimeNode,
      daemonEntry: join(root, 'daemon.mjs'),
      workerEntry: join(root, 'worker.mjs'),
      webRoot: join(root, 'web'),
    })
    const profile = await resolveProfile(
      { builtin: 'local-dev', lock: TEST_LOCK },
      {
        platform: { os: 'win32', arch: 'x64', capabilities: {} },
        agnesVersion: '0.0.0',
        now: '2026-09-14T00:00:00Z',
      },
    )
    const { createHostImpl: _drop, ...deps } = testDeps(root)
    await expect(
      assembleLocalHost(
        profile,
        'local-dev',
        root,
        {
          ...deps,
          loader: {
            importPackage: async () => {
              throw new Error('unused loader')
            },
          },
        },
        {
          ask: async () => {
            throw new Error('unused prompter')
          },
        },
      ),
    ).rejects.toThrow('assembly reached')
    const options = vi.mocked(createHost).mock.calls.at(-1)?.[1]
    expect(options?.windowsNodeExecutable).toBe(seaMode ? runtimeNode : undefined)
    expect(resolveLaunchResources).toHaveBeenCalledTimes(seaMode ? 1 : 0)
  } finally {
    sea.mockRestore()
    vi.clearAllMocks()
    rmSync(root, { recursive: true, force: true })
  }
})

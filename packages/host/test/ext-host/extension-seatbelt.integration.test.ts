import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PlatformFacts } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { resolveExtensionRunnerRuntime } from '../../src/ext-host/extension-runner-runtime.js'
import { seatbeltExtensionRunnerArgv } from '../../src/ext-host/extension-seatbelt.js'
import {
  connectIsolatedHooksRunner,
  type HooksRunnerBootstrap,
} from '../../src/ext-host/hooks-isolation-client.js'

const exec = promisify(execFile)
const seatbelt = it.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))
const packagedSeatbelt = it.runIf(
  process.platform === 'darwin' &&
    existsSync('/usr/bin/sandbox-exec') &&
    Boolean(process.env.AGNES_TEST_BUNDLED_NODE_ROOT) &&
    Boolean(process.env.AGNES_TEST_RUNNER_ARTIFACT),
)
const readable = ['/bin', '/dev', '/private', '/System', '/usr']
const platform: PlatformFacts = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
})

seatbelt('denies runner writes and descendant processes at the real OS boundary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-ext-seatbelt-'))
  const output = join(directory, 'forbidden')
  const argv = seatbeltExtensionRunnerArgv(
    ['/bin/sh', '-c', 'printf bad > "$1"; /bin/echo child', 'probe', output],
    readable,
  )
  try {
    await expect(exec(argv[0] as string, argv.slice(1))).rejects.toBeDefined()
    expect(existsSync(output)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

seatbelt('allows Node to inspect only the root entry without opening an unlisted file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-ext-seatbelt-read-'))
  const forbidden = join(directory, 'credential')
  try {
    writeFileSync(forbidden, 'secret')
    const argv = seatbeltExtensionRunnerArgv(
      ['/bin/sh', '-c', 'ls /; cat "$1"', 'probe', forbidden],
      ['/bin', '/dev', '/usr'],
    )
    await expect(exec(argv[0] as string, argv.slice(1))).rejects.toBeDefined()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

seatbelt('denies a direct network request while an unconfined control reaches loopback', async () => {
  const source = readFileSync(new URL('./fixtures/seatbelt-network-probe.js', import.meta.url), 'utf8')
  const server = createServer((_request, response) => response.end('reachable'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing loopback address')
  try {
    const args = ['-e', source, String(address.port)]
    const control = await exec(process.execPath, args, { env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(control.stdout).toBe('reachable')
    const argv = seatbeltExtensionRunnerArgv([process.execPath, ...args], [...readable, '/Applications'])
    await expect(
      exec(argv[0] as string, argv.slice(1), { env: { ELECTRON_RUN_AS_NODE: '1' } }),
    ).rejects.toBeDefined()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

packagedSeatbelt('runs hello, invoke, and close with the packaged Node and exact read roots', async () => {
  const nodeRoot = process.env.AGNES_TEST_BUNDLED_NODE_ROOT as string
  const artifactDirectory = process.env.AGNES_TEST_RUNNER_ARTIFACT as string
  const runtime = resolveExtensionRunnerRuntime({
    artifactDirectory,
    bundledNode: { executable: join(nodeRoot, 'bin', 'node'), readRoots: [nodeRoot] },
    hostNode: false,
  })
  const nonce = randomUUID()
  const packageDigest = 'package-sha256'
  const manifestDigest = 'manifest-sha256'
  const argv = seatbeltExtensionRunnerArgv(
    [runtime.executable, runtime.runner],
    [...runtime.readPaths, '/System', '/usr', '/dev', '/private/var/db/timezone', '/Library/Preferences'],
  )
  const child = spawn(argv[0] as string, argv.slice(1), {
    env: {
      AGNES_ISOLATION_NONCE: nonce,
      AGNES_PACKAGE_DIGEST: packageDigest,
      AGNES_MANIFEST_DIGEST: manifestDigest,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const bootstrap: HooksRunnerBootstrap = {
    nonce,
    packageDigest,
    manifestDigest,
    extensionId: 'agnes/hooks-runner',
    data: {
      groups: [{ event: 'Serial', hooks: [{ type: 'command', command: 'probe' }] }],
      map: { version: 'probe-1', events: { Serial: { to: ['before_step'] } } },
      profile: {
        name: 'test',
        resolvedProfileHash: null,
        dataDir: '/denied/data',
        workspaceRoot: '/denied/workspace',
        homeDir: '/denied/home',
        limits: {},
        preset: { surface: 'cli', locale: 'zh-CN', sandbox: { network_allow: [] } },
      },
      lease: {
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: { events: true },
        budget: { remaining: 100 },
      },
      platform,
    },
  }
  const runner = await connectIsolatedHooksRunner(child, bootstrap, async (method) => {
    expect(method).toBe('exec')
    return { code: 0, stdout: '{}', stderr: '', truncated: false }
  })
  expect(runner.events).toEqual(['before_step'])
  await expect(
    runner.invoke(
      'before_step',
      { turn: 1, step: 1, budget: { remaining: 10, cap: 20 }, depth: 0 },
      {
        session: {
          key: 'seatbelt-probe',
          lane: 'main',
          workspaceRoot: '/workspace',
          turn: 1,
          step: 1,
        },
        lease: bootstrap.data.lease as never,
        replayed: false,
        platform,
        signal: new AbortController().signal,
      },
    ),
  ).resolves.toEqual({})
  await runner.close()
})

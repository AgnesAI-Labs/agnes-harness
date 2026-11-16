import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import { startDaemon, stopAllDaemons } from './daemon-harness.js'
import { startGitHttpRemote } from './git-http-remote.js'
import { AGENT_CREDENTIAL, makeHomes, OPERATOR_CREDENTIAL } from './homes.js'
import { isAlive, startedPids } from './process-tree.js'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterAll(stopAllDaemons)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A plugin that only proves it was installed, trusted and enabled: it records its own start in a file.
function writePlugin(directory: string, marker: string) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@acme/fixture-probe',
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        provides: ['bundle'],
        plugins: [
          {
            id: 'ext:acme/fixture-probe/main',
            export: 'main',
            apiRange: '^5.0.0',
            runtime: 'in-process',
            inject: [],
            capabilities: {},
          },
        ],
        bundles: {
          probe: {
            presets: { probe: { name: 'probe', extends: 'standard', surfaces: ['daemon', 'sdk'] } },
            launch: { title: { en: 'Probe' }, description: { en: 'Fixture probe.' }, preset: 'probe' },
          },
        },
      },
    }),
  )
  writeFileSync(
    join(directory, 'index.mjs'),
    `import { appendFileSync } from 'node:fs'\nexport const main = { apply() { appendFileSync(${JSON.stringify(marker)}, 'applied HOME=' + process.env.HOME + '\\n') } }\n`,
  )
}

// Not on Windows: the probe plugin's tool runs `sh -c` in the session shell, which is PowerShell there; the identity
// end-to-end test covers a Windows session's environment.
it.skipIf(process.platform === 'win32')(
  'starts a daemon whose session shell sees exactly the given HOME and PATH, with the agent identity, across a restart',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-daemon-fixture-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const homes = makeHomes(join(root, 'homes'))
    const remote = await startGitHttpRemote({
      users: {
        [AGENT_CREDENTIAL.user]: AGENT_CREDENTIAL.password,
        [OPERATOR_CREDENTIAL.user]: OPERATOR_CREDENTIAL.password,
      },
    })
    cleanups.push(() => remote.close())
    homes.trustRemote(remote.url)
    const marker = join(root, 'plugin-marker.log')
    const plugin = join(root, 'plugin')
    writePlugin(plugin, marker)
    const workspace = join(root, 'ticket')
    mkdirSync(workspace)
    const path = `${homes.shimsDir}:${homes.operatorBin}:${process.env.PATH}`

    const daemon = await startDaemon({
      // A home path too long for a unix socket makes the daemon bind under /tmp, which `stop()` must clean up.
      aghHome: join(root, 'x'.repeat(60), 'agh'),
      home: homes.agentHome,
      path,
      plugins: [plugin],
      // Registered before the start, so a test timeout during a slow start still stops the daemon.
      onHandle: (handle) => cleanups.push(() => handle.stop()),
    })

    const probe = (n: number) =>
      daemon.shell(
        `echo HOME=$HOME; echo PATH=$PATH; echo gh=$(gh); git config user.name; echo n=${n}`,
        workspace,
      )
    const first = await probe(1)
    expect(first).toContain(`HOME=${homes.agentHome}`)
    expect(first).toContain(`PATH=${path}`)
    expect(first, 'the agent shim shadows the operator gh').toContain('gh=AGENT-GH')
    expect(first).toContain('AGENT')

    // The session shell can reach the authenticated remote with the agent's credentials only.
    const pushed = await daemon.shell(
      `git clone -q ${remote.url} repo && cd repo && git checkout -q -b agent/e2e && echo x > x.txt && git add x.txt && git commit -q -m x && git log -1 --format='author=%an' && git push origin agent/e2e 2>&1; echo exit=$?`,
      workspace,
    )
    expect(pushed).toContain('author=AGENT')
    expect(pushed).toContain('exit=0')
    expect(await remote.refs()).toContain('refs/heads/agent/e2e')
    expect(remote.authLog().some((line) => line.startsWith(OPERATOR_CREDENTIAL.user))).toBe(false)
    expect(homes.markers().some((entry) => entry.startsWith('OPERATOR'))).toBe(false)

    expect(readFileSync(marker, 'utf8'), 'the plugin was enabled and ran in the daemon').toContain(
      `HOME=${homes.agentHome}`,
    )

    await daemon.restart()
    const second = await probe(2)
    expect(second).toContain(`HOME=${homes.agentHome}`)
    expect(second).toContain(`PATH=${path}`)

    const socketDir = daemon.socketDir
    expect(socketDir, 'the long home path moved the socket to a /tmp directory').toBeDefined()
    await daemon.stop()
    expect(existsSync(socketDir as string), 'the /tmp socket directory is removed').toBe(false)
  },
  240_000,
)

// Startup failures must leave no process behind: every pid the failed start created is dead afterwards.
const claim = () => {
  const before = new Set(startedPids())
  return () => startedPids().filter((pid) => !before.has(pid))
}
function scratchRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-daemon-fixture-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
const options = (root: string) => ({
  aghHome: join(root, 'agh'),
  home: root,
  path: process.env.PATH ?? '',
  plugins: [],
})

// Not on Windows: it counts the start's processes from the process table `ps` prints, which Windows does not have.
it.skipIf(process.platform === 'win32')(
  'caps the whole start, rejects with a clear error and kills every process the start created',
  async () => {
    const mine = claim()
    const root = scratchRoot()
    // The home initializer alone takes over a second and a boot several more, so 2.5 s ends the start mid-way.
    await expect(startDaemon({ ...options(root), startTimeoutMs: 2_500 })).rejects.toThrow(
      /daemon startup exceeded 2500 ms and was stopped/,
    )
    expect(mine().length, 'the start spawned something').toBeGreaterThan(0)
    expect(mine().filter(isAlive), 'no process of the failed start is left').toEqual([])
  },
  60_000,
)

// Not on Windows: it counts the start's processes from the process table `ps` prints, which Windows does not have.
it.skipIf(process.platform === 'win32')(
  'lets the caller stop a start that is still running, before it returns',
  async () => {
    const mine = claim()
    const root = scratchRoot()
    let stop: (() => Promise<void>) | undefined
    const starting = startDaemon({ ...options(root), onHandle: (handle) => (stop = () => handle.stop()) })
    const rejected = expect(starting).rejects.toThrow(/stopped/)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(stop, 'the handle exists before the start finishes').toBeDefined()
    await stop?.()
    await rejected
    expect(mine().length).toBeGreaterThan(0)
    expect(mine().filter(isAlive)).toEqual([])
  },
  60_000,
)

// Not on Windows: it counts the processes left from the process table `ps` prints, which Windows does not have.
it.skipIf(process.platform === 'win32')(
  'a restart that fails leaves neither the old nor a new daemon running',
  async () => {
    const mine = claim()
    const root = scratchRoot()
    const daemon = await startDaemon({
      ...options(root),
      onHandle: (handle) => cleanups.push(() => handle.stop()),
    })
    // A profile the daemon cannot start from: the second boot exits.
    writeFileSync(join(root, 'agh', 'profiles', 'local-dev', 'profile.yaml'), '{ not a profile')
    await expect(daemon.restart()).rejects.toThrow(/daemon exited|boot timed out/)
    expect(() => daemon.client, 'no client is left').toThrow(/not running/)
    expect(mine().filter(isAlive)).toEqual([])
    await daemon.stop()
  },
  120_000,
)

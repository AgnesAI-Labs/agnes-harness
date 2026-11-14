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
import { afterEach, expect, it } from 'vitest'
import { startDaemon } from './daemon-harness.js'
import { startGitHttpRemote } from './git-http-remote.js'
import { AGENT_CREDENTIAL, makeHomes, OPERATOR_CREDENTIAL } from './homes.js'

const cleanups: (() => Promise<unknown> | unknown)[] = []
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
    })
    let stopped = false
    cleanups.push(async () => {
      if (!stopped) await daemon.stop()
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
    stopped = true
    expect(existsSync(socketDir as string), 'the /tmp socket directory is removed').toBe(false)
  },
  240_000,
)

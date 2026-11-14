import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import { verifyEnvironment } from '../../src/runtime/environment.js'
import { startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { startGitHttpRemote } from '../fixtures/git-http-remote.js'
import { AGENT_CREDENTIAL, OPERATOR_CREDENTIAL } from '../fixtures/homes.js'
import { AGENT_EMAIL, AGENT_LOGIN, prepareAgentEnvironment } from './agent-environment.js'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterAll(stopAllDaemons)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// The operator's home has its own git identity, credential helper and `gh`; the daemon starts with the agent home and
// the shims first on PATH, which `writeEnvironment` wrote. A session's commits, pushes and `gh` are the agent's only.
it.skipIf(process.platform === 'win32')(
  'commits, pushes and runs gh as the agent, never with the operator identity, credentials or gh',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-identity-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const remote = await startGitHttpRemote({
      users: {
        [AGENT_CREDENTIAL.user]: AGENT_CREDENTIAL.password,
        [OPERATOR_CREDENTIAL.user]: OPERATOR_CREDENTIAL.password,
      },
    })
    cleanups.push(() => remote.close())
    const env = await prepareAgentEnvironment(root, remote.url)

    // The self-check passes in the environment the daemon is given.
    await verifyEnvironment(
      env.agentHome,
      env.shims,
      { login: AGENT_LOGIN },
      { HOME: env.agentHome, PATH: env.path },
    )

    const daemon = await startDaemon({
      aghHome: join(root, 'agh'),
      home: env.agentHome,
      path: env.path,
      plugins: [],
      onHandle: (handle) => cleanups.push(() => handle.stop()),
    })
    const ticket = join(root, 'exec', 'T-1')
    mkdirSync(ticket, { recursive: true })
    const out = await daemon.shell(
      [
        'echo gh=$(command -v gh)',
        'echo banner=$(gh)',
        `git clone -q ${remote.url} repo`,
        'cd repo',
        'git checkout -q -b agent/T-1',
        'echo x > x.txt && git add x.txt && git commit -q -m x',
        "git log -1 --format='author=%an <%ae> committer=%cn <%ce>'",
        'git push origin agent/T-1 2>&1; echo exit=$?',
      ].join('\n'),
      ticket,
    )
    expect(out).toContain(`gh=${join(env.shims, 'gh')}`)
    expect(out, 'the shim runs the agent gh, not the operator one').toContain('banner=AGENT-GH')
    expect(out).toContain(`author=${AGENT_LOGIN} <${AGENT_EMAIL}> committer=${AGENT_LOGIN} <${AGENT_EMAIL}>`)
    expect(out).toContain('exit=0')
    expect(await remote.refs()).toContain('refs/heads/agent/T-1')

    // The remote saw the agent's credential only; the operator's helper never ran.
    const users = remote.authLog().filter((line) => !line.startsWith('401'))
    expect(users.length).toBeGreaterThan(0)
    expect(users.every((line) => line.startsWith(`${AGENT_CREDENTIAL.user} `))).toBe(true)
    expect(users.some((line) => /POST \S*git-receive-pack/.test(line))).toBe(true)
    expect(env.homes.markers(), 'the operator marker file stays empty').toEqual([])

    // The agent's real gh answered git's credential requests, with the agent's configuration directory.
    expect(env.ghCalls()).toContainEqual(['auth', 'git-credential', 'get'])
    expect(new Set(env.configDirs())).toEqual(new Set([env.config.ghConfigDir]))
    await daemon.stop()
  },
  240_000,
)

// The agent's identity set up as the deployment guide does it, on a real daemon started as usual: the operator's HOME,
// with its own git identity and credential helper, the operator's PATH and `gh`, and a GitHub token in the daemon's
// environment. The GitHub Source names a `gh-agent` wrapper with its own configuration directory. Superagent opens its
// worker session with the agent's environment: the worker's commits are the agent's, its push asks only the agent's
// CLI for a credential, and neither the operator's helper nor the token reaches it. The environment is kept with the
// session, so it holds across a daemon restart; a session the owner opens itself has none of it.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { DATABASE_FILE } from '../../src/runtime/index.js'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { ENV_PROBE_TOOL, INJECTED_TOKEN, writeEnvProbePlugin } from '../fixtures/env-probe-plugin.js'
import { startGitHttpRemote } from '../fixtures/git-http-remote.js'
import { AGENT_CREDENTIAL, makeHomes, OPERATOR_CREDENTIAL } from '../fixtures/homes.js'
import { AGENT_EMAIL, AGENT_LOGIN, trustRemote, writeGhAgent } from './agent-environment.js'
import { ownerCalls, seedTicket, tool, until } from './integration-fixtures.js'

afterAll(stopAllDaemons)

it.skipIf(process.platform === 'win32')(
  'a worker session commits and pushes as the agent through its CLI, never with the operator identity, helper or token',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-identity-')))
    let handle: DaemonHandle | undefined
    const remote = await startGitHttpRemote({
      users: {
        [AGENT_CREDENTIAL.user]: AGENT_CREDENTIAL.password,
        [OPERATOR_CREDENTIAL.user]: OPERATOR_CREDENTIAL.password,
      },
    })
    try {
      const homes = makeHomes(join(root, 'homes'))
      const agent = writeGhAgent(root)
      const stateDir = join(root, 'state')
      mkdirSync(stateDir)
      // Started as usual: no HOME or PATH of the agent's, and the operator's GitHub token exported.
      const daemon = await startDaemon({
        aghHome: join(root, 'agh'),
        home: homes.operatorHome,
        path: `${homes.operatorBin}:${process.env.PATH ?? ''}`,
        env: { GH_TOKEN: 'operator-token', GITHUB_TOKEN: 'operator-token' },
        plugins: ['./bundled-plugins/superagent', writeEnvProbePlugin(join(root, 'env-probe'))],
        onHandle: (started) => {
          handle = started
        },
      })
      const calls = ownerCalls(() => daemon.client)
      await calls.disable()
      await calls.configure({ stateDir })
      const ticketId = seedTicket(join(stateDir, DATABASE_FILE), stateDir, agent.cli)
      await calls.enable()
      const workerId = `superagent:worker:${ticketId}`
      await until('the worker session', () => calls.exists(workerId))
      // The test remote is not github.com: its credential context gets the agent helper too.
      trustRemote(stateDir, agent.cli, remote.url)
      const answered = (marker: string) =>
        until(`the tool result of ${marker}`, () =>
          daemon
            .modelRequests()
            .find((request) => request.lastRole === 'tool' && request.marker.includes(marker)),
        )
      const call = async (marker: string, name: string, args: unknown) => {
        const worker = await daemon.client.session.load(workerId, { history: 'none' })
        await until('the worker idle', async () => (await worker.projectUI()).opState === null)
        // The harness client after a restart starts its command ids again; name each command.
        await worker.followUp(tool(marker, name, args), { commandId: `identity-${marker}` })
        return ((await answered(marker)).toolResult ?? '').replace(/<\/?untrusted[^>]*>/g, '')
      }
      const run = (marker: string, command: string) => call(marker, 'shell', { command })
      const sees = [
        'echo gh=$(command -v gh)',
        'echo banner=$(gh)',
        'echo token=${GH_TOKEN-unset}/${GITHUB_TOKEN-unset}',
        'echo global=$GIT_CONFIG_GLOBAL',
      ]

      const out = await run(
        'id-push',
        [
          ...sees,
          `git clone -q ${remote.url} pushed`,
          'cd pushed',
          'git checkout -q -b agent/T-1',
          'echo x > x.txt && git add x.txt && git commit -q -m x',
          "git log -1 --format='author=%an <%ae> committer=%cn <%ce>'",
          'git push origin agent/T-1 2>&1; echo exit=$?',
        ].join('\n'),
      )
      expect(out).toContain(`gh=${join(stateDir, 'worker-bin', 'gh')}`)
      expect(out, 'the shim runs the agent CLI, not the operator gh').toContain('banner=AGENT-GH')
      expect(out, "the daemon's GitHub token does not reach the worker").toContain('token=unset/unset')
      expect(out).toContain(`global=${join(stateDir, 'worker-gitconfig')}`)
      expect(out).toContain(
        `author=${AGENT_LOGIN} <${AGENT_EMAIL}> committer=${AGENT_LOGIN} <${AGENT_EMAIL}>`,
      )
      expect(out).toContain('exit=0')
      expect(await remote.refs()).toContain('refs/heads/agent/T-1')
      // The remote saw the agent's credential only, which the agent CLI gave; the operator's helper never ran.
      const users = remote.authLog().filter((line) => !line.startsWith('401'))
      expect(users.some((line) => /POST \S*git-receive-pack/.test(line))).toBe(true)
      expect(users.every((line) => line.startsWith(`${AGENT_CREDENTIAL.user} `))).toBe(true)
      expect(homes.markers(), "the operator's credential helper never ran").toEqual([])
      expect(agent.ghCalls()).toContainEqual(['auth', 'git-credential', 'get'])
      expect(new Set(agent.runs()), 'the agent CLI ran with its own directory, without a token').toEqual(
        new Set([`${agent.configDir} token=unset`]),
      )

      // The environment is part of the session's records in the profile, so it holds across a daemon restart for
      // whoever opens the session; here the owner opens the worker session after the restart.
      const aghHome = join(root, 'agh')
      const records = () =>
        readdirSync(aghHome, { recursive: true, encoding: 'utf8' }).filter((path) =>
          /\.session-environment[\\/][0-9a-f]{64}\.json$/.test(path),
        )
      expect(records(), 'the worker session and the main session each have one').toHaveLength(2)
      // The worker's record removes the GitHub tokens a caller's environment might carry. No tool of the worker
      // session passes one (a plugin tool that would is not among its tools); in an owner session it does, below.
      const digest = createHash('sha256').update(workerId).digest('hex')
      const recordPath = records().find((path) => path.endsWith(`${digest}.json`)) ?? ''
      expect(JSON.parse(readFileSync(join(aghHome, recordPath), 'utf8'))).toMatchObject({
        sessionKey: workerId,
        environment: {
          pathPrepend: [join(stateDir, 'worker-bin')],
          unset: ['GH_TOKEN', 'GITHUB_TOKEN'],
        },
      })
      expect(await call('id-probe', ENV_PROBE_TOOL, {})).toContain(`unknown tool ${ENV_PROBE_TOOL}`)
      await daemon.restart()
      expect(records()).toHaveLength(2)
      // Until Superagent has reconciled the worker after the restart, its hook refuses the worker's tools.
      let attempt = 0
      const again = await until('the worker shell after the restart', async () => {
        const text = await run(`id-again-${++attempt}`, sees.join('\n'))
        return text.includes('gh=') ? text : undefined
      })
      expect(again).toContain(`gh=${join(stateDir, 'worker-bin', 'gh')}`)
      expect(again).toContain('token=unset/unset')
      expect(again).toContain(`global=${join(stateDir, 'worker-gitconfig')}`)
      // A session the owner opens itself has none of it.
      const own = join(root, 'own')
      mkdirSync(own)
      await daemon.client.workspace.add(own)
      const plain = await daemon.client.session.new({
        cwd: own,
        sessionKey: 'owner-plain',
        permission: 'full-access',
      })
      await plain.followUp(tool('id-plain', 'shell', { command: sees.join('\n') }), {
        commandId: 'identity-id-plain',
      })
      const plainOut = (await answered('id-plain')).toolResult ?? ''
      expect(plainOut).toContain(`gh=${join(homes.operatorBin, 'gh')}`)
      expect(plainOut).toContain('global=\n')
      // There a plugin tool's token reaches the command it runs.
      await until('the owner session idle', async () => (await plain.projectUI()).opState === null)
      await plain.followUp(tool('id-plain-probe', ENV_PROBE_TOOL, {}), {
        commandId: 'identity-id-plain-probe',
      })
      expect((await answered('id-plain-probe')).toolResult ?? '').toContain(`probe-token=${INJECTED_TOKEN}`)
    } finally {
      await handle?.stop()
      await remote.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  400_000,
)

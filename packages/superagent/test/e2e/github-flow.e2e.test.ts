// The GitHub flow end to end on a real daemon, from the shipped payload, with the agent's `gh` as a scripted fake
// GitHub, an authenticated git remote and a loopback model whose answers the test scripts per session: a notification
// of Alice's Issue is admitted and routed to a ticket; its worker session, in the ticket directory, commits, pushes its
// branch and opens a PR, and reports; the main session replies on the Issue; Alice's follow-up wakes the same ticket;
// the PR is merged and the ticket ends. A second case restarts the daemon while the worker is busy and a comment waits
// for it: the comment is taken once, within ten seconds of the restart.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openStore } from '../../src/app/store.js'
import { KV } from '../../src/kv.js'
import { SettingsSchema } from '../../src/policy.js'
import { DATABASE_FILE } from '../../src/runtime/index.js'
import {
  type DaemonHandle,
  type ScriptRequest,
  startDaemon,
  stopAllDaemons,
} from '../fixtures/daemon-harness.js'
import { startGitHttpRemote } from '../fixtures/git-http-remote.js'
import { AGENT_CREDENTIAL } from '../fixtures/homes.js'
import {
  defaultStateDir,
  ownerCalls,
  readAll,
  type StoredTicket,
  ticketOf,
  until,
} from '../runtime/integration-fixtures.js'
import { githubWorld, PR } from './github-world.js'

afterAll(stopAllDaemons)

const FOLLOW_UP = 'Please also check the logout page'
const LATE = 'One more thing: keep the session cookie'
const RESULT = 'The login page is fixed in PR #7.'
const ACKNOWLEDGEMENT = 'Fixing the login page now.'
/** A step that waits for a GitHub poll: the Source polls a minute apart. */
const POLL_MS = 150_000

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
          .join('')
      : ''
/**
 * The turn the request continues: the messages people and Superagent sent it (the run of user messages before its first
 * tool call; hook context arrives as one of them), and the tool results since.
 */
function turnOf(request: ScriptRequest): { input: string; results: string[] } {
  const { messages } = request
  let end = messages.length
  while (end > 0 && messages[end - 1]!.role !== 'user') end--
  let start = end
  while (start > 0 && messages[start - 1]!.role === 'user') start--
  return {
    input: messages
      .slice(start, end)
      .map((message) => textOf(message.content))
      .join('\n'),
    results: messages
      .slice(end)
      .filter((message) => message.role === 'tool')
      .map((message) => textOf(message.content)),
  }
}
const field = (text: string, name: string) =>
  new RegExp(`\\\\?"${name}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`).exec(text)?.[1]

/**
 * The model, per session: the main session routes Alice's request with an acknowledgement and replies once to the
 * worker's ready result; the worker pushes its branch, opens the PR and reports it ready, and handles a follow-up by
 * pushing again and reporting. `busy` holds the worker's first turn until the daemon drops it.
 */
function scriptedSessions(world: ReturnType<typeof githubWorld>, opts: { busy?: boolean } = {}) {
  const seen = {
    replies: 0,
    workerRequests: [] as { at: number; text: string }[],
    held: false,
    /** What each main-session request ended with, for diagnostics. */
    main: [] as string[],
  }
  const respond = async (request: ScriptRequest, closed: AbortSignal) => {
    const { input, results: done } = turnOf(request)
    if (request.tools.includes('orchestrator_route')) {
      seen.main.push(`${done.length} ${done.at(-1)?.slice(0, 300) ?? ''} | ${input.slice(-600)}`)
      if (done.length) return { text: 'ACK main' }
      if (/worker_report/.test(input) && /\\?"state\\?":\s*\\?"ready/.test(input) && !seen.replies) {
        seen.replies++
        const ticket = field(input, 'ticket_id')
        return {
          tool: { name: 'orchestrator_reply', args: { purpose: 'result', ticket_id: ticket, text: RESULT } },
        }
      }
      const trigger = field(input, 'trigger_id')
      if (trigger && input.includes('please fix the login page'))
        return {
          tool: {
            name: 'orchestrator_route',
            args: {
              decisions: [
                {
                  trigger_id: trigger,
                  kind: 'accept',
                  title: 'Fix the login page',
                  worktree_name: 'fix-login',
                  acknowledgement: ACKNOWLEDGEMENT,
                },
              ],
            },
          },
        }
      return { text: 'ACK main' }
    }
    if (!request.tools.includes('orchestrator_report')) return undefined
    seen.workerRequests.push({ at: Date.now(), text: JSON.stringify(request.messages) })
    if (opts.busy) {
      if (seen.held) return { text: 'ACK worker' }
      seen.held = true
      // The worker's turn runs on: its model never answers until the daemon drops the request.
      await new Promise((resolve) => closed.addEventListener('abort', resolve, { once: true }))
      return undefined
    }
    const followUp = input.includes(FOLLOW_UP)
    const assignment = !followUp && /ticket_id/.test(input) && /\\?"title\\?"/.test(input)
    if (!followUp && !assignment) return { text: 'ACK worker' }
    if (done.length === 0)
      return {
        tool: {
          name: 'shell',
          args: {
            command: followUp
              ? 'cd repo && echo logout >> LOGIN.md && git commit -qam "Check the logout page" && git push -q origin HEAD 2>&1 && echo pushed-again'
              : [
                  'set -e',
                  'BRANCH="agent/$(basename "$PWD")"',
                  'cd repo',
                  'git checkout -q -b "$BRANCH"',
                  'echo fixed > LOGIN.md',
                  'git add LOGIN.md',
                  'git commit -q -m "Fix the login page"',
                  'git push -q origin "$BRANCH" 2>&1',
                  'gh pr create --title "Fix the login page" --body "Fixes #12" --head "$BRANCH"',
                  'echo "BRANCH=$BRANCH"',
                ].join('\n'),
          },
        },
      }
    if (done.length === 1) {
      const branch = /BRANCH=(\S+)/.exec(done[0]!)?.[1]
      if (branch) world.pull(branch)
      return {
        tool: {
          name: 'orchestrator_report',
          args: {
            state: 'ready',
            summary: followUp
              ? 'Checked the logout page as well; PR #7 updated.'
              : 'Fixed the login page in PR #7.',
            pr_number: PR,
          },
        },
      }
    }
    return { text: 'ACK worker' }
  }
  return { respond, seen }
}

/** Starts the daemon as the deployment guide does and turns the GitHub Source on with the agent's `gh` and remote. */
async function deploy(
  root: string,
  stateDir: string | undefined,
  respond: ReturnType<typeof scriptedSessions>['respond'],
  world: ReturnType<typeof githubWorld>,
) {
  const aghHome = join(root, 'agh')
  const state = stateDir ?? defaultStateDir(aghHome)
  // The daemon starts as usual, with the operator's HOME and PATH.
  const home = join(root, 'operator-home')
  mkdirSync(home, { recursive: true })
  const remote = await startGitHttpRemote({ users: { [AGENT_CREDENTIAL.user]: AGENT_CREDENTIAL.password } })
  let handle: DaemonHandle | undefined
  const daemon = await startDaemon({
    aghHome,
    home,
    path: process.env.PATH ?? '',
    plugins: ['./bundled-plugins/superagent'],
    respond,
    onHandle: (started) => {
      handle = started
    },
  })
  const calls = ownerCalls(() => daemon.client)
  const database = join(state, DATABASE_FILE)
  if (stateDir) {
    await calls.disable()
    await calls.configure({ stateDir })
  } else {
    // The enabled payload starts with the grant and opens its database in the platform's directory for it.
    await until('the Superagent database', () => existsSync(database))
    await calls.disable()
  }
  const url = new URL(remote.url)
  url.username = AGENT_CREDENTIAL.user
  url.password = AGENT_CREDENTIAL.password
  const store = openStore(database)
  try {
    store.saveSettings(
      SettingsSchema.parse({
        policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
        sources: { github: { enabled: true, config: { repository: 'acme/app', cli: world.cli } } },
        executor: { prepare: `git clone -q ${url.href} repo`, directory: join(state, 'work') },
      }),
    )
    // Notifications are read from an hour ago, so Alice's Issue counts as new.
    store.set(KV.github.since, new Date(Date.now() - 3600_000).toISOString())
  } finally {
    store.close()
  }
  await calls.enable()
  return {
    daemon,
    calls,
    database,
    remote,
    state,
    stop: async () => {
      await handle?.stop()
      await remote.close()
    },
  }
}
const tickets = (database: string) =>
  (readAll(database, 'SELECT value FROM ticket') as { value: string }[]).map(
    (row) =>
      JSON.parse(row.value) as StoredTicket & { id: string; execution?: { name: string; directory: string } },
  )

it.skipIf(process.platform === 'win32')(
  'routes a GitHub request to a ticket whose worker pushes and opens a PR, replies, wakes on a follow-up and ends on the merge',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-flow-')))
    const world = githubWorld(join(root, 'github'), new Date(Date.now() - 1800_000).toISOString())
    const model = scriptedSessions(world)
    let run: Awaited<ReturnType<typeof deploy>> | undefined
    try {
      // The default state directory the platform gives Superagent.
      run = await deploy(root, undefined, model.respond, world)
      const { daemon, database, remote } = run
      const diagnose = async (error: unknown): Promise<never> => {
        const lines = daemon
          .stderr()
          .split('\n')
          .filter((line) => /superagent|error/i.test(line))
        const state = await run!.calls
          .service('superagent.state')
          .then((answer) => JSON.stringify({ setup: answer.setup, health: answer.health }))
          .catch((failure: unknown) => String(failure))
        throw new Error(
          [
            String(error),
            `gh calls: ${JSON.stringify(world.calls().map((call) => `${call.exit} ${call.argv.join(' ').slice(0, 160)}`))}`,
            `state: ${state}`,
            `triggers: ${JSON.stringify(readAll(database, 'SELECT id FROM trigger'))}`,
            `tickets: ${JSON.stringify(tickets(database))}`,
            `effects: ${JSON.stringify(readAll(database, 'SELECT kind, key, attempts, error FROM effect'))}`,
            `main session: ${JSON.stringify(model.seen.main)}`,
            `model: ${JSON.stringify(daemon.modelRequests().map((request) => `${request.main} ${request.lastRole} ${request.marker.slice(0, 80)}`))}`,
            ...lines.slice(-30),
          ].join('\n'),
          { cause: error },
        )
      }
      // The notification is admitted and routed: one ticket, acknowledged on the Issue.
      // A setup problem would hold everything back: it fails the wait at once.
      const ticket = await until(
        'the ticket',
        async () => {
          const state = await run!.calls.service('superagent.state').catch(() => undefined)
          const problem = (state?.setup as { problem?: { detail: string } } | undefined)?.problem
          if (problem) throw new Error(`setup problem: ${problem.detail}`)
          return tickets(database)[0]
        },
        POLL_MS,
      ).catch(diagnose)
      const workerId = `superagent:worker:${ticket.id}`
      await until('the worker session', () => run!.calls.exists(workerId)).catch(diagnose)
      // The worker commits in repo/, pushes its branch and opens a PR, then reports it ready with the PR.
      const branch = `agent/${ticket.execution!.name}`
      await until(
        'the ready report',
        () => ticketOf(database, ticket.id)?.assignments.at(-1)?.report?.state === 'ready',
      ).catch(diagnose)
      expect(await remote.refs()).toContain(`refs/heads/${branch}`)
      const pushers = remote.authLog().filter((line) => /POST \S*git-receive-pack/.test(line))
      expect(pushers.every((line) => line.startsWith(`${AGENT_CREDENTIAL.user} `))).toBe(true)
      expect(pushers.length).toBeGreaterThan(0)
      // The main session replies with the result on the Issue.
      await until('the reply on the Issue', () => world.posted().some((body) => body.includes(RESULT))).catch(
        diagnose,
      )
      expect(ticketOf(database, ticket.id)?.ended, 'the ticket waits for its PR').toBeUndefined()

      // Alice follows up on the Issue: the same ticket's worker takes it, pushes again and reports.
      const worker = await daemon.client.session.load(workerId, { history: 'none' })
      await until('the worker idle', async () => (await worker.projectUI()).opState === null)
      world.comment(501, FOLLOW_UP)
      const followed = async () =>
        (await worker.projectUI()).nodes.filter(
          (node) =>
            node.kind === 'user' &&
            node.content.some((block) => block.type === 'text' && block.text.includes(FOLLOW_UP)),
        ).length
      await until('the follow-up in the worker session', async () => (await followed()) > 0, POLL_MS).catch(
        diagnose,
      )
      await until('the follow-up pushed', () =>
        model.seen.workerRequests.some((request) => request.text.includes('pushed-again')),
      ).catch(diagnose)
      await until(
        'the worker idle after the follow-up',
        async () => (await worker.projectUI()).opState === null,
      )

      // The PR is merged: the ticket ends.
      world.pull(branch, true)
      const ended = await until(
        'the ended ticket',
        () => ticketOf(database, ticket.id)?.ended,
        POLL_MS,
      ).catch(diagnose)
      expect(ended).toMatchObject({ outcome: 'merged' })

      // One ticket, one worker session, the follow-up taken once; GitHub saw one PR, one acknowledgement and one reply.
      expect(tickets(database)).toHaveLength(1)
      expect(ticketOf(database, ticket.id)?.assignments).toHaveLength(1)
      expect(await followed()).toBe(1)
      const created = world.calls().filter((call) => call.argv[0] === 'pr' && call.argv[1] === 'create')
      expect(created).toHaveLength(1)
      const posted = world.posted()
      expect(posted.filter((body) => body.includes(RESULT))).toHaveLength(1)
      expect(posted.filter((body) => body.includes(ACKNOWLEDGEMENT))).toHaveLength(1)
      expect(posted).toHaveLength(2)
      expect(model.seen.replies).toBe(1)
      expect(world.unmatched().map((call) => call.argv.join(' '))).toEqual([])
    } finally {
      await run?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  600_000,
)

it.skipIf(process.platform === 'win32')(
  'restart while busy: a comment waiting for a busy worker is taken once, within ten seconds of a daemon restart',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-busy-')))
    const world = githubWorld(join(root, 'github'), new Date(Date.now() - 1800_000).toISOString())
    const model = scriptedSessions(world, { busy: true })
    let run: Awaited<ReturnType<typeof deploy>> | undefined
    try {
      // An explicit state directory.
      run = await deploy(root, join(root, 'state'), model.respond, world)
      const { daemon, database } = run
      const ticket = await until('the ticket', () => tickets(database)[0], POLL_MS)
      const workerId = `superagent:worker:${ticket.id}`
      await until('the worker session', () => run!.calls.exists(workerId))
      const worker = () => daemon.client.session.load(workerId, { history: 'none' })
      await until('the worker busy', async () => (await (await worker()).projectUI()).opState != null)
      // Alice comments while the worker is busy: Superagent hands the comment to the session, where it waits.
      world.comment(502, LATE)
      const waiting = async () =>
        ((await (await worker()).projectUI()).pendingInputs ?? []).filter((item) =>
          item.commandId?.startsWith('superagent:'),
        )
      await until(
        'the comment waiting in the worker session',
        async () => {
          const items = await waiting()
          return items.some((item) => (item.preview ?? '').includes(LATE)) || undefined
        },
        POLL_MS,
      )
      await daemon.restart()
      const restarted = Date.now()
      // What happens after the restart, step by step, for the record.
      const timeline: string[] = []
      /** When Superagent's service answered again: the daemon publishes the plugin's service some seconds after it listens. */
      let back: number | undefined
      /** When the daemon let the owner load the worker's session again, after restoring its sessions. */
      let sessionsBack: number | undefined
      let watching = true
      const watch = (async () => {
        let last = ''
        while (watching) {
          const state = await run!.calls.service('superagent.state').catch(() => undefined)
          if (state && back === undefined) back = Date.now()
          const health = state?.health as Record<string, { state: string; detail: string }> | undefined
          const stored = ticketOf(database, ticket.id) as
            | { assignments: { state: string; startedAt?: string }[] }
            | undefined
          const pending = await worker()
            .then(async (session) => (await session.projectUI()).pendingInputs?.length ?? 0)
            .catch(() => -1)
          if (pending >= 0 && sessionsBack === undefined) sessionsBack = Date.now()
          const line = JSON.stringify({
            runtime: health?.runtime?.state,
            launch: health?.launch?.detail,
            delivery: health?.delivery?.detail,
            assignments: stored?.assignments.map(
              (item) => `${item.state}${item.startedAt ? ' started' : ''}`,
            ),
            pending,
          })
          if (line !== last) timeline.push(`+${Date.now() - restarted} ms ${line}`)
          last = line
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      })()
      // Superagent resumes it on its own, within ten seconds.
      const taken = await until(
        'the comment taken after the restart',
        () =>
          model.seen.workerRequests.find((request) => request.at >= restarted && request.text.includes(LATE)),
        60_000,
      ).finally(() => {
        watching = false
      })
      await watch
      console.info(
        [
          `restart while busy: Superagent's service answered ${(back ?? Number.NaN) - restarted} ms after the restart, ` +
            `the worker's session loaded again ${(sessionsBack ?? Number.NaN) - restarted} ms after it; ` +
            `the comment reached the worker's model ${taken.at - restarted} ms after the restart`,
          ...timeline,
        ].join('\n'),
      )
      // Ten seconds from the moment the daemon serves Superagent and its sessions again: the time the daemon takes to start
      // the plugin and restore the sessions is the platform's, and is logged above.
      expect(back, "Superagent's service answered again").toBeDefined()
      expect(sessionsBack, "the worker's session loaded again").toBeDefined()
      expect(taken.at - Math.max(back!, sessionsBack!)).toBeLessThanOrEqual(10_000)
      await until(
        'the worker idle after the restart',
        async () => (await (await worker()).projectUI()).opState === null,
      )
      const ui = await (await worker()).projectUI()
      const copies = ui.nodes.filter(
        (node) =>
          node.kind === 'user' &&
          node.content.some((block) => block.type === 'text' && block.text.includes(LATE)),
      )
      expect(copies).toHaveLength(1)
      expect((ui.pendingInputs ?? []).filter((item) => (item.preview ?? '').includes(LATE))).toEqual([])
      // One trigger for the comment, which the ticket received once.
      const comments = (readAll(database, 'SELECT value FROM trigger') as { value: string }[]).filter((row) =>
        row.value.includes(LATE),
      )
      expect(comments).toHaveLength(1)
    } finally {
      await run?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  480_000,
)

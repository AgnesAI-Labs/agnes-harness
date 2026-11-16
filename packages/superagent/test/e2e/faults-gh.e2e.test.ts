// GitHub CLI faults: the GitHub Source runs the agent's `gh` (the scripted fake, as a real process); a read that times
// out, and then one GitHub answers 404, stay queued and are read again on the next polls until one succeeds; a prepare
// command that fails fails the ticket for a person and is never run again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sourceContextOf } from '../../src/app/source-context.js'
import { Engine, key, latestReport, type Trigger, ticketStage } from '../../src/core/index.js'
import { Commands } from '../../src/infra/commands.js'
import { HealthBoard } from '../../src/infra/health.js'
import { KV } from '../../src/kv.js'
import { SettingsSchema, settingsPolicy } from '../../src/policy.js'
import { githubKind, pollRound } from '../../src/sources/github.js'
import { SourceRegistry } from '../../src/sources/registry.js'
import { fakeGhCommand, nodePrepare } from '../fixtures/commands.js'
import { testDeployment } from '../fixtures/deployment.js'
import { tempStore } from '../runtime/helpers.js'
import { world } from './world.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

/** How long one `gh` call may run here before Superagent stops it. */
const TIMEOUT_MS = 1500

/** The agent's `gh`: the scripted fake behind a wrapper that names its script and log; returns it and its calls. */
function agentGh(dir: string, rules: unknown[]) {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'script.json')
  const log = join(dir, 'gh.log')
  writeFileSync(script, JSON.stringify({ login: 'agent-bot', rules }))
  const cli = fakeGhCommand(join(dir, 'gh'), { script, log })
  const calls = (): { argv: string[]; matched: boolean; exit: number }[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  return { cli, calls }
}

/**
 * The GitHub Source over the test's store, with the agent's `gh` (`cli`), a short command timeout and `config` on the
 * Source; returns its context and what it reported.
 */
function githubSource(cli: string, config: Record<string, unknown> = {}) {
  // The GitHub Source over the store, with the agent's `gh` and a short command timeout.
  const { store } = temp
  store.saveSettings(
    SettingsSchema.parse({
      policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
      sources: { github: { enabled: true, config: { repository: 'acme/app', cli, ...config } } },
    }),
  )
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  sources.register(githubKind)
  const engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: () => {} },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
  })
  const deployment = testDeployment({
    repository: 'acme/app',
    github: { cli, login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  })
  const commands = new Commands(() => deployment, {}, new AbortController().signal, TIMEOUT_MS)
  const reports: Record<string, { state: string; detail: string }> = {}
  const ctx = {
    ...sourceContextOf(
      {
        store,
        engine,
        outbox: { send: () => {} },
        commands,
        sources,
        deployment,
        ready: Promise.resolve(),
        configured: () => true,
        receive: async (trigger: Trigger) => {
          const result = engine.receive(trigger)
          engine.evaluateDue()
          return result
        },
      },
      { kind: 'github', health: ['github'] },
    ),
  }
  ctx.report = (entry: string, value: { state: string; detail: string }) => {
    reports[entry] = value
  }
  return { ctx, reports }
}

it('reads an Issue again on the next polls after its read timed out and after GitHub answered 404, until it succeeds', async () => {
  const since = new Date(Date.now() - 3600_000).toISOString()
  const created = new Date(Date.now() - 1800_000).toISOString()
  const issue = {
    id: 1012,
    number: 12,
    title: 'Login fails',
    body: '@agent-bot please fix the login',
    state: 'open',
    created_at: created,
    updated_at: created,
    html_url: 'https://github.com/acme/app/issues/12',
    user: { login: 'alice', type: 'User' },
  }
  const notification = {
    id: 'n12',
    updated_at: created,
    reason: 'mention',
    repository: { full_name: 'acme/app' },
    subject: { url: 'https://api.github.com/repos/acme/app/issues/12', type: 'Issue', title: issue.title },
  }
  const issueRead = '^api repos/acme/app/issues/12$'
  const gh = agentGh(join(temp.dir, 'gh'), [
    {
      pattern: '^api repos/acme/app/notifications\\?',
      stdout: `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`,
    },
    // The first read hangs past the timeout, the second is refused as not found, the third answers.
    { pattern: issueRead, stdout: JSON.stringify(issue), delayMs: 5_000, times: 1 },
    { pattern: issueRead, stderr: 'gh: Not Found (HTTP 404)\n', exit: 1, times: 1 },
    { pattern: issueRead, stdout: JSON.stringify(issue) },
    { pattern: '^api repos/acme/app/issues/12/comments', stdout: '[[]]' },
  ])
  const { store } = temp
  const { ctx, reports } = githubSource(gh.cli)
  store.set(KV.github.since, since)
  const triggerId = key('github-issue', '12')
  const retries = () => store.get(KV.github.retries) ?? {}

  // The read times out: the round fails, naming it, and the Issue waits for the next poll.
  await expect(pollRound(ctx)).rejects.toThrow(
    `1 GitHub reads failed: #12: Error: gh timed out after ${TIMEOUT_MS / 1000} s`,
  )
  expect(retries()).toMatchObject({ 12: { attempts: 1, pr: false } })
  expect(store.triggers.get(triggerId)).toBeUndefined()
  // GitHub answers 404: not deleted (that is 410), so it waits for the next poll again.
  await expect(pollRound(ctx)).rejects.toThrow('1 GitHub reads failed: #12: Error: gh: Not Found (HTTP 404)')
  expect(retries()).toMatchObject({ 12: { attempts: 2, pr: false } })
  expect(store.triggers.get(triggerId)).toBeUndefined()
  // The third read succeeds: the request is taken in once, and nothing waits any more.
  expect(await pollRound(ctx)).toBe(60)
  expect(retries()).toEqual({})
  expect(store.triggers.get(triggerId)).toMatchObject({ actor: { id: 'alice' }, human: true })
  expect(reports.github).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s' })
  // The timed-out call was stopped before it answered, so only the 404 and the answer reached the log.
  expect(
    gh
      .calls()
      .filter((call) => /issues\/12$/.test(call.argv.join(' ')))
      .map((call) => call.exit),
  ).toEqual([1, 0])
  expect(gh.calls().filter((call) => !call.matched)).toEqual([])
})

it("reads an observed stream again with GitHub's quoted ETag through the agent's own CLI, and takes 304 as no news", async () => {
  // GitHub's ETags are quoted; on Windows the agent CLI is a batch file, which must receive the quotes whole.
  const etag = 'W/"0d8f1c2e"'
  const stream = '^api repos/acme/app/issues\\?state=all&sort=updated'
  const gh = agentGh(join(temp.dir, 'gh'), [
    {
      pattern: '^api repos/acme/app/notifications\\?',
      stdout: 'HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n[]',
    },
    // The repeated read with the ETag: nothing new.
    { pattern: `${stream}.* --include -H If-None-Match: W/"0d8f1c2e"$`, stderr: 'gh: HTTP 304\n', exit: 1 },
    { pattern: `${stream}.* --include$`, stdout: `HTTP/2.0 200 OK\r\nETag: ${etag}\r\n\r\n[]` },
  ])
  const { ctx } = githubSource(gh.cli, { observeIssues: true })
  const reads = () => gh.calls().filter((call) => /^api repos\/acme\/app\/issues\?/.test(call.argv.join(' ')))
  expect(await pollRound(ctx)).toBe(60)
  expect(temp.store.get(KV.github.stream('issues'))).toMatchObject({ etag })
  // The next round sends the ETag back, as one argument, and GitHub's 304 is no failure.
  expect(await pollRound(ctx)).toBe(60)
  expect(reads().map((call) => [call.argv.at(-1), call.exit])).toEqual([
    ['--include', 0],
    [`If-None-Match: ${etag}`, 1],
  ])
  expect(reads()[1]?.argv.at(-2)).toBe('-H')
  expect(temp.store.get(KV.github.stream('issues'))).toMatchObject({ etag })
  expect(gh.calls().filter((call) => !call.matched)).toEqual([])
})

it('fails the ticket for a person when its prepare command fails, and never runs the command again', async () => {
  const runs = join(temp.dir, 'prepare-runs')
  const w = world(temp.store, temp.dir, {
    prepare: nodePrepare(
      join(temp.dir, 'prepare'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(runs)}, 'run\\n')\nconsole.error('clone refused')\nprocess.exit(3)\n`,
    ),
  })
  const ticketId = w.accept()
  await w.effects.idle('launch')
  await vi.waitFor(() => expect(latestReport(temp.store.tickets.get(ticketId)!)?.state).toBe('failed'))
  const ticket = temp.store.tickets.get(ticketId)!
  expect(latestReport(ticket)?.summary).toContain('clone refused')
  expect(ticketStage(ticket)).toEqual({ stage: 'person', action: 'failed' })
  await w.effects.idle('relay')
  expect(JSON.parse(w.relays.at(-1)!)).toMatchObject({ kind: 'worker_report', state: 'failed' })
  // Nothing is queued to run it again, and a pass over the queue runs nothing.
  expect(w.effects.pending('launch')).toBe(false)
  await w.rerun('launch')
  expect(readFileSync(runs, 'utf8')).toBe('run\n')
  expect(w.worker(ticketId)).toBeUndefined()
  await w.stop()
})

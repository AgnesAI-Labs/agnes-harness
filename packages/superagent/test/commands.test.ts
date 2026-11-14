// Adapted from dsh-superagent (MIT)
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key, type OutboundMessage } from '../src/core/index.js'
import { CliError, Commands, commandError } from '../src/infra/commands.js'
import { SettingsSchema } from '../src/policy.js'
import { feishuKind } from '../src/sources/feishu.js'
import { feishuChannel } from '../src/sources/feishu-trigger.js'
import { githubKind } from '../src/sources/github.js'
import { githubChannel } from '../src/sources/github-trigger.js'
import { SourceRegistry } from '../src/sources/registry.js'
import { testDeployment } from './fixtures/deployment.js'

const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(feishuKind)
sources.register(githubKind)
const send = (commands: Commands, message: OutboundMessage) => sources.send(message, commands)
const deployment = testDeployment({ github: { ...testDeployment().github, cli: '/path/agent-gh' } })
const REPOSITORY = deployment.repository
const reply = { id: 'stable-operation', channel: githubChannel(8), text: 'Done', kind: 'reply' as const }
describe('account-isolated operations', () => {
  it("uses the agent account's GitHub CLI and preserves literal shell metacharacters in argv", async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{}')
    await commands.gh(['api', 'some-path', '-f', 'body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api', 'some-path', '-f', 'body=`whoami` $(touch x)'])
  })
  it('runs every command with its environment over the process environment, and never passes a credential-shaped variable on', async () => {
    process.env.GH_TOKEN = 'personal'
    try {
      const output = await new Commands(
        () => deployment,
        { AGENT_GITHUB_TOKEN: 'agent-token', SUPERAGENT_PROBE: 'agent' },
        new AbortController().signal,
      ).run('env', [])
      expect(output).toContain('SUPERAGENT_PROBE=agent')
      expect(output).toContain('GH_PROMPT_DISABLED=1')
      expect(output).not.toContain('GH_TOKEN=')
      expect(output).not.toContain('AGENT_GITHUB_TOKEN=')
    } finally {
      delete process.env.GH_TOKEN
    }
  })
  it('reconciles an uncertain GitHub send with its stable marker', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands, 'pages').mockResolvedValue([
      { body: '<!-- dsh-superagent:stable-operation -->', user: { login: 'agent-bot' } },
    ])
    const gh = vi.spyOn(commands, 'gh')
    await send(commands, reply)
    expect(gh).not.toHaveBeenCalled()
  })
  it('posts the reply as the model wrote it, only to the fixed repository', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands, 'gh').mockResolvedValue({})
    await send(commands, reply)
    // The disclosure line is prompt text: the model writes it, and the host adds nothing.
    expect(gh).toHaveBeenCalledWith([
      'api',
      `repos/${REPOSITORY}/issues/8/comments`,
      '--method',
      'POST',
      '-f',
      expect.stringMatching(/^body=Done\n\n<!-- dsh-superagent:stable-operation -->$/),
    ])
    await expect(
      new Commands(() => deployment, {}, new AbortController().signal).pages(
        z.unknown(),
        '../../someone/else/issues',
      ),
    ).rejects.toThrow()
  })
  it('routes review-comment replies to the root review comment', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands, 'pages').mockResolvedValue([])
    const gh = vi
      .spyOn(commands, 'gh')
      .mockResolvedValueOnce({ id: 7, in_reply_to_id: 3 })
      .mockResolvedValueOnce({})
    await send(commands, {
      ...reply,
      channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`),
    })
    expect(gh.mock.calls[1]![0]).toEqual([
      'api',
      `repos/${REPOSITORY}/pulls/8/comments/3/replies`,
      '--method',
      'POST',
      '-f',
      expect.stringContaining('Done'),
    ])
  })
})

it('reports Feishu failures with their code and without command arguments', () => {
  const membership = commandError({
    stderr:
      '[page 1] fetching...\n' +
      JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } }),
  })
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(
    commandError({ stderr: JSON.stringify({ error: { code: 999, message: 'scope missing' } }) }).message,
  ).toBe('scope missing (999)')
})
describe('Channels', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  it('drop a GitHub reply to an Issue that is deleted or locked, and keep others for a retry', async () => {
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
    for (const stderr of [
      'gh: This issue was deleted (HTTP 410)',
      'gh: Unable to create comment because issue is locked. (HTTP 403)',
    ]) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      expect(await send(value, reply)).toBe('gone')
    }
    // GitHub also answers 404 for a private repository the agent lost access to, so 404 is retried rather than dropped.
    for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: Server Error (HTTP 500)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      await expect(send(value, reply)).rejects.toThrow(stderr)
    }
  })
  it("reply on the PR's conversation when the review comment a reply points at is gone", async () => {
    const value = commands()
    const pages = vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi
      .spyOn(value, 'gh')
      .mockRejectedValueOnce(commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 }))
      .mockResolvedValueOnce({})
    expect(
      await send(value, {
        ...reply,
        channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`),
      }),
    ).toBe('sent')
    expect((pages.mock.calls[0] as unknown[])[1]).toBe('issues/8/comments')
    const post = [
      'api',
      `repos/${REPOSITORY}/issues/8/comments`,
      '--method',
      'POST',
      '-f',
      expect.stringContaining('Done'),
    ]
    expect(gh.mock.calls[1]![0]).toEqual(post)
  })
  it('link each address to its page with its label', () => {
    const links = { repository: REPOSITORY, feishu: deployment.feishu! }
    expect(githubKind.channel!.link(githubChannel(8).address, links)).toEqual({
      url: `https://github.com/${REPOSITORY}/issues/8`,
      label: { zh: 'GitHub #8', en: 'GitHub #8' },
    })
    const review = `https://github.com/${REPOSITORY}/pull/8#discussion_r7`
    expect(githubKind.channel!.link(githubChannel(8, review).address, links)).toEqual({
      url: review,
      label: { zh: 'GitHub #8 的 review 讨论', en: 'Review discussion on GitHub #8' },
    })
    expect(githubKind.channel!.link(githubChannel(8).address, {}).url).toBe('')
    const message = feishuChannel('oc_1', 'om_1').address
    expect(feishuKind.channel!.link(message, links)).toEqual({
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' },
      triggerId: key('feishu', 'om_1'),
    })
  })
})

describe('GitHub calls', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  it('go only to paths inside the configured repository, and validate what GitHub answers', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12,"title":"Login fails","extra":true}')
    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toEqual({
      number: 12,
      title: 'Login fails',
      extra: true,
    })
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12`])
    await expect(value.api(z.looseObject({ number: z.string() }), 'issues/12')).rejects.toThrow()
    for (const path of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('restricted to the configured repository')
    }
    expect(run).toHaveBeenCalledTimes(2)
    // An empty path targets the repository root.
    await value.api(z.unknown(), '')
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}`])
    // Without a schema, api() returns the raw CLI stdout.
    run.mockResolvedValue('raw file')
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')
  })
  it('read every page of a list, and skip and count an item that does not validate', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('[[{"id":1}],[{"id":2}]]')
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments?per_page=100')).toEqual([
      { id: 1 },
      { id: 2 },
    ])
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', [
      'api',
      `repos/${REPOSITORY}/issues/12/comments?per_page=100`,
      '--paginate',
      '--slurp',
    ])
    run.mockResolvedValue('[[{"id":1}],[{"id":"two"}]]')
    const tally = { skipped: 0 }
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally)).toEqual([
      { id: 1 },
    ])
    expect(tally).toEqual({ skipped: 1 })
    run.mockResolvedValue('{"message":"not a list"}')
    await expect(value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments')).rejects.toThrow()
  })
})
it('names only the program and how it ended when a command prints no diagnostics, never its arguments', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const reply = 'private reply text'
  await expect(commands.run('sh', ['-c', 'exit 3', reply])).rejects.toMatchObject({
    message: 'sh exited with code 3',
    exitCode: 3,
  })
  await expect(commands.run('sh', ['-c', 'kill -9 $$', reply])).rejects.toMatchObject({
    message: 'sh was stopped before it finished',
  })
  // A command that runs past its time is stopped, and its error says how long it was given.
  await expect(
    new Commands(() => deployment, {}, new AbortController().signal, 100).run('sleep', ['5']),
  ).rejects.toMatchObject({ message: 'sleep timed out after 0.1 s' })
  await expect(commands.run('/no/such/program', [reply])).rejects.toMatchObject({
    message: 'program could not run: ENOENT',
  })
  // Timeouts kill the child with SIGTERM; Node's default error message would echo every argument.
  const timedOut = {
    killed: true,
    signal: 'SIGTERM',
    code: null,
    stderr: '',
    message: 'Command failed: /path/gh-bot api repos/acme/app --field body=withdrawn',
  }
  expect(commandError(timedOut, '/path/gh-bot')).toMatchObject({ message: 'gh-bot timed out after 90 s' })
  expect(String(commandError(timedOut, '/path/gh-bot'))).not.toContain('withdrawn')
})
it('reports failures as CliError with the code the CLI names and the exit status', async () => {
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'gh: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  expect(
    commandError({
      stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
      code: 1,
    }),
  ).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // A cancelled command stays an AbortError so callers can distinguish cancellation from failure.
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run('sleep', ['5'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
})

it('returns the whole output of a command up to the limit, and refuses one that printed more than it may', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  // More than the 1 MiB `runCommand` keeps by default, which a paginated GitHub list can reach.
  const output = await commands.run('sh', ['-c', "head -c 3000000 /dev/zero | tr '\\0' x"])
  expect(output).toHaveLength(3_000_000)
  await expect(commands.run('sh', ['-c', "head -c 17000000 /dev/zero | tr '\\0' x"])).rejects.toMatchObject({
    message: 'sh printed more output than it may',
  })
})
it('stops a running command when the signal of its work aborts, or the lifetime, and leaves the other work running', async () => {
  const lifetime = new AbortController(),
    work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = commands.withSignal(work.signal).run('sleep', ['5'])
  work.abort()
  await expect(running).rejects.toThrow()
  // Only commands bound to the aborted work signal stop.
  expect(await commands.run('echo', ['still'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run('sleep', ['5'])
  lifetime.abort()
  await expect(other).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(4000)
})

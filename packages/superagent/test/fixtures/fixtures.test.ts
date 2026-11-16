import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelAdapter, ChannelEvent, MessageEvent } from '@agnes/extension-api/channel-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { runCommand } from '../../src/app/subprocess.js'
import { hostFloor, socketDirectoryOf } from './daemon-harness.js'
import { startGitHttpRemote } from './git-http-remote.js'
import { AGENT_CREDENTIAL, makeHomes, OPERATOR_CREDENTIAL } from './homes.js'
import { posixDescribe } from './posix.js'
import { isAlive, killTree, type ProcessIo } from './process-tree.js'
import { createTestChannel } from './test-channel.js'

const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-fixtures-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
/**
 * Runs `file` with exactly `env` (and on Windows what a program needs there to start), found on its PATH as a shell
 * finds it, so a fake command's `.cmd` launcher runs on Windows too.
 */
const run = (file: string, args: string[], env: Record<string, string | undefined>, cwd?: string) =>
  runCommand([file, ...args], {
    env: Object.fromEntries(
      Object.entries({ ...hostFloor(env.HOME), ...env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    replaceEnv: true,
    ...(cwd ? { cwd } : {}),
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  })

describe('fake gh', () => {
  const gh = (root: string, script: unknown, ...args: string[]) => {
    const scriptPath = join(root, 'script.json')
    writeFileSync(scriptPath, JSON.stringify(script))
    return run(process.execPath, [FAKE_GH, ...args], {
      PATH: process.env.PATH,
      FAKE_GH_SCRIPT: scriptPath,
      FAKE_GH_LOG: join(root, 'calls.log'),
    })
  }
  const calls = (root: string) =>
    readFileSync(join(root, 'calls.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

  it('replays scripted replies, answers the login, and logs every call including the unscripted one', async () => {
    const root = scratch()
    const script = {
      login: 'agent-bot',
      rules: [
        { args: ['pr', 'create'], stdout: 'https://example.invalid/o/r/pull/7\n' },
        { args: ['api', 'notifications'], stdout: '[]\n', times: 1 },
        { args: ['api', 'repos/o/r/pulls/7'], stderr: 'HTTP 404\n', exit: 1 },
      ],
    }
    expect(await gh(root, script, 'api', 'user', '--jq', '.login')).toMatchObject({
      code: 0,
      stdout: 'agent-bot\n',
    })
    expect(await gh(root, script, 'pr', 'create', '--title', 't')).toMatchObject({
      code: 0,
      stdout: 'https://example.invalid/o/r/pull/7\n',
    })
    expect(await gh(root, script, 'api', 'notifications')).toMatchObject({ code: 0, stdout: '[]\n' })
    // `times: 1`: the rule is spent, so a second identical call is unscripted.
    expect(await gh(root, script, 'api', 'notifications')).toMatchObject({ code: 1 })
    expect(await gh(root, script, 'api', 'repos/o/r/pulls/7')).toMatchObject({
      code: 1,
      stderr: 'HTTP 404\n',
    })
    const last = await gh(root, script, 'issue', 'list')
    expect(last.code).toBe(1)
    expect(last.stderr).toContain('no scripted reply for: gh issue list')
    expect(calls(root).map((call) => [call.argv.join(' '), call.matched])).toEqual([
      ['api user --jq .login', true],
      ['pr create --title t', true],
      ['api notifications', true],
      ['api notifications', false],
      ['api repos/o/r/pulls/7', true],
      ['issue list', false],
    ])
  })

  it('matches a rule by a pattern over the joined arguments, and holds an answer back for its delay', async () => {
    const root = scratch()
    const script = {
      rules: [
        { pattern: '^api repos/o/r/notifications\\?.*since=', stdout: '[]\n', delayMs: 300 },
        { pattern: 'issues/\\d+$', stdout: '{}\n' },
      ],
    }
    const started = Date.now()
    expect(
      await gh(root, script, 'api', 'repos/o/r/notifications?all=true&since=2026', '--include'),
    ).toMatchObject({ code: 0, stdout: '[]\n' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(await gh(root, script, 'api', 'repos/o/r/issues/12')).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(await gh(root, script, 'api', 'repos/o/r/issues/12/comments')).toMatchObject({ code: 1 })
  })
})

it("removes a daemon's socket directory outside its home, and never a Windows named pipe's", () => {
  expect(socketDirectoryOf('/tmp/agh-1a2b/agnesd.sock', '/srv/agent/.agh')).toBe('/tmp/agh-1a2b')
  expect(socketDirectoryOf('/srv/agent/.agh/daemon/agnesd.sock', '/srv/agent/.agh')).toBeUndefined()
  for (const pipe of ['\\\\.\\pipe\\agnes-1a2b', '//./pipe/agnes-1a2b', '\\\\?\\pipe\\agnes-1a2b'])
    expect(socketDirectoryOf(pipe, 'C:\\agh'), pipe).toBeUndefined()
})

describe('homes', () => {
  it('gives each home its own git identity and its own gh', async () => {
    const homes = makeHomes(scratch())
    const env = (home: string, bin: string) => ({
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
    })
    const operator = env(homes.operatorHome, homes.operatorBin)
    const agent = env(homes.agentHome, homes.shimsDir)
    expect((await run('git', ['config', 'user.name'], operator, homes.operatorHome)).stdout.trim()).toBe(
      'OPERATOR',
    )
    expect((await run('git', ['config', 'user.name'], agent, homes.agentHome)).stdout.trim()).toBe('AGENT')
    expect((await run('gh', [], operator)).stdout.trim()).toBe('OPERATOR-GH')
    // The agent's gh is the scripted fake; it carries its script and log paths, since a session shell has only PATH and HOME.
    expect((await run('gh', [], agent)).stdout.trim()).toBe('AGENT-GH')
    homes.writeGhScript({ login: 'someone', rules: [] })
    expect((await run('gh', ['api', 'user', '--jq', '.login'], agent)).stdout.trim()).toBe('someone')
    expect(homes.ghCalls().map((call) => call.argv.join(' '))).toEqual(['', 'api user --jq .login'])
  })
})

describe('authenticated git remote', () => {
  const users = {
    [AGENT_CREDENTIAL.user]: AGENT_CREDENTIAL.password,
    [OPERATOR_CREDENTIAL.user]: OPERATOR_CREDENTIAL.password,
  }

  it('answers 401 until credentials arrive, then takes a push and records who pushed', async () => {
    const root = scratch()
    const homes = makeHomes(join(root, 'homes'))
    const remote = await startGitHttpRemote({ users })
    cleanups.push(() => remote.close())
    homes.trustRemote(remote.url)
    const env = {
      PATH: process.env.PATH,
      HOME: homes.agentHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }
    const bare = { ...env, HOME: join(root, 'no-credentials') }
    mkdirSync(bare.HOME)

    const refused = await run('git', ['ls-remote', remote.url], bare)
    expect(refused.code, 'no credentials, no access').not.toBe(0)
    expect(remote.authLog().every((line) => line.startsWith('401 '))).toBe(true)
    expect(remote.authLog().length).toBeGreaterThan(0)

    const work = join(root, 'work')
    expect((await run('git', ['clone', '-q', remote.url, work], env)).code).toBe(0)
    writeFileSync(join(work, 'a.txt'), 'a\n')
    await run('git', ['checkout', '-q', '-b', 'agent/t1'], env, work)
    await run('git', ['add', 'a.txt'], env, work)
    await run('git', ['commit', '-q', '-m', 'a'], env, work)
    const pushed = await run('git', ['push', 'origin', 'agent/t1'], env, work)
    expect(pushed.code, pushed.stderr).toBe(0)

    expect(await remote.refs()).toEqual(['refs/heads/agent/t1', 'refs/heads/main'])
    expect(
      remote.authLog().filter((line) => line.includes('POST') && line.includes('git-receive-pack')),
    ).toEqual([`${AGENT_CREDENTIAL.user} POST /origin.git/git-receive-pack`])
    expect(remote.authLog().some((line) => line.startsWith(OPERATOR_CREDENTIAL.user))).toBe(false)
    expect(homes.markers()).toContain('AGENT get')
    expect(homes.markers().some((marker) => marker.startsWith('OPERATOR'))).toBe(false)
  })

  it('refuses a known user with the wrong password', async () => {
    const root = scratch()
    const remote = await startGitHttpRemote({ users })
    cleanups.push(() => remote.close())
    const authed = new URL(remote.url)
    authed.username = AGENT_CREDENTIAL.user
    authed.password = 'wrong'
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    expect((await run('git', ['ls-remote', authed.href], env)).code).not.toBe(0)
    expect(remote.authLog().every((line) => line.startsWith('401 '))).toBe(true)
    authed.password = AGENT_CREDENTIAL.password
    expect((await run('git', ['ls-remote', authed.href], env)).code).toBe(0)
    expect(remote.authLog().at(-1)).toMatch(new RegExp(`^${AGENT_CREDENTIAL.user} (GET|POST) `))
  })
})

describe('test channel', () => {
  const at = (n: number) => `2026-11-14T10:00:0${n}.000Z`
  const message = (id: string, chatId: string, n: number, threadId?: string): MessageEvent => ({
    kind: 'message',
    eventId: `e-${id}`,
    accountId: 'acct',
    chat: { id: chatId, type: 'group', ...(threadId ? { threadId } : {}) },
    sender: { userId: 'u1', raw: {} },
    at: at(n),
    messageId: id,
    text: `text ${id}`,
    attachments: [],
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  })
  const history = {
    c1: [
      message('m1', 'c1', 1),
      message('m2', 'c1', 2, 't1'),
      message('m3', 'c1', 3, 't1'),
      message('m4', 'c1', 4, 't1'),
      message('m5', 'c1', 5),
    ],
    c2: [message('n1', 'c2', 1)],
  }
  const members = { c1: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }], c3: [{ userId: 'z' }] }

  async function connected(script: Parameters<typeof createTestChannel>[0]) {
    const channel = createTestChannel(script)
    const adapter = (await channel.provider.create({ config: {} })) as ChannelAdapter
    const received: ChannelEvent[] = []
    const stop = new AbortController()
    await adapter.connect({
      credentials: {},
      signal: stop.signal,
      onEvent: (event) => received.push(event),
      log: { info() {}, warn() {}, error() {} },
    })
    cleanups.push(() => adapter.disconnect())
    return { channel, adapter, received }
  }
  /** Follows the cursor the way a host does until the last page. */
  async function all<T>(read: (cursor?: string) => Promise<{ rows: T[]; cursor?: string }>) {
    const rows: T[] = []
    let pages = 0
    for (let cursor: string | undefined; ; ) {
      const page = await read(cursor)
      rows.push(...page.rows)
      pages++
      if (page.cursor === undefined) return { rows, pages }
      cursor = page.cursor
    }
  }

  it('delivers scripted and emitted events to the subscriber and records sends', async () => {
    const first = message('s1', 'c1', 1)
    const { channel, adapter, received } = await connected({ events: [first], history: {}, members: {} })
    await Promise.resolve()
    expect(received).toEqual([first])
    const live = message('s2', 'c1', 2)
    channel.emit(live)
    expect(received).toEqual([first, live])
    const target = { chatId: 'c1', threadId: 't1' }
    const ref = await adapter.send(target, { blocks: [{ kind: 'text', markdown: 'hello' }] })
    expect(ref).toMatchObject({ chatId: 'c1' })
    expect(channel.sent()).toEqual([{ target, message: { blocks: [{ kind: 'text', markdown: 'hello' }] } }])
    await adapter.disconnect()
    channel.emit(message('s3', 'c1', 3))
    expect(received).toHaveLength(2)
  })

  it('declares every read and pages each one by cursor', async () => {
    const { channel, adapter } = await connected({ events: [], history, members })
    const reader = adapter as ChannelAdapter &
      Required<
        Pick<ChannelAdapter, 'fetchMessages' | 'listThread' | 'listHistory' | 'listChats' | 'listMembers'>
      >
    expect(adapter.capabilities().read).toEqual({
      messages: true,
      threads: true,
      history: true,
      chats: true,
      members: true,
    })
    const thread = await all(async (cursor) => {
      const page = await reader.listThread('c1', 't1', {
        order: 'desc',
        pageSize: 2,
        ...(cursor ? { cursor } : {}),
      })
      return { rows: page.events, ...(page.cursor ? { cursor: page.cursor } : {}) }
    })
    expect(thread.rows.map((row) => row.messageId)).toEqual(['m4', 'm3', 'm2'])
    expect(thread.pages).toBe(2)

    const window = await all(async (cursor) => {
      const page = await reader.listHistory('c1', { start: at(2), end: at(5), ...(cursor ? { cursor } : {}) })
      return { rows: page.events, ...(page.cursor ? { cursor: page.cursor } : {}) }
    })
    expect(window.rows.map((row) => row.messageId)).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(window.pages).toBe(2)

    const chats = await all(async (cursor) => {
      const page = await reader.listChats(cursor ? { cursor } : {})
      return { rows: page.chats, ...(page.cursor ? { cursor: page.cursor } : {}) }
    })
    expect(chats.rows.map((chat) => chat.id)).toEqual(['c1', 'c2', 'c3'])
    expect(chats.pages).toBe(2)

    const people = await all(async (cursor) => {
      const page = await reader.listMembers('c1', cursor ? { cursor } : {})
      return { rows: page.members, ...(page.cursor ? { cursor: page.cursor } : {}) }
    })
    expect(people.rows.map((member) => member.userId)).toEqual(['a', 'b', 'c'])

    expect((await reader.fetchMessages('c1', ['m1', 'm5', 'nope'])).map((row) => row.messageId)).toEqual([
      'm1',
      'm5',
    ])
    expect(channel.reads().filter((read) => read.method === 'listChats')).toEqual([
      { method: 'listChats' },
      { method: 'listChats', cursor: '2' },
    ])
  })
})

// Not on Windows: the parent's grandchild is `sleep`, and the fixture finds descendants in the table `ps` prints; on
// Windows the fixture ends a tree with taskkill instead.
posixDescribe('process tree', () => {
  it('kills the processes below a SIGKILLed parent by pid, which the parent would otherwise orphan', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        "const c = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const grandchild = await new Promise<number>((resolve, reject) => {
      parent.once('error', reject)
      parent.stdout.once('data', (data) => resolve(Number(String(data).trim())))
    })
    try {
      expect(isAlive(grandchild)).toBe(true)
      await killTree(parent, 'SIGKILL')
      for (let wait = 0; wait < 40 && isAlive(grandchild); wait++) await new Promise((r) => setTimeout(r, 50))
      expect(isAlive(grandchild)).toBe(false)
    } finally {
      if (isAlive(grandchild)) process.kill(grandchild, 'SIGKILL')
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    }
  })

  // The io below records instead of signalling, so these never touch a process that is not the test's own child.
  const recording = (tables: Map<number, { ppid: number; start: string }>[]) => {
    const calls: string[] = []
    const io: ProcessIo = {
      table: () => {
        calls.push('table')
        return tables.shift() ?? new Map()
      },
      kill: (pid, signal) => {
        calls.push(`kill ${pid} ${String(signal)}`)
      },
    }
    return { io, calls }
  }
  const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

  it('neither walks nor signals a child that has already exited (its pid may belong to someone else now)', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('exit', resolve))
    const { io, calls } = recording([new Map([[999_999, { ppid: child.pid as number, start: 'S' }]])])
    await killTree(child, 'SIGKILL', 10, io)
    expect(calls).toEqual([])
  })

  it('kills a descendant only while it is the same process that was recorded', async () => {
    const GONE = 999_998
    const REUSED = 999_999
    const parent = sleeper()
    const pid = parent.pid as number
    try {
      const recorded = new Map([
        [GONE, { ppid: pid, start: 'Mon 1' }],
        [REUSED, { ppid: pid, start: 'Mon 2' }],
      ])
      // After the parent exits: GONE is orphaned to init with its start time unchanged (still ours); REUSED is a
      // different process now (another start time), so it must be left alone.
      const after = new Map([
        [GONE, { ppid: 1, start: 'Mon 1' }],
        [REUSED, { ppid: 1, start: 'Tue 9' }],
      ])
      const { io, calls } = recording([recorded, after])
      await killTree(parent, 'SIGKILL', 10, io)
      expect(calls).toEqual(['table', 'table', `kill ${GONE} SIGKILL`])
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    }
  })
})

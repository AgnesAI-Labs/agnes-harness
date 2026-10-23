import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { thinkingMode } from '@agnes/cli-tui'
import { attachmentLink, rpcError } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { resourceCapabilityMissing } from '../../src/commands/resources.js'
import { type Colour, createAnsi } from '../../src/tui/ansi.js'
import { formatTuiErrorNotice, TuiApp } from '../../src/tui/app.js'
import {
  attachmentsFrom,
  completeToken,
  runSlash,
  SLASH_COMMANDS,
  slashCommand,
  slashCommandFor,
} from '../../src/tui/commands.js'
import { displayWidth, FakeTerminal } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { scriptedEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const FORKED_ID = 'agnes:local:default:cli:dm:main:thread:f1'

/**
 * A `TuiApp` never `start()`-ed: `runSlash` only ever touches `app.session` and
 * `app.session.client`, never the render/projection machinery, so the endpoint here answers
 * exactly what the twelve commands' real sdk calls need and nothing app.start() would additionally
 * require (no `_agnes/v1/session.projectUI` handler, in particular).
 */
async function unstartedApp(
  models: Array<{
    route: string
    id: string
    reasoning?: boolean
    thinkingLevelMap?: Record<string, string>
  }> = [
    { route: 'deepseek', id: 'deepseek-v4-flash' },
    { route: 'deepseek', id: 'deepseek-v4-pro' },
  ],
  composerSelectionPath?: string,
  themePreferencePath?: string,
) {
  const ep = scriptedEndpoint()
    .on('_agnes/v1/session.budget', () => ({
      state: null,
      ledger: [
        { seq: 1, credits: 3, creditSource: 'estimated' },
        { seq: 2, credits: 2, creditSource: 'gateway' },
      ],
    }))
    .on('_agnes/v1/session.setPreset', () => ({ effectiveFromSeq: 4 }))
    .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 9 }))
    .on('_agnes/v1/session.setYolo', () => ({ effectiveFromSeq: 7 }))
    .on('_agnes/v1/config.get', () => ({
      profile: 'local-dev',
      revision: 1,
      configured: true,
      effect: 'new-sessions',
      provider: {
        id: 'deepseek',
        route: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        credentialConfigured: true,
      },
    }))
    .on('_agnes/v1/session.projectUI', (params) => ({
      sessionId: (params as { sessionId: string }).sessionId,
      upto: 0,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        context: { tokens: 0, window: 128_000, autoCompact: true },
        model: { route: 'deepseek', id: 'deepseek-v4-flash', thinking: 'off' },
      },
    }))
    .on('_agnes/v1/apis.list', () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        models,
      },
      families: [],
    }))
    .on('_agnes/v1/session.list', () => ({
      items: [
        { sessionId: 's1', createdAt: '2026-01-01T00:00:00Z', lastSeq: 5, generation: 1, preset: 'standard' },
        { sessionId: 's2', createdAt: '2026-01-02T00:00:00Z', lastSeq: 9, generation: 1, preset: 'claw' },
      ],
    }))
    .on('_agnes/v1/submit', (params) =>
      (params as { kind?: string }).kind === 'fork'
        ? { replayed: false, result: { sessionId: FORKED_ID } }
        : { seq: 1, replayed: false },
    )
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 90, rows: 24 }, { TERM: 'xterm-256color' })
  const app = new TuiApp({
    session,
    term,
    header: 'Agnes',
    locale: 'zh-CN',
    ...(composerSelectionPath ? { composerSelectionPath } : {}),
    ...(themePreferencePath ? { themePreferencePath } : {}),
  })
  return { app, ep, client, term }
}

describe('SLASH_COMMANDS (cli 稿 §9.3 and PM7)', () => {
  it('names the session commands, plan mode and package controls', () => {
    expect(SLASH_COMMANDS).toHaveLength(57)
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      '/help',
      '/quit',
      '/new',
      '/resume',
      '/import',
      '/sessions',
      '/pin',
      '/unpin',
      '/rename',
      '/archive',
      '/search',
      '/cost',
      '/usage',
      '/computer-use',
      '/doctor',
      '/rewind',
      '/undo',
      '/compact',
      '/goal',
      '/plan',
      '/preset',
      '/theme',
      '/notify',
      '/keys',
      '/mouse',
      '/thinking',
      '/model',
      '/yolo',
      '/grants',
      '/deliverables',
      '/attach',
      '/paste',
      '/schedule',
      '/loop',
      '/export',
      '/rate',
      '/heads-up',
      '/refine',
      '/packages',
      '/install',
      '/package',
      '/skills',
      '/skill',
      '/mcp',
      '/context',
      '/agents',
      '/jobs',
      '/queue',
      '/status',
      '/copy',
      '/diff',
      '/init',
      '/review',
      '/terminal-setup',
      '/bg',
      '/memory',
      '/btw',
    ])
  })

  it('carries an args shape for commands that take one and a description for all', () => {
    expect(slashCommand('/resume')?.args).toBe('[id|all]')
    expect(slashCommand('/rewind')?.args).toBe('[seq]')
    expect(slashCommand('/compact')?.args).toBe('[instructions]')
    expect(slashCommand('/plan')?.args).toBe('[on|off|status|pending|instruction]')
    expect(slashCommand('/preset')?.args).toBe('<name>')
    expect(slashCommand('/theme')?.args).toBe('[auto|light|dark|mono]')
    expect(slashCommand('/model')?.args).toBe('[<slot> <route>/<model> [<thinking>]]')
    expect(slashCommand('/install')?.args).toBe('<source>|confirm|cancel')
    expect(slashCommand('/package')?.args).toContain('rollback')
    expect(slashCommand('/skill')?.args).toBe('invoke <name> [arguments]|refresh|trust ...')
    expect(slashCommand('/agents')?.args).toBe('[stop <n|id>|resume <n|id> <message>]')
    expect(slashCommand('/jobs')?.args).toBe('[stop <n|id>]')
    expect(slashCommand('/queue')?.args).toBe('[edit|drop|now|steer <n>]')
    expect(slashCommand('/copy')?.args).toBe('[n|code]')
    expect(slashCommand('/diff')?.args).toBe('[turn] [path]')
    // Commands without arguments carry no shape at all, and an unknown name finds nothing.
    expect(slashCommand('/help')?.args).toBeUndefined()
    expect(slashCommand('/nope')).toBeUndefined()
    for (const c of SLASH_COMMANDS)
      expect(slashCommandFor(c.name, 'zh-CN')?.description.length).toBeGreaterThan(0)
    // Every command carries a one-line summary in both locales: <= 28 columns, args-free.
    for (const locale of ['en', 'zh-CN'])
      for (const c of SLASH_COMMANDS) {
        const summary = slashCommandFor(c.name, locale)?.summary ?? ''
        expect(summary.length, `${locale} ${c.name}`).toBeGreaterThan(0)
        expect(displayWidth(summary), `${locale} ${c.name}`).toBeLessThanOrEqual(28)
        expect(summary, `${locale} ${c.name}`).not.toContain('<')
        if (locale === 'zh-CN') expect([...summary].length, c.name).toBeLessThanOrEqual(14)
      }
  })
})

describe('runSlash', () => {
  it('uses the app locale for the context command', async () => {
    const app = {
      locale: 'zh-CN',
      session: {
        client: {},
        projectUIOpening: async () => ({ timeline: { nodes: [] } }),
      },
    } as unknown as TuiApp

    await expect(runSlash(app, '/context')).resolves.toMatchObject({ title: '上下文分解' })
  })

  it('/theme menu selects, repaints and persists across TUI instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-theme-app-'))
    const path = join(dir, 'tui-theme.json')
    const first = await unstartedApp(undefined, undefined, path)
    try {
      await first.app.start()
      await first.app.runInput('/theme')
      expect((await screenOf(first.term, 90, 24)).join('\n')).toContain('当前')
      // Auto is the default and heads the list, so one step down is light.
      first.term.feed('\x1b[B')
      first.term.feed('\r')
      await vi.waitFor(() => expect(first.app.themeName).toBe('light'))
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'light' })
      expect(first.term.writes.join('')).toContain(
        createAnsi('256')
          .bg(new TuiTheme('light').colour('bg') as Colour, '')
          .slice(0, -'\x1b[49m'.length),
      )
      const second = await unstartedApp(undefined, undefined, path)
      try {
        expect(second.app.themeName).toBe('light')
        await expect(runSlash(second.app, '/theme mono')).resolves.toEqual({ text: 'theme mono · 已保存' })
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'mono' })
      } finally {
        await second.client.close()
        await second.ep.close()
      }
    } finally {
      await first.app.stop()
      await first.client.close()
      await first.ep.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('/keys opens the effective bindings in a panel', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      const r = await runSlash(app, '/keys')
      expect(r).toMatchObject({ details: true, title: '键位' })
      expect(r.text).toMatch(/cut-to-end\s+ctrl-k/)
    } finally {
      await client.close()
      await ep.close()
    }
  })
  it('/theme reports and switches the current TUI presentation without touching the session', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      await expect(runSlash(app, '/theme')).resolves.toEqual({})
      await expect(runSlash(app, '/theme dark')).resolves.toMatchObject({
        text: 'theme dark · 未能保存偏好，仅本次生效',
      })
      expect(app.themeName).toBe('dark')
      await expect(runSlash(app, '/theme neon')).resolves.toMatchObject({
        text: 'usage: /theme [auto|light|dark|mono]',
      })
      expect(ep.calls.some((call) => call.method.includes('theme'))).toBe(false)
    } finally {
      await client.close()
      await ep.close()
    }
  })

  it('/mouse switches mouse reporting off and on for this run and says what changed', async () => {
    const { app, client } = await unstartedApp()
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    const running = new TuiApp({ session: app.session, term, header: 'Agnes' })
    try {
      await running.start()
      const off = '\x1b[?1006l\x1b[?1002l'
      const on = '\x1b[?1002h\x1b[?1006h'
      const writes = () => term.writes.join('')
      expect(writes().split(on)).toHaveLength(2)
      await expect(runSlash(running, '/mouse')).resolves.toMatchObject({
        text: expect.stringContaining('off'),
      })
      expect(writes().split(off)).toHaveLength(2)
      await expect(runSlash(running, '/mouse')).resolves.toMatchObject({
        text: expect.stringContaining('on:'),
      })
      expect(writes().split(on)).toHaveLength(3)
      expect(writes().indexOf(off)).toBeLessThan(writes().lastIndexOf(on))
    } finally {
      await running.stop()
      await client.close()
    }
  })

  it('starts with mouse reporting off when the option says so, and /mouse still turns it on', async () => {
    const { app, client } = await unstartedApp()
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    const running = new TuiApp({ session: app.session, term, header: 'Agnes', mouse: false })
    try {
      await running.start()
      const on = '\x1b[?1002h\x1b[?1006h'
      const writes = () => term.writes.join('')
      expect(writes()).not.toContain(on)
      await expect(runSlash(running, '/mouse')).resolves.toMatchObject({
        text: expect.stringContaining('on:'),
      })
      expect(writes().split(on)).toHaveLength(2)
    } finally {
      await running.stop()
      await client.close()
    }
  })

  it('/thinking toggles whether thoughts stay open, for this run only', async () => {
    const { app, client } = await unstartedApp()
    try {
      expect(thinkingMode.expanded).toBe(false)
      await expect(runSlash(app, '/thinking')).resolves.toMatchObject({
        text: expect.stringContaining('展开'),
      })
      expect(thinkingMode.expanded).toBe(true)
      await expect(runSlash(app, '/thinking')).resolves.toMatchObject({
        text: expect.stringContaining('收起'),
      })
      expect(thinkingMode.expanded).toBe(false)
    } finally {
      thinkingMode.expanded = false
      await client.close()
    }
  })

  it('brings the persisted prompt history back on the next run and records new prompts', async () => {
    const { app, client } = await unstartedApp()
    const dir = mkdtempSync(join(tmpdir(), 'agh-tui-history-'))
    const historyPath = join(dir, 'tui-history.jsonl')
    writeFileSync(historyPath, '{"text":"left over from yesterday"}\n')
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    const running = new TuiApp({ session: app.session, term, header: 'Agnes', historyPath })
    try {
      await running.start()
      term.feed('\x1b[A')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 60, 20)).join('\n')).toContain('left over from yesterday'),
      )
      term.feed('\x1b')
      for (const ch of '/mouse') term.feed(ch)
      term.feed('\r')
      await vi.waitFor(() => expect(readFileSync(historyPath, 'utf8')).toContain('"text":"/mouse"'))
    } finally {
      await running.stop()
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses only the injected resource port and keeps permission failures visible', async () => {
    const { app, client } = await unstartedApp()
    const execute = vi.fn(async () => ({ text: 'skill list' }))
    const controlled = new TuiApp({
      session: app.session,
      term: new FakeTerminal({ columns: 60, rows: 20 }),
      header: 'Agnes',
      profile: 'local-dev',
      resourceController: { execute },
    })
    try {
      await expect(runSlash(controlled, '/skills')).resolves.toMatchObject({ text: 'skill list' })
      expect(execute).toHaveBeenCalledWith('resources', 'local-dev', ['list', '--kind', 'skill'])

      execute.mockRejectedValueOnce({ data: { code: 'CAPABILITY_DENIED' } })
      await expect(runSlash(controlled, '/skills')).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    } finally {
      await client.close()
    }
  })

  it('identifies only an absent resource surface as old-daemon compatibility', () => {
    for (const code of ['METHOD_NOT_FOUND', 'RESOURCE_METHOD_UNAVAILABLE', 'unsupported'])
      expect(resourceCapabilityMissing({ data: { code } })).toBe(true)
    for (const code of ['CAPABILITY_DENIED', 'PROFILE_SCOPE', 'REVISION_CONFLICT', 'SECRET_UNAVAILABLE'])
      expect(resourceCapabilityMissing({ data: { code } })).toBe(false)
  })

  it('keeps resource commands out of chat when this Daemon has no resource capability', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      await expect(runSlash(app, '/skills')).resolves.toMatchObject({
        text: 'resource control is not supported by this Daemon',
      })
      expect(ep.calls.some((call) => call.method === 'session/prompt')).toBe(false)
    } finally {
      await client.close()
    }
  })
  it('/agents reads session.controls and sends stop and resume as child controls on the wire', async () => {
    const { app, client, ep } = await unstartedApp()
    const child = (id: string, status: string, controls = { stop: true, continue: true }) => ({
      id,
      parentId: 'cur',
      providerId: 'codex',
      status,
      controls,
      durationMs: 12_345,
      totalTokens: null,
    })
    ep.on('_agnes/v1/session.controls', () => ({
      controls: {},
      paused: false,
      pending: [],
      children: [
        child('child-a', 'running'),
        child('child\u001b[31m-b', 'idle', { stop: false, continue: true }),
      ],
    }))
    try {
      const listed = await runSlash(app, '/agents')
      expect(listed.text).toBe(
        [
          '1. child-a [running] codex · 12.3s · - Token · stop resume',
          '2. child[31m-b [idle] codex · 12.3s · - Token · resume',
        ].join('\n'),
      )
      // Stop and resume take a list number or an id; the resume message keeps its inner whitespace.
      await runSlash(app, '/agents stop 1')
      await runSlash(app, '/agents resume child-a  keep going\nplease')
      const sent = ep.calls.filter((call) => call.method === '_agnes/v1/submit').map((call) => call.params)
      expect(sent).toMatchObject([
        { kind: 'control', payload: { action: 'child-stop', childId: 'child-a' } },
        {
          kind: 'control',
          payload: { action: 'child-continue', childId: 'child-a', text: 'keep going\nplease' },
        },
      ])
      // Usage mistakes and unknown targets never reach the daemon.
      const before = ep.calls.length
      for (const line of ['/agents stop', '/agents stop 1 extra', '/agents resume 1', '/agents jump 1'])
        expect((await runSlash(app, line)).text).toBe(
          '用法：/agents [stop <序号|id> | resume <序号|id> <消息>]',
        )
      expect(ep.calls.length).toBe(before)
      expect((await runSlash(app, '/agents stop 9')).text).toBe('没有子智能体 9')
      expect(ep.calls.filter((call) => call.method === '_agnes/v1/submit')).toHaveLength(2)
    } finally {
      await client.close()
      await ep.close()
    }
  })

  it('/jobs reads session.jobs.read and kills through session.jobs.control, showing refusals', async () => {
    const { app, client, ep, term } = await unstartedApp()
    const job = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      owner: 'human',
      ownerSessionId: 'cur',
      kind: 'shell',
      command: `npm run \u001b[31m${id}\n${'x'.repeat(100)}`,
      cwd: '/tmp',
      status: 'running',
      code: null,
      truncated: false,
      ...over,
    })
    const jobs = [job('dev'), job('lint', { status: 'completed', code: 0, owner: 'agent' })]
    ep.on('_agnes/v1/session.jobs.read', () => ({ jobs, completions: [] }))
    ep.on('_agnes/v1/session.jobs.control', (params) => {
      if ((params as { jobId?: string }).jobId === 'lint')
        throw rpcError('CAPABILITY_DENIED', { code: 'CAPABILITY_DENIED' })
      return { output: job('dev', { status: 'killed', code: null }) }
    })
    try {
      const rows = (await runSlash(app, '/jobs')).text?.split('\n') ?? []
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatch(/^1\. npm run \[31mdev x{63}… \[running\] · shell · human$/)
      expect(rows[1]).toMatch(/\[completed\] · shell · agent · 退出码 0$/)
      expect((await runSlash(app, '/jobs stop 1')).text).toBe('已请求终止任务 dev')
      expect((await runSlash(app, '/jobs stop dev')).text).toBe('已请求终止任务 dev')
      const controls = ep.calls.filter((call) => call.method === '_agnes/v1/session.jobs.control')
      expect(controls.map((call) => call.params)).toMatchObject([
        { operation: 'kill', jobId: 'dev', sessionId: app.session.id },
        { operation: 'kill', jobId: 'dev', sessionId: app.session.id },
      ])
      expect(ep.calls.find((call) => call.method === '_agnes/v1/session.jobs.read')?.params).toEqual({
        sessionId: app.session.id,
      })
      for (const line of ['/jobs stop', '/jobs kill 1', '/jobs stop 1 2'])
        expect((await runSlash(app, line)).text).toBe('用法：/jobs [stop <序号|id>]')
      expect((await runSlash(app, '/jobs stop 0')).text).toBe('没有任务 0')
      expect(ep.calls.filter((call) => call.method === '_agnes/v1/session.jobs.control')).toHaveLength(2)
      // The daemon refuses a job an agent owns; the refusal surfaces as the standard error notice.
      await app.start()
      await app.runInput('/jobs stop lint')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 24)).join('\n')).toContain(
          formatTuiErrorNotice(rpcError('CAPABILITY_DENIED', { code: 'CAPABILITY_DENIED' }), 'zh-CN'),
        ),
      )
      ep.on('_agnes/v1/session.jobs.read', () => ({ jobs: [], completions: [] }))
      expect((await runSlash(app, '/jobs')).text).toBe('没有后台任务')
    } finally {
      await app.stop()
      await client.close()
      await ep.close()
    }
  })

  it('/queue lists the daemon queue, including what Alt+Enter steered in, without sending anything', async () => {
    const { app, client, ep, term } = await unstartedApp()
    try {
      ep.on('_agnes/v1/session.controls', () => ({
        controls: { steer: true },
        paused: false,
        pending: [
          {
            itemId: 'a',
            target: 'next-turn',
            kind: 'follow_up',
            content: [{ type: 'text', text: 'first message' }],
          },
          {
            itemId: 'b',
            target: 'next-step',
            kind: 'steer',
            content: [{ type: 'text', text: 'second\nmessage' }],
          },
        ],
      }))
      await app.start()
      const before = ep.calls.length
      await app.runInput('/queue')
      await vi.waitFor(async () => {
        const screen = (await screenOf(term, 90, 24)).join('\n')
        expect(screen).toContain('1. first message')
        expect(screen).toContain('2. second message')
      })
      expect(
        ep.calls.slice(before).filter((call) => /submit|prompt|control$|queue/i.test(call.method)),
      ).toEqual([])
    } finally {
      await app.stop()
      await client.close()
      await ep.close()
    }
  })

  it('/agents shows a daemon refusal through the standard error notice and changes nothing else', async () => {
    const { app, client, ep, term } = await unstartedApp()
    const refusal = rpcError('SEMANTIC_REJECTED', { code: 'CONTROL_NOT_RUNNING' })
    ep.on('_agnes/v1/session.controls', () => ({
      controls: {},
      paused: false,
      pending: [],
      children: [
        {
          id: 'child-a',
          parentId: 'cur',
          providerId: 'codex',
          status: 'completed',
          controls: { stop: true, continue: false },
          durationMs: null,
          totalTokens: 7,
        },
      ],
    })).on('_agnes/v1/submit', () => {
      throw refusal
    })
    try {
      await app.start()
      await app.runInput('/agents stop child-a')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 24)).join('\n')).toContain(formatTuiErrorNotice(refusal, 'zh-CN')),
      )
    } finally {
      await app.stop()
      await client.close()
      await ep.close()
    }
  })

  it('/help lists the command table with descriptions; /quit signals quit; unknown names say so', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      const help = await runSlash(app, '/help')
      for (const cmd of SLASH_COMMANDS) expect(help.text).toContain(cmd.name)
      expect(help.presentation).toBe('transcript')
      expect(help.text).toContain('斜杠命令')
      // The help line carries the one-line description, not just the name.
      expect(help.text).toContain('退出')
      expect(await runSlash(app, '/quit')).toEqual({ quit: true })
      const unknown = await runSlash(app, '/nope')
      expect(unknown.text).toContain('unknown')
      expect(unknown.text).toContain('/help')
      expect(unknown.text).not.toContain('/packages')
      const singular = await runSlash(app, '/session')
      expect(singular.text).toBe('unknown command /session; did you mean /sessions?')
      expect((await runSlash(app, '/modl')).text).toBe('unknown command /modl; did you mean /model?')
      expect((await runSlash(app, '/zzzzzz')).text).toContain('use /help')
      expect(ep.calls.some((call) => call.method === 'session/load')).toBe(false)
      expect(ep.calls.some((call) => call.method === '_agnes/v1/session.attach')).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('keeps cancelled and malformed package controls out of the session submit path', async () => {
    const { app, client, ep } = await unstartedApp()
    const controlled = new TuiApp({
      session: app.session,
      term: new FakeTerminal({ columns: 60, rows: 20 }),
      header: 'Agnes',
      controlClient: client,
    })
    try {
      await expect(runSlash(controlled, '/install cancel')).resolves.toMatchObject({
        text: 'Installation cancelled.',
      })
      await expect(runSlash(controlled, '/install http://untrusted.example/package')).rejects.toThrow(
        /Use a git HTTPS URL, folder\/archive path, or npm:package@version/,
      )
      expect(ep.calls.filter((call) => call.method === '_agnes/v1/submit')).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('/new applies the remembered model and routine approval bypass before switching', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agh-composer-')), 'composer-selection.json')
    writeFileSync(
      path,
      JSON.stringify({
        model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'medium' },
        permission: 'full',
      }),
    )
    const { app, ep, client } = await unstartedApp(
      [
        { route: 'deepseek', id: 'deepseek-v4-flash' },
        { route: 'deepseek', id: 'deepseek-v4-pro' },
      ],
      path,
    )
    try {
      const created = await runSlash(app, '/new')
      expect(created.text).toBe('新会话使用 deepseek/deepseek-v4-pro · medium · 跳过普通审批')
      expect(created.switchSession?.id).toBeDefined()
      const modelCall = ep.calls.find((entry) => entry.method === '_agnes/v1/session.setModel')
      expect(modelCall?.params).toMatchObject({
        sessionId: created.switchSession?.id,
        slot: 'primary',
        route: 'deepseek',
        model: 'deepseek-v4-pro',
        thinking: 'medium',
      })
      expect(ep.calls.find((entry) => entry.method === '_agnes/v1/session.setYolo')?.params).toMatchObject({
        sessionId: created.switchSession?.id,
        enabled: true,
      })
      await runSlash(app, '/model primary deepseek/deepseek-v4-flash high')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        model: { route: 'deepseek', id: 'deepseek-v4-flash', thinking: 'high' },
        permission: 'full',
      })
    } finally {
      await client.close()
    }
  })

  it('/new and /resume<id> return a loaded Session switch without touching app.session itself', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      const created = await runSlash(app, '/new')
      expect(created.switchSession?.id).toBeDefined()
      const newCall = ep.calls.filter((entry) => entry.method === 'session/new').at(-1)
      expect(newCall?.params).toMatchObject({
        _meta: {
          'ai.agnes.harness': {
            sessionKey: expect.stringMatching(/^agnes:local:Agnes:cli:session:[0-9a-f-]{36}$/),
          },
        },
      })
      const resumed = await runSlash(app, '/resume other-id')
      expect(resumed.switchSession?.id).toBe('other-id')
      expect(ep.calls.find((entry) => entry.method === 'session/load')?.params).toMatchObject({
        sessionId: 'other-id',
        cwd: process.cwd(),
      })
      expect(ep.calls.some((entry) => entry.method === '_agnes/v1/session.attach')).toBe(false)
      // runSlash is a pure dispatch: it never mutates the app it was handed. Only TuiApp.command()
      // (wired in app.ts) applies a returned switchSession back onto `app.session`.
      expect(app.session.id).not.toBe('other-id')
    } finally {
      await client.close()
    }
  })

  it('/resume with no id returns newest-first choices without loading one', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      const r = await runSlash(app, '/resume')
      expect(r.sessionChoices?.map((choice) => choice.sessionId)).toEqual(['s2', 's1'])
      expect(r.switchSession).toBeUndefined()
      expect(ep.calls.find((entry) => entry.method === '_agnes/v1/session.list')?.params).toEqual({
        limit: 500,
      })
      expect(ep.calls.some((entry) => entry.method === 'session/load')).toBe(false)
      expect(ep.calls.some((entry) => entry.method === '_agnes/v1/session.attach')).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('/resume pages and sorts historical choices while excluding the session already open', async () => {
    const { app, client, ep } = await unstartedApp()
    ep.on('_agnes/v1/session.list', (params) => {
      const cursor = (params as { cursor?: string }).cursor
      return cursor === 'page-2'
        ? {
            items: [
              {
                sessionId: 'newest-history',
                createdAt: '2026-03-01T00:00:00Z',
                lastSeq: 12,
                generation: 1,
                preset: 'standard',
              },
            ],
          }
        : {
            items: [
              {
                sessionId: app.session.id,
                createdAt: '2026-04-01T00:00:00Z',
                lastSeq: 0,
                generation: 1,
                preset: 'standard',
              },
              {
                sessionId: 'older-history',
                createdAt: '2026-01-01T00:00:00Z',
                // Created first but active last: the picker orders by activity, not creation.
                lastMessageAt: '2026-05-01T00:00:00Z',
                lastSeq: 4,
                generation: 1,
                preset: 'standard',
              },
            ],
            next: 'page-2',
          }
    })
    try {
      const result = await runSlash(app, '/resume')
      expect(result.sessionChoices?.map((choice) => choice.sessionId)).toEqual([
        'older-history',
        'newest-history',
      ])
      expect(result.sessionScope?.scope).toBe('workspace')
      expect(ep.calls.filter((entry) => entry.method === '_agnes/v1/session.list')).toHaveLength(2)
      expect(ep.calls.some((entry) => entry.method === 'session/load')).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('/resume reports no other sessions when the listing only contains the current one', async () => {
    const { app, client, ep } = await unstartedApp()
    ep.on('_agnes/v1/session.list', () => ({
      items: [
        {
          sessionId: app.session.id,
          createdAt: '2026-09-13T14:00:00Z',
          lastSeq: 0,
          generation: 1,
          preset: 'standard',
        },
      ],
    }))
    try {
      expect(await runSlash(app, '/resume')).toEqual({ text: 'no other sessions in this workspace' })
      expect(ep.calls.some((entry) => entry.method === 'session/load')).toBe(false)
    } finally {
      await client.close()
    }
  })

  // Real-machine: picking another workspace's session answered "Request failed (ID_CONFLICT)", because
  // daemon refuses to load a session from a workspace other than the one it is bound to.
  it('/resume offers only sessions bound to the open session workspace, plus unbound ones', async () => {
    const { app, client, ep } = await unstartedApp()
    const row = (sessionId: string, day: string, cwd?: string) => ({
      sessionId,
      createdAt: `2026-01-${day}T00:00:00Z`,
      lastSeq: 1,
      generation: 1,
      preset: 'standard',
      ...(cwd ? { cwd } : {}),
    })
    ep.on('_agnes/v1/session.list', () => ({
      items: [
        row(app.session.id, '05', '/canonical/here'),
        row('same-root', '04', '/canonical/here'),
        row('other-root', '03', '/canonical/elsewhere'),
        row('raw-cwd-only', '02', process.cwd()),
        row('unbound', '01'),
      ],
    }))
    try {
      const result = await runSlash(app, '/resume')
      expect(result.sessionChoices?.map((choice) => choice.sessionId)).toEqual(['same-root', 'unbound'])
      // `/sessions` stays the read-only list of every workspace.
      expect((await runSlash(app, '/sessions')).text).toContain('other-root')
    } finally {
      await client.close()
    }
  })

  it('/resume falls back to the TUI cwd when the open session row carries no workspace', async () => {
    const { app, client, ep } = await unstartedApp()
    ep.on('_agnes/v1/session.list', () => ({
      items: [
        {
          sessionId: 'here',
          createdAt: '2026-01-02T00:00:00Z',
          lastSeq: 1,
          generation: 1,
          preset: 'standard',
          cwd: process.cwd(),
        },
        {
          sessionId: 'there',
          createdAt: '2026-01-01T00:00:00Z',
          lastSeq: 1,
          generation: 1,
          preset: 'standard',
          cwd: '/elsewhere',
        },
      ],
    }))
    try {
      expect((await runSlash(app, '/resume')).sessionChoices?.map((choice) => choice.sessionId)).toEqual([
        'here',
      ])
    } finally {
      await client.close()
    }
  })

  it('/sessions formats the listed page; empty page says so', async () => {
    const { app, client } = await unstartedApp()
    try {
      const r = await runSlash(app, '/sessions')
      expect(r).toEqual({
        text: 'Recent sessions\n1. claw · seq 9\n   s2\n2. standard · seq 5\n   s1',
        presentation: 'transcript',
      })
    } finally {
      await client.close()
    }
  })

  it.each(['/cost', '/usage'])(
    '%s reads the bounded daemon projection instead of summing truncated budget rows',
    async (command) => {
      const ep = scriptedEndpoint()
        .on('_agnes/v1/session.projectUI', () => ({
          sessionId: 'agnes:local:default:cli:dm:main',
          upto: 0,
          generation: 1,
          opState: null,
          turns: [],
          nodes: [],
          usage: {
            totals: { input: 12345, output: 50, cacheRead: 5, cacheWrite: 0, reasoning: 0 },
            reasoningComplete: false,
            context: { tokens: 321, window: 128000, autoCompact: true },
            model: { route: 'openai', id: 'm', thinking: 'off' },
          },
        }))
        .on('_agnes/v1/session.budget', () => {
          throw new Error('must not sum the recent budget page')
        })
      const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
      try {
        const session = await client.session.new({ cwd: '/tmp' })
        const app = new TuiApp({
          session,
          term: new FakeTerminal({ columns: 60, rows: 20 }),
          header: 'Agnes',
          locale: 'zh-CN',
        })
        const result = await runSlash(app, command)
        expect(result.details).toBe(true)
        expect(result.text).toContain('12345')
        expect(result.text).toContain('321 / 128000')
        expect(result.text).toContain('累计美元费用：未提供')
        expect(result.text).toContain('未完整提供')
      } finally {
        await client.close()
      }
    },
  )

  it('/rewind forks through the real wire call and returns the forked session; rejects a bad seq', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      const r = await runSlash(app, '/rewind 3')
      expect(r.switchSession?.id).toBe(FORKED_ID)
      expect(ep.calls.some((c) => c.method === '_agnes/v1/submit')).toBe(true)
      expect((await runSlash(app, '/rewind nope')).text).toContain('usage')
    } finally {
      await client.close()
    }
  })

  it('/preset requires a name and switches through the real setPreset call', async () => {
    const { app, client } = await unstartedApp()
    try {
      expect((await runSlash(app, '/preset')).text).toContain('usage')
      expect((await runSlash(app, '/preset claw')).text).toBe('preset claw from seq 4')
    } finally {
      await client.close()
    }
  })

  it('/yolo switches on through the real setYolo call', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      expect((await runSlash(app, '/yolo')).text).toBe(
        'routine approvals skipped from seq 7; the current preset and its domain confirmations remain in effect. Explicit denies, OS permissions and command sandbox limits still apply. /yolo off asks again.',
      )
      expect(ep.calls.find((entry) => entry.method === '_agnes/v1/session.setYolo')?.params).toEqual({
        sessionId: app.session.id,
        enabled: true,
      })
    } finally {
      await client.close()
    }
  })

  it('/model lists published choices (with reasoning/thinkingLevelMap) while the explicit form still switches directly', async () => {
    const { app, client } = await unstartedApp([
      { route: 'deepseek', id: 'deepseek-v4-flash' },
      { route: 'deepseek', id: 'deepseek-v4-pro', reasoning: true, thinkingLevelMap: { high: 'high' } },
    ])
    try {
      expect((await runSlash(app, '/model')).modelChoices).toEqual([
        { route: 'deepseek', model: 'deepseek-v4-flash', reasoning: false },
        { route: 'deepseek', model: 'deepseek-v4-pro', reasoning: true, thinkingLevelMap: { high: 'high' } },
      ])
      expect((await runSlash(app, '/model badformat')).text).toContain('usage')
      expect((await runSlash(app, '/model primary anthropic/claude-3-x')).text).toBe('model from seq 9')
      expect((await runSlash(app, '/model primary anthropic/claude-3-x high')).text).toBe('model from seq 9')
    } finally {
      await client.close()
    }
  })

  it('/model does not open an empty picker when the current profile publishes no models', async () => {
    const { app, client } = await unstartedApp([])
    try {
      expect(await runSlash(app, '/model')).toEqual({ text: 'no models available in the current profile' })
    } finally {
      await client.close()
    }
  })

  it('/compact submits one typed manual request with optional instructions', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      expect((await runSlash(app, '/compact keep recent')).text).toBe(
        'compaction result is unknown; session history was preserved',
      )
      expect(ep.calls.find((call) => call.method === '_agnes/v1/submit')?.params).toMatchObject({
        kind: 'compact',
        payload: { sessionId: app.session.id, instructions: 'keep recent' },
      })
    } finally {
      await client.close()
    }
  })

  it('/compact calls only an explicit completed acknowledgement completed', async () => {
    const { app, ep, client } = await unstartedApp()
    ep.on('_agnes/v1/submit', () => ({
      seq: 1,
      replayed: false,
      compact: { state: 'completed', endSeq: 1 },
    }))
    try {
      expect((await runSlash(app, '/compact')).text).toBe('compaction completed at seq 1')
    } finally {
      await client.close()
    }
  })

  it('/export has no daemon call of its own: it says so without a CLI-injected writer and hands the request to one', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      const before = ep.calls.length
      expect((await runSlash(app, '/export --html')).text).toMatch(/--connect/)
      const requests: unknown[] = []
      Object.assign(app.o, { exportSession: async (request: unknown) => void requests.push(request) })
      const r = await runSlash(app, '/export html out.html')
      expect(requests).toEqual([
        { sessionId: app.session.id, format: 'html', out: expect.stringMatching(/out\.html$/) },
      ])
      expect(r.text).toContain('out.html')
      expect(ep.calls.length).toBe(before)
    } finally {
      await client.close()
    }
  })

  // Honesty note: `harness/refine` is a raw ledger event type with no projected UINode kind, so
  // this reports the gap directly rather than silently returning "no proposals" forever by
  // filtering a UINode kind that can never match.
  it('/refine reports the real gap instead of a silently-always-empty search', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      const before = ep.calls.length
      const r = await runSlash(app, '/refine')
      expect(r.text).toMatch(/not projected/)
      expect(ep.calls.length).toBe(before)
    } finally {
      await client.close()
    }
  })
})

describe('completeToken', () => {
  it('matches commands; an unmatched prefix returns empty, not everything', () => {
    // Exact single match.
    expect(completeToken('/he')).toEqual(['/help', '/heads-up'])
    // Reverse-verification (required): a prefix matching nothing returns an empty list, never the
    // full table.
    expect(completeToken('/zzzz')).toEqual([])
    // A prefix shared by several commands returns all of them, not one arbitrarily.
    expect(completeToken('/re')).toEqual(['/resume', '/rename', '/rewind', '/refine', '/review'])
    // '@' mentions have their own menu; a plain word has nothing to complete against.
    expect(completeToken('@REA')).toEqual([])
    expect(completeToken('plain')).toEqual([])
  })
})

describe('attachmentsFrom', () => {
  const workspace = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-mentions-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'with space.md'), 'x')
    mkdirSync(join(dir, 'b'))
    writeFileSync(join(dir, 'b', 'c.txt'), 'x')
    return dir
  }

  it('links each @path that exists, in order, by absolute file URI, and strips the @ from the text', () => {
    const dir = workspace()
    try {
      expect(attachmentsFrom('look at @a.txt and @b/c.txt please', dir)).toEqual([
        { type: 'text', text: 'look at a.txt and b/c.txt please' },
        { type: 'resource_link', uri: pathToFileURL(join(dir, 'a.txt')).href, name: 'a.txt' },
        { type: 'resource_link', uri: pathToFileURL(join(dir, 'b', 'c.txt')).href, name: 'b/c.txt' },
      ])
      // Over --connect the local disk is not the workspace: the text goes as typed, with no file:// link.
      expect(attachmentsFrom('look at @a.txt', dir, true)).toEqual([{ type: 'text', text: 'look at @a.txt' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks a folder and reads a quoted path with spaces', () => {
    const dir = workspace()
    try {
      expect(attachmentsFrom('@b/ and @"with space.md"', dir)).toEqual([
        { type: 'text', text: 'b/ and with space.md' },
        {
          type: 'resource_link',
          uri: pathToFileURL(join(dir, 'b')).href,
          name: 'b/',
          mimeType: 'inode/directory',
        },
        { type: 'resource_link', uri: pathToFileURL(join(dir, 'with space.md')).href, name: 'with space.md' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves text alone when the @ starts no word or names nothing', () => {
    const dir = workspace()
    try {
      const text = 'mail a@a.txt, ask @alice, no attachments here'
      expect(attachmentsFrom(text, dir)).toEqual([{ type: 'text', text }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('app.ts wiring: key routing through the editor reaches the real command/completion path', () => {
  async function liveApp(extra?: (ep: ReturnType<typeof scriptedEndpoint>) => void) {
    const ep = scriptedEndpoint()
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: 'agnes:local:default:cli:dm:main',
        upto: 0,
        generation: 1,
        opState: null,
        turns: [],
        nodes: [],
      }))
      .on('_agnes/v1/session.budget', () => ({
        state: null,
        ledger: [{ seq: 1, credits: 5, creditSource: 'gateway' }],
      }))
    extra?.(ep)
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 40, rows: 12 })
    const app = new TuiApp({ session, term, header: 'Agnes', locale: 'zh-CN' })
    await app.start()
    return { app, term, client }
  }

  it('typing "/quit" and Enter reaches command() and calls onQuit', async () => {
    const { app, term, client } = await liveApp()
    try {
      const quit = vi.fn()
      app.onQuit = quit
      term.feed('/quit')
      term.feed('\r')
      await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('Tab completes "/he" to "/help " via the wired completeToken callback', async () => {
    const { app, term, client } = await liveApp()
    try {
      term.feed('/he')
      term.feed('\t')
      await vi.waitFor(async () => expect((await screenOf(term, 40, 12)).join('\n')).toContain('/help '))
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('typing @ opens the menu over the working directory files; Enter takes a path and the prompt links it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-at-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'x')
    const ep = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
      sessionId: 'agnes:local:default:cli:dm:main',
      upto: 0,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
    }))
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 60, rows: 16 })
    const app = new TuiApp({ session, term, header: 'Agnes', cwd: dir })
    try {
      await app.start()
      term.feed('see @ap')
      await vi.waitFor(async () => expect((await screenOf(term, 60, 16)).join('\n')).toContain('src/app.ts'))
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 60, 16)).join('\n')).toContain('see @src/app.ts'),
      )
      term.feed('\r')
      await vi.waitFor(() => expect(ep.calls.some((call) => call.method === 'session/prompt')).toBe(true))
      const prompt = ep.calls.find((call) => call.method === 'session/prompt')?.params as {
        prompt: unknown[]
      }
      expect(prompt.prompt).toContainEqual({
        type: 'resource_link',
        uri: pathToFileURL(join(dir, 'src', 'app.ts')).href,
        name: 'src/app.ts',
      })
    } finally {
      await app.stop()
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('typing "/cost" opens a readable report that consumes keys until Escape', async () => {
    const { app, term, client } = await liveApp()
    try {
      term.feed('/cost')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 40, 12)).join('\n')).toContain('会话用量尚未提供。'),
      )
      term.feed('this must not become a prompt')
      term.feed('\x1b')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 40, 12)).join('\n')).not.toContain('会话用量尚未提供。'),
      )
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('/btw shows the side answer in a panel that Escape closes, and a late answer is dropped', async () => {
    let release!: () => void
    const asked: unknown[] = []
    const { app, term, client } = await liveApp((ep) =>
      ep.on('_agnes/v1/session.btw', async (params) => {
        asked.push(params)
        if ((params as { question: string }).question === 'slow')
          await new Promise<void>((r) => (release = r))
        return { text: 'side answer', model: 'm' }
      }),
    )
    const shown = async () => (await screenOf(term, 40, 12)).join('\n')
    try {
      term.feed('/btw what now?')
      term.feed('\r')
      await vi.waitFor(async () => expect(await shown()).toContain('side answer'))
      expect(await shown()).toContain('旁问')
      expect(asked).toEqual([{ sessionId: 'agnes:local:default:cli:dm:main', question: 'what now?' }])
      term.feed('\x1b')
      await vi.waitFor(async () => expect(await shown()).not.toContain('side answer'))
      term.feed('/btw slow')
      term.feed('\r')
      await vi.waitFor(async () => expect(await shown()).toContain('思考中'))
      term.feed('\x1b')
      await vi.waitFor(async () => expect(await shown()).not.toContain('思考中'))
      release()
      await new Promise((r) => setTimeout(r, 50))
      expect(await shown()).not.toContain('side answer')
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('/btw says so when the daemon does not know the method', async () => {
    const { app, term, client } = await liveApp()
    try {
      term.feed('/btw hi')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 40, 12)).join('\n')).toContain('当前 daemon 不支持 /btw'),
      )
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('renders multiline slash output above the editor instead of joining it into the footer', async () => {
    const ep = scriptedEndpoint()
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: 'agnes:local:default:cli:dm:main',
        upto: 0,
        generation: 1,
        opState: null,
        turns: [],
        nodes: [],
      }))
      .on('_agnes/v1/session.list', () => ({
        items: [
          {
            sessionId: 'session-one',
            createdAt: '2026-01-01T00:00:00Z',
            lastSeq: 5,
            generation: 1,
            preset: 'standard',
          },
          {
            sessionId: 'session-two',
            createdAt: '2026-01-02T00:00:00Z',
            lastSeq: 9,
            generation: 1,
            preset: 'claw',
          },
        ],
      }))
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 30 })
    const app = new TuiApp({ session, term, header: 'Agnes' })
    try {
      await app.start()
      term.feed('/sessions')
      term.feed('\r')
      await vi.waitFor(async () => expect((await screenOf(term, 80, 30)).join('\n')).toContain('session-two'))
      const screen = await screenOf(term, 80, 30)
      const editorRow = screen.findIndex((line) => line.includes('❯'))
      expect(screen.findIndex((line) => line.includes('Recent sessions'))).toBeLessThan(editorRow)
      expect(screen.findIndex((line) => line.includes('session-one'))).toBeLessThan(editorRow)
      expect(screen.findIndex((line) => line.includes('session-two'))).toBeLessThan(editorRow)
      expect(screen.slice(editorRow).join('\n')).not.toContain('session-')
      expect(ep.calls.filter((call) => call.method === 'session/prompt')).toEqual([])
    } finally {
      await app.stop()
      await client.close()
    }
  })

  it('intercepts typed package controls before submit can queue a chat turn or render a user row', async () => {
    const source = { type: 'npm' as const, ref: 'npm:example@1.0.0' }
    const preview = {
      id: 'example',
      version: '1.0.0',
      source,
      integrity: `sha256-${'a'.repeat(64)}`,
      license: 'MIT',
      provenance: { source, integrity: `sha256-${'a'.repeat(64)}`, signatureVerified: false },
      contributions: [],
      capabilityDiff: {
        added: [],
        removed: [],
        runtimeSupportRemoved: [],
        dependenciesAdded: [],
        serviceGrantsAdded: [],
      },
      dependencies: {},
      warnings: [],
      blockers: [],
    }
    const ep = scriptedEndpoint()
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: 'agnes:local:default:cli:dm:main',
        upto: 0,
        generation: 1,
        opState: null,
        turns: [],
        nodes: [],
      }))
      .on('_agnes/v1/packages.list', () => ({ packages: [] }))
      .on('_agnes/v1/packages.inspect', () => ({ operationId: 'preview', profile: 'local-dev' }))
      .on('_agnes/v1/packages.operation.get', () => ({
        operationId: 'preview',
        profile: 'local-dev',
        operation: 'inspect',
        state: 'completed',
        progress: 100,
        startedAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z',
        preview,
      }))
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 100, rows: 20 })
    const app = new TuiApp({ session, term, header: 'Agnes', profile: 'local-dev', controlClient: client })
    const submit = vi.spyOn(app, 'submit')
    const chatCalls = () => ep.calls.filter((call) => call.method === 'session/prompt')
    try {
      await app.start()

      // `reconnecting` is emitted by the SDK as soon as its transport closes. The TUI must make
      // that recoverable state visible rather than looking silently healthy until reattach wins.
      const emitter = (client as unknown as { emitter: { emit(name: string, value: unknown): void } }).emitter
      emitter.emit('reconnecting', { reason: 'test-drop' })
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).toContain('reconnecting'),
      )
      emitter.emit('reconnected', { generation: 1 })
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).not.toContain('reconnecting'),
      )

      // These are all real editor keystrokes. They must reach `command()` from app.ts, rather
      // than only proving that `runSlash()` itself returns the expected value in isolation.
      term.feed('/packages')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).toContain('No packages installed.'),
      )

      // Build a real pending preview first. `cancel` must dismiss that preview locally and must
      // never fall through to `submit`, where it could otherwise be queued behind a live turn.
      term.feed('/install npm:example@1.0.0')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).toContain('Preview example@1.0.0'),
      )
      term.feed('/install cancel')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).toContain('Installation cancelled.'),
      )

      term.feed('/install http://untrusted.example/package')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).toContain('Request failed'),
      )

      // Checking both the `submit` seam and the actual session RPC proves that no package line
      // became a queued or submitted chat turn.
      expect(submit).not.toHaveBeenCalled()
      expect(chatCalls()).toEqual([])
      expect(ep.calls.filter((call) => call.method === '_agnes/v1/packages.install')).toEqual([])
      expect((await screenOf(term, 100, 20)).join('\n')).not.toContain('you:')
    } finally {
      await app.stop()
      await client.close()
    }
  })
})

it('uploads a CLI path with spaces through bounded original intake and preserves a typed refusal', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { IncrementalSha256 } = await import('@agnes/protocol')
  const dir = await mkdtemp(join(tmpdir(), 'agh-cli-attachment-'))
  try {
    const bytes = new TextEncoder().encode('synthetic original')
    await writeFile(join(dir, 'a file.txt'), bytes)
    const artifact = {
      sha256: new IncrementalSha256().update(bytes).digest(),
      size: bytes.length,
      mime: 'text/plain',
    }
    const calls: import('@agnes/protocol').FileUploadRequest[] = []
    let started = { name: 'a file.txt', mime: 'text/plain' }
    const app = {
      cwd: dir,
      session: {
        id: 's',
        client: {
          call: async (_method: string, input: import('@agnes/protocol').FileUploadRequest) => {
            calls.push(input)
            if (input.operation === 'start') {
              started = { name: input.name, mime: input.mimeType }
              return { offset: 0 }
            }
            if (input.operation === 'chunk') return { offset: bytes.length }
            return {
              attachment: attachmentLink({ ...artifact, mime: started.mime }, started.name, {
                receiptId: '00000000-0000-4000-8000-000000000001',
              }),
            }
          },
        },
      },
    } as unknown as TuiApp
    expect((await runSlash(app, '/attach a file.txt')).content).toEqual([
      attachmentLink(artifact, 'a file.txt', { receiptId: '00000000-0000-4000-8000-000000000001' }),
    ])
    expect(calls.map((call) => [call.operation, call.destination, call.laneId])).toEqual([
      ['start', 'original', 'main'],
      ['chunk', 'original', 'main'],
      ['finish', 'original', 'main'],
    ])
    // Newly supported types carry their own MIME; an unlisted extension travels as the generic type.
    for (const [name, mime] of [
      ['pic.webp', 'image/webp'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['blob.xyz', 'application/octet-stream'],
    ] as const) {
      await writeFile(join(dir, name), bytes)
      calls.length = 0
      await runSlash(app, `/attach ${name}`)
      expect((calls[0] as { mimeType?: string }).mimeType).toBe(mime)
    }
    // The daemon's own refusal (for example an allow-list miss) reaches the user verbatim, with no bytes sent.
    calls.length = 0
    const refuse = Object.assign(new Error('ATTACHMENT_MIME'), { data: { reason: 'ATTACHMENT_MIME' } })
    const real = app.session.client.call
    app.session.client.call = async (_m: string, input: import('@agnes/protocol').FileUploadRequest) => {
      calls.push(input)
      throw refuse
    }
    await expect(runSlash(app, '/attach blob.xyz')).rejects.toBe(refuse)
    expect(calls.map((call) => call.operation)).toEqual(['start'])
    app.session.client.call = real
    const error = Object.assign(new Error('refused'), { data: { reason: 'ATTACHMENT_QUOTA' } })
    app.session.client.call = async () => {
      throw error
    }
    await expect(runSlash(app, '/attach a file.txt')).rejects.toBe(error)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

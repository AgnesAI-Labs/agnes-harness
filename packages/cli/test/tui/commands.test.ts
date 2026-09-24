import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { resourceCapabilityMissing } from '../../src/commands/resources.js'
import { TuiApp } from '../../src/tui/app.js'
import {
  attachmentsFrom,
  completeToken,
  runSlash,
  SLASH_COMMANDS,
  slashCommand,
} from '../../src/tui/commands.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
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
    ...(composerSelectionPath ? { composerSelectionPath } : {}),
    ...(themePreferencePath ? { themePreferencePath } : {}),
  })
  return { app, ep, client, term }
}

describe('SLASH_COMMANDS (cli 稿 §9.3 and PM7)', () => {
  it('names the thirteen session commands plus package controls', () => {
    expect(SLASH_COMMANDS).toHaveLength(24)
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      '/help',
      '/quit',
      '/new',
      '/resume',
      '/sessions',
      '/cost',
      '/usage',
      '/computer-use',
      '/doctor',
      '/rewind',
      '/compact',
      '/preset',
      '/theme',
      '/model',
      '/yolo',
      '/export',
      '/refine',
      '/packages',
      '/install',
      '/package',
      '/skills',
      '/skill',
      '/mcp',
      '/context',
    ])
  })

  it('carries an args shape for commands that take one and a description for all', () => {
    expect(slashCommand('/resume')?.args).toBe('[id]')
    expect(slashCommand('/rewind')?.args).toBe('<seq>')
    expect(slashCommand('/compact')?.args).toBe('[instructions]')
    expect(slashCommand('/preset')?.args).toBe('<name>')
    expect(slashCommand('/theme')?.args).toBe('[light|dark|mono]')
    expect(slashCommand('/model')?.args).toBe('[<slot> <route>/<model> [<thinking>]]')
    expect(slashCommand('/install')?.args).toBe('<source>|confirm|cancel')
    expect(slashCommand('/package')?.args).toContain('rollback')
    expect(slashCommand('/skill')?.args).toBe('refresh|trust ...')
    // Commands without arguments carry no shape at all, and an unknown name finds nothing.
    expect(slashCommand('/help')?.args).toBeUndefined()
    expect(slashCommand('/nope')).toBeUndefined()
    for (const c of SLASH_COMMANDS) expect(c.description.length).toBeGreaterThan(0)
  })
})

describe('runSlash', () => {
  it('/theme menu selects, repaints and persists across TUI instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-theme-app-'))
    const path = join(dir, 'tui-theme.json')
    const first = await unstartedApp(undefined, undefined, path)
    try {
      await first.app.start()
      await first.app.runInput('/theme')
      expect((await screenOf(first.term, 90, 24)).join('\n')).toContain('当前')
      first.term.feed('\x1b[B')
      first.term.feed('\r')
      await vi.waitFor(() => expect(first.app.themeName).toBe('dark'))
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark' })
      expect(first.term.writes.join('')).toContain('\x1b[48;5;234m')
      const second = await unstartedApp(undefined, undefined, path)
      try {
        expect(second.app.themeName).toBe('dark')
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
  it('/theme reports and switches the current TUI presentation without touching the session', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      await expect(runSlash(app, '/theme')).resolves.toEqual({})
      await expect(runSlash(app, '/theme dark')).resolves.toMatchObject({
        text: 'theme dark · 未能保存偏好，仅本次生效',
      })
      expect(app.themeName).toBe('dark')
      await expect(runSlash(app, '/theme neon')).resolves.toMatchObject({
        text: 'usage: /theme [light|dark|mono]',
      })
      expect(ep.calls.some((call) => call.method.includes('theme'))).toBe(false)
    } finally {
      await client.close()
      await ep.close()
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
  it('/help lists the command table with descriptions; /quit signals quit; unknown names say so', async () => {
    const { app, client, ep } = await unstartedApp()
    try {
      const help = await runSlash(app, '/help')
      for (const cmd of SLASH_COMMANDS) expect(help.text).toContain(cmd.name)
      expect(help.presentation).toBe('transcript')
      expect(help.text).toContain('Slash commands')
      // The help line carries the one-line description, not just the name.
      expect(help.text).toContain('退出')
      expect(await runSlash(app, '/quit')).toEqual({ quit: true })
      const unknown = await runSlash(app, '/nope')
      expect(unknown.text).toContain('unknown')
      expect(unknown.text).toContain('/help')
      expect(unknown.text).not.toContain('/packages')
      const singular = await runSlash(app, '/session')
      expect(singular.text).toBe('unknown command /session; did you mean /sessions?')
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
      await expect(runSlash(controlled, '/install https://untrusted.example/package')).rejects.toThrow(
        /package source/,
      )
      expect(ep.calls.filter((call) => call.method === '_agnes/v1/submit')).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('/new applies the remembered model and full permission before switching', async () => {
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
      expect(created.text).toBe('新会话使用 deepseek/deepseek-v4-pro · medium · 完全权限')
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
        'newest-history',
        'older-history',
      ])
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

  it('/yolo takes no args and switches through the real setYolo call', async () => {
    const { app, client } = await unstartedApp()
    try {
      expect((await runSlash(app, '/yolo')).text).toBe(
        'yolo on from seq 7 — every ask for the rest of this session is skipped',
      )
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

  it('/export only ever suggests the command line; it never touches the wire', async () => {
    const { app, ep, client } = await unstartedApp()
    try {
      const before = ep.calls.length
      const r = await runSlash(app, '/export --html')
      expect(r.text).toBe(`run: agnes export ${app.session.id} --html`)
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
  it('matches commands and @paths; an unmatched prefix returns empty, not everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-cwd-'))
    writeFileSync(join(dir, 'README.md'), 'x')
    writeFileSync(join(dir, 'ROADMAP.md'), 'x')
    // Exact single match.
    expect(completeToken('/he', dir)).toEqual(['/help'])
    expect(completeToken('@REA', dir)).toEqual(['@README.md'])
    // Reverse-verification (required): a prefix matching nothing returns an empty list, never the
    // full table/directory listing.
    expect(completeToken('/zzzz', dir)).toEqual([])
    expect(completeToken('@zzzz', dir)).toEqual([])
    // A prefix shared by several commands returns all of them, not one arbitrarily.
    expect(completeToken('/re', dir)).toEqual(['/resume', '/rewind', '/refine'])
    expect(completeToken('@RO', dir)).toEqual(['@ROADMAP.md'])
    // Neither '/' nor '@': nothing to complete against.
    expect(completeToken('plain', dir)).toEqual([])
  })

  it('caps @path completion at 20 entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-cwd-many-'))
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `file-${String(i).padStart(2, '0')}.txt`), 'x')
    expect(completeToken('@file', dir)).toHaveLength(20)
  })
})

describe('attachmentsFrom', () => {
  it('turns an @mention into a resource_link block and strips the @ from the text', () => {
    expect(attachmentsFrom('look at @README.md please')).toEqual([
      { type: 'text', text: 'look at README.md please' },
      { type: 'resource_link', uri: 'file://README.md', name: 'README.md' },
    ])
  })

  it('passes plain text through unchanged when there is no @mention', () => {
    expect(attachmentsFrom('no attachments here')).toEqual([{ type: 'text', text: 'no attachments here' }])
  })

  it('collects every @mention, in order, as its own block', () => {
    expect(attachmentsFrom('@a.txt and @b/c.txt')).toEqual([
      { type: 'text', text: 'a.txt and b/c.txt' },
      { type: 'resource_link', uri: 'file://a.txt', name: 'a.txt' },
      { type: 'resource_link', uri: 'file://b/c.txt', name: 'b/c.txt' },
    ])
  })
})

describe('app.ts wiring: key routing through the editor reaches the real command/completion path', () => {
  async function liveApp() {
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
    const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 40, rows: 12 })
    const app = new TuiApp({ session, term, header: 'Agnes' })
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

      term.feed('/install https://untrusted.example/package')
      term.feed('\r')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 100, 20)).join('\n')).toContain('Request failed'),
      )

      // `submit` is the only path that writes `pendingPrompts`; checking both that seam and the
      // actual session RPC proves that no package line became a queued or submitted chat turn.
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

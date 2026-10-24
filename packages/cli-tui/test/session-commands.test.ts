import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { type ContentBlock, rpcError } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
import { deliverableBasename } from '../src/deliverable-files.js'
import { tt } from '../src/locale-extended.js'
import { displayWidth } from '../src/terminal.js'
import { TuiTheme } from '../src/theme.js'
import { localCommandView } from '../src/views/local-command.js'

const meta = (sessionId: string, cwd: string) => ({
  sessionId,
  createdAt: '2026-10-01T00:00:00Z',
  lastSeq: 3,
  generation: 1,
  preset: 'standard',
  cwd,
})

function appWith(
  client: Record<string, unknown>,
  session: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    cwd: '/w/a',
    locale: 'en',
    refuseSwitch: () => false,
    o: {},
    session: { id: 'cur', client, ...session },
    ...extra,
  } as unknown as TuiApp
}

describe('session slash commands', () => {
  it('/pin /unpin /rename /archive call the session RPCs for the open session and report one line', async () => {
    const pin = vi.fn(async () => ({}))
    const rename = vi.fn(async () => ({ title: 'two\nwords' }))
    const archive = vi.fn(async () => ({}))
    const app = appWith({ session: { pin, rename, archive } })
    await expect(runSlash(app, '/pin')).resolves.toEqual({ text: tt('session.pinned', 'en') })
    await runSlash(app, '/unpin')
    expect(pin.mock.calls).toEqual([
      ['cur', true],
      ['cur', false],
    ])
    expect((await runSlash(app, '/rename two words')).text).toBe('Session renamed to two words')
    expect(rename).toHaveBeenCalledWith('cur', 'two words')
    expect((await runSlash(app, '/rename')).text).toContain('usage')
    expect((await runSlash(app, '/archive')).text).toBe(tt('session.archived', 'en'))
    expect(archive).toHaveBeenCalledWith('cur', true)
    pin.mockRejectedValueOnce(new Error('not the owner'))
    await expect(runSlash(app, '/pin')).rejects.toThrow('not the owner')
  })

  it('/search hands one inert row per matching session to the picker and shows refusals', async () => {
    const hit = (sessionId: string, snippet: string) => ({
      sessionId,
      title: 'T',
      workspace: '/w',
      snippet,
      ts: '2026-10-02T00:00:00Z',
      seq: 7,
    })
    const call = vi.fn(async () => ({
      items: [hit('s1', 'a\u001b[31m\nb'), hit('s1', 'dup'), hit('s2', 'x')],
    }))
    const app = appWith({ call })
    const result = await runSlash(app, '/search foo bar')
    expect(call).toHaveBeenCalledWith('_agnes/v1/admin.history.search', {
      query: 'foo bar',
      title: '',
      workspace: '',
    })
    expect(result.sessionPickerTitle).toBe('picker.searchTitle')
    expect(result.sessionChoices?.map((c) => [c.sessionId, c.title])).toEqual([
      ['s1', 'T — a[31m b'],
      ['s2', 'T — x'],
    ])
    call.mockResolvedValueOnce({ items: [] })
    expect((await runSlash(app, '/search none')).text).toBe(tt('session.noMatches', 'en'))
    call.mockRejectedValueOnce(new Error('admin tier required'))
    await expect(runSlash(app, '/search x')).rejects.toThrow('admin tier required')
  })

  it('/resume all lists every workspace; bare /resume stays in this one', async () => {
    const list = vi.fn(async () => ({
      items: [meta('cur', '/w/a'), meta('b', '/w/a'), meta('c', '/w/other')],
    }))
    const app = appWith({ session: { list } })
    const ids = async (line: string) =>
      (await runSlash(app, line)).sessionChoices?.map((c) => c.sessionId).sort()
    expect(await ids('/resume')).toEqual(['b'])
    expect(await ids('/resume all')).toEqual(['b', 'c', 'cur'])
  })

  it('/yolo off sends enabled:false; bare /yolo and on keep enabling', async () => {
    const setYolo = vi.fn(async (_enabled: boolean) => ({ effectiveFromSeq: 9 }))
    const app = appWith({}, { setYolo })
    expect((await runSlash(app, '/yolo off')).text).toBe(tt('session.yoloOff', 'en', { seq: 9 }))
    expect(setYolo).toHaveBeenLastCalledWith(false)
    await runSlash(app, '/yolo on')
    await runSlash(app, '/yolo')
    expect(setYolo.mock.calls.map((c) => c[0])).toEqual([false, true, true])
    expect((await runSlash(app, '/yolo maybe')).text).toContain('usage')
  })

  it('/rewind without a seq offers only completed, forkable turns; with a seq it forks directly', async () => {
    const turn = (n: number, endSeq: number | undefined, forkable: boolean) => ({
      id: `t${n}`,
      turn: n,
      startSeq: n * 10,
      ...(endSeq ? { endSeq } : {}),
      startedAt: '2026-10-03T00:00:00Z',
      status: endSeq ? 'completed' : 'running',
      nodeIds: [`u${n}`],
      forkable,
    })
    const projectUIOpening = vi.fn(async () => ({
      timeline: {
        turns: [turn(1, 12, true), turn(2, 22, false), turn(3, undefined, false)],
        nodes: [{ kind: 'user', id: 'u1', seq: 10, content: [{ type: 'text', text: 'first\nprompt' }] }],
      },
    }))
    const fork = vi.fn(async () => ({ id: 'child' }))
    const app = appWith({ session: { fork } }, { projectUIOpening })
    const result = await runSlash(app, '/rewind')
    expect(result.sessionPickerTitle).toBe('picker.rewindTitle')
    expect(result.sessionChoices).toMatchObject([
      { sessionId: 'cur', forkAt: 12, title: '#1 first prompt', draft: 'first\nprompt' },
    ])
    expect(fork).not.toHaveBeenCalled()
    const direct = await runSlash(app, '/rewind 12')
    expect(fork).toHaveBeenCalledWith('cur', 12)
    expect(direct).toMatchObject({ draft: 'first\nprompt', switchSession: { id: 'child' } })
    // A turn whose prompt cannot be read still forks, and says the editor is unchanged.
    const bare = await runSlash(app, '/rewind 22')
    expect(bare.draft).toBeUndefined()
    expect(bare.text).toBe(tt('session.rewoundNoPrompt', 'en'))
    fork.mockRejectedValueOnce(new Error('fork boundary must be a completed turn/end'))
    await expect(runSlash(app, '/rewind 13')).rejects.toThrow('completed turn/end')
    projectUIOpening.mockResolvedValueOnce({ timeline: { turns: [turn(3, undefined, false)], nodes: [] } })
    expect((await runSlash(app, '/rewind')).text).toBe(tt('session.noTurns', 'en'))
  })

  it('/fork forks at the latest completed turn, or turn N, through the same call as /rewind', async () => {
    const turn = (n: number, endSeq: number | undefined, forkable: boolean) => ({
      id: `t${n}`,
      turn: n,
      startSeq: n * 10,
      ...(endSeq ? { endSeq } : {}),
      forkable,
    })
    const turns = [turn(1, 12, true), turn(2, 22, true), turn(3, undefined, false)]
    const projectUIOpening = vi.fn(async () => ({ timeline: { turns, nodes: [] } }))
    const fork = vi.fn(async () => ({ id: 'child' }))
    const app = appWith({ session: { fork } }, { projectUIOpening })
    const latest = await runSlash(app, '/fork')
    expect(fork).toHaveBeenLastCalledWith('cur', 22)
    expect(latest.switchSession).toMatchObject({ id: 'child' })
    expect(latest.text).toBe(tt('fork.done', 'en', { turn: 2, id: 'cur' }))
    await runSlash(app, '/fork 1')
    expect(fork).toHaveBeenLastCalledWith('cur', 12)
    await runSlash(app, '/rewind 12')
    expect(fork).toHaveBeenLastCalledWith('cur', 12)
    fork.mockClear()
    for (const line of ['/fork 3', '/fork 9'])
      expect((await runSlash(app, line)).text).toBe(
        tt('fork.notForkable', 'en', { turn: Number(line.slice(6)) }),
      )
    for (const line of ['/fork x', '/fork 0', '/fork 1 2'])
      expect((await runSlash(app, line)).text).toBe(tt('fork.usage', 'en'))
    const busy = appWith({ session: { fork } }, { projectUIOpening }, { busy: true })
    expect((await runSlash(busy, '/fork')).text).toBe(tt('fork.busy', 'en'))
    projectUIOpening.mockResolvedValueOnce({ timeline: { turns: [turn(3, undefined, false)], nodes: [] } })
    expect((await runSlash(app, '/fork')).text).toBe(tt('fork.noTurns', 'en'))
    expect(fork).not.toHaveBeenCalled()
  })

  it('/recap assembles the local card, cuts a long request, and leaves out what it cannot read', async () => {
    const longRequest = `fix ${'the parser '.repeat(40)}now`
    const plan = {
      kind: 'tool',
      id: 'p1',
      seq: 3,
      name: 'update_plan',
      toolUseId: 'p1',
      status: 'completed',
      summary: '',
      argsPreview: JSON.stringify({
        plan: [
          { step: 'read', status: 'completed' },
          { step: 'write the fix', status: 'in_progress' },
          { step: 'test', status: 'pending' },
        ],
      }),
    }
    const timeline = {
      turns: [{ turn: 1 }, { turn: 2 }],
      nodes: [
        { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'older' }] },
        { kind: 'user', id: 'u2', seq: 2, content: [{ type: 'text', text: longRequest }] },
        { kind: 'user', id: 'u3', seq: 4, origin: 'system', content: [{ type: 'text', text: 'injected' }] },
        plan,
      ],
      usage: { context: { tokens: 500, window: 1000 } },
    }
    const session = {
      projectUIOpening: vi.fn(async () => ({ timeline })),
      workspaceChanges: vi.fn(async () => ({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] })),
    }
    const client = {
      session: {
        list: vi.fn(async () => ({ items: [{ ...meta('cur', '/w/a'), title: 'Parser work' }] })),
        runtime: vi.fn(async () => ({ sessionKey: 'k' })),
      },
      call: vi.fn(async () => ({ schedules: [{}, {}, {}] })),
    }
    const text = (await runSlash(appWith(client, session), '/recap')).text ?? ''
    const rows = Object.fromEntries(text.split('\n').map((row) => row.split(/ {2,}/) as [string, string]))
    expect(rows[tt('recap.session', 'en')]).toBe('Parser work (cur)')
    expect(rows[tt('recap.turns', 'en')]).toBe('2')
    expect(rows[tt('recap.request', 'en')]).toBe(
      `${[...longRequest.replace(/\s+/g, ' ')].slice(0, 200).join('')}…`,
    )
    expect(rows[tt('recap.plan', 'en')]).toBe('1/3 · write the fix')
    expect(rows[tt('recap.files', 'en')]).toBe('2')
    expect(rows[tt('recap.schedules', 'en')]).toBe('3')
    expect(rows[tt('recap.context', 'en')]).toBe('500 / 1000 (50.0%)')
    expect(rows[tt('recap.background', 'en')]).toBeUndefined()
    // Every source failing leaves the session id only, never a placeholder.
    const failing = {
      projectUIOpening: vi.fn(async () => Promise.reject(new Error('x'))),
      workspaceChanges: vi.fn(async () => Promise.reject(new Error('x'))),
    }
    const broken = {
      session: { list: vi.fn(async () => Promise.reject(new Error('x'))), runtime: vi.fn() },
      call: vi.fn(),
    }
    expect((await runSlash(appWith(broken, failing), '/recap')).text).toBe(
      `${tt('recap.session', 'en')}  cur`,
    )
  })

  it('/images hands its arguments to the inline image switch', async () => {
    const command = vi.fn(() => 'done')
    expect(await runSlash(appWith({}, {}, { images: { command } }), '/images off')).toEqual({ text: 'done' })
    expect(command).toHaveBeenCalledWith(['off'], 'en')
  })

  it('/new <dir> creates the session in that directory and shows a daemon refusal as it comes', async () => {
    const created = vi.fn(async () => {
      throw new Error('workspace not authorised')
    })
    const app = appWith({ session: { new: created } })
    await expect(runSlash(app, '/new ../b')).rejects.toThrow('workspace not authorised')
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve(app.cwd, '../b') }))
  })
})

describe('/grants', () => {
  const grant = (grantId: string, lifetime = 'session') => ({
    grantId,
    lifetime,
    toolId: 'shell\u001b[31m',
    scope: 'a\nb',
    createdAt: '2026-10-22T00:00:00Z',
  })

  it('lists numbered inert lines, revokes by number or id and shows the daemon refusal', async () => {
    const sessionGrants = vi.fn(async () => ({ grants: [grant('g1'), grant('g2', 'always')] }))
    const revokeSessionGrant = vi.fn(async (_s: string, id: string) => ({
      ...grant(id),
      revokedAt: '2026-10-22T01:00:00Z',
    }))
    const app = appWith({ approval: { sessionGrants, revokeSessionGrant } })
    expect((await runSlash(app, '/grants')).text).toBe(
      '1  g1  shell[31m  session  2026-10-22T00:00:00Z  a b\n2  g2  shell[31m  always  2026-10-22T00:00:00Z  a b',
    )
    expect(sessionGrants).toHaveBeenCalledWith('cur')
    // the renderer strips control characters: columns must stay apart without them
    const shown = ((await runSlash(app, '/grants')).text as string).replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors the renderer
      /[\x00-\x1f\x7f-\x9f]/g,
      '',
    )
    expect(shown).not.toMatch(/g1shell|1g1/)
    expect((await runSlash(app, '/grants revoke 2')).text).toContain('revoked g2  ')
    await runSlash(app, '/grants revoke g1')
    expect(revokeSessionGrant.mock.calls).toEqual([
      ['cur', 'g2'],
      ['cur', 'g1'],
    ])
    expect((await runSlash(app, '/grants revoke 9')).text).toBe(tt('grants.unknown', 'en', { key: '9' }))
    expect((await runSlash(app, '/grants nope')).text).toBe(tt('grants.usage', 'en'))
    expect(revokeSessionGrant).toHaveBeenCalledTimes(2)
    sessionGrants.mockResolvedValueOnce({ grants: [] })
    expect((await runSlash(app, '/grants')).text).toBe(tt('grants.none', 'en'))
    sessionGrants.mockRejectedValueOnce(new Error('admin tier required'))
    await expect(runSlash(app, '/grants')).rejects.toThrow('admin tier required')
  })
})

describe('/deliverables', () => {
  const body = Buffer.from('report body')
  const artifact = {
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
    mime: 'text/plain',
  }
  const present = (name: string) => ({
    items: [
      {
        callSeq: 1,
        resultSeq: 2,
        toolUseId: 'tu',
        structured: { deliverables: [{ name, description: '', ref: artifact }] },
      },
    ],
  })
  const read = (bytes: Buffer) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      artifact,
      acceptRanges: 'bytes',
      etag: `"${artifact.sha256}"`,
      contentLength: bytes.length,
      base64: bytes.toString('base64'),
    }))

  it('lists files and saves one into the app directory, refusing an existing target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-tui-deliv-'))
    try {
      const deliverables = vi.fn(async () => ({ sessionId: 'cur', upto: 5, ...present('docs/r[31m.txt') }))
      const call = read(body)
      const app = { ...appWith({ call }, { deliverables }), cwd: dir } as unknown as TuiApp
      expect((await runSlash(app, '/deliverables')).text).toBe(
        `1\tdocs/r[31m.txt\t${body.length}\ttext/plain`,
      )
      const saved = await runSlash(app, '/deliverables save 1')
      expect(saved.text).toContain(
        `${join(dir, 'r[31m.txt')} (${body.length} bytes, sha256 ${artifact.sha256})`,
      )
      expect(readFileSync(join(dir, 'r[31m.txt'))).toEqual(body)
      expect(call).toHaveBeenCalledWith(
        '_agnes/v1/artifact.read',
        expect.objectContaining({ sessionId: 'cur', laneId: 'main', artifact }),
      )
      await expect(runSlash(app, '/deliverables save 1')).rejects.toThrow('use --force')
      writeFileSync(join(dir, 'keep.txt'), 'mine')
      await expect(runSlash(app, '/deliverables save 1 keep.txt')).rejects.toThrow('already exists')
      expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine')
      expect((await runSlash(app, '/deliverables save 7')).text).toBe(
        tt('deliverables.unknown', 'en', { key: '7' }),
      )
      expect((await runSlash(app, '/deliverables save')).text).toBe(tt('deliverables.usage', 'en'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the temp file when the downloaded bytes fail the sha256 check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-tui-deliv-'))
    try {
      const deliverables = vi.fn(async () => ({ sessionId: 'cur', upto: 5, ...present('r.txt') }))
      const app = {
        ...appWith({ call: read(Buffer.from('other bytes')) }, { deliverables }),
        cwd: dir,
      } as unknown as TuiApp
      await expect(runSlash(app, '/deliverables save 1')).rejects.toThrow(/mismatch/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('only ever uses the last path segment of a name, and refuses unusable ones', () => {
    expect(deliverableBasename('a/b/../c.txt')).toBe('c.txt')
    expect(deliverableBasename('C:\\x\\y.txt')).toBe('y.txt')
    for (const bad of ['', '.', '..', 'a/..', 'a\u0000b', 'x\u001b[0m'])
      expect(() => deliverableBasename(bad), JSON.stringify(bad)).toThrow('not a usable file name')
  })
})

describe('/queue', () => {
  const text = (value: string): ContentBlock => ({ type: 'text', text: value })
  const link: ContentBlock = { type: 'resource_link', uri: 'file:///w/a.txt', name: 'a.txt' }
  const item = (kind: string, content: ContentBlock[], itemId = kind) => ({
    itemId,
    target: kind === 'steer' ? 'next-step' : 'next-turn',
    kind,
    content,
  })
  const daemonQueue = (...pending: ReturnType<typeof item>[]) =>
    appWith({}, { controls: async () => ({ controls: {}, paused: false, pending }) })

  it('lists what waits in the daemon, follow-ups and steers alike, as inert lines', async () => {
    const app = daemonQueue(
      item('follow_up', [text('fix\nthe\u001b[2J bug')]),
      item('prompt', [text('not a queued input')]),
      item('steer', [text('read @a.txt'), link]),
      item('follow_up', [text('x'.repeat(100))]),
    )
    expect(((await runSlash(app, '/queue')).text ?? '').split('\n')).toEqual([
      '1. fix the[2J bug',
      `2. read @a.txt${tt('queue.extra', 'en', { count: 1 })}`,
      `3. ${'x'.repeat(79)}…`,
    ])
    expect((await runSlash(daemonQueue(), '/queue')).text).toBe(tt('queue.none', 'en'))
  })

  it('refuses what it cannot place', async () => {
    const app = daemonQueue(item('follow_up', [text('only')]))
    for (const line of ['/queue drop', '/queue edit 1 2', '/queue move 1'])
      expect((await runSlash(app, line)).text, line).toBe(tt('queue.usage', 'en'))
    for (const key of ['0', '2', '-1', '1.5', 'one'])
      expect((await runSlash(app, `/queue drop ${key}`)).text).toBe(tt('queue.unknown', 'en', { key }))
    expect((await runSlash(daemonQueue(), '/queue edit last')).text).toBe(tt('queue.none', 'en'))
  })

  const actions = (controls: Record<string, boolean>, ...pending: ReturnType<typeof item>[]) => {
    const calls: Array<[string, string, { commandId: string }]> = []
    const act = (name: string) =>
      vi.fn(async (itemId: string, opts: { commandId: string }) => {
        calls.push([name, itemId, opts])
        return 1
      })
    const session = {
      controls: async () => ({ controls, paused: false, pending }),
      removeQueued: act('removeQueued'),
      sendNow: act('sendNow'),
      promoteQueued: act('promoteQueued'),
    }
    return { calls, session, app: appWith({}, session) }
  }

  it('edit moves a message back to the editor, keeping its attachments aside, and drop discards one', async () => {
    const { calls, app } = actions(
      {},
      item('follow_up', [text('fix\nthe\u001b[2J bug')], 'a'),
      item('steer', [text('read @a.txt'), link], 'b'),
    )
    expect(await runSlash(app, '/queue edit 1')).toEqual({
      text: tt('queue.edited', 'en', { n: 1 }),
      draft: 'fix\nthe\u001b[2J bug',
    })
    // The attachment cannot become editor text: it is handed on to ride with the next message.
    expect(await runSlash(app, '/queue edit last')).toEqual({
      text: tt('queue.edited', 'en', { n: 2 }) + tt('queue.extra', 'en', { count: 1 }),
      draft: 'read @a.txt',
      keep: [link],
    })
    expect(await runSlash(app, '/queue drop 1')).toEqual({ text: tt('queue.dropped', 'en', { n: 1 }) })
    expect(calls.map(([name, id]) => [name, id])).toEqual([
      ['removeQueued', 'a'],
      ['removeQueued', 'b'],
      ['removeQueued', 'a'],
    ])
    // Every action is its own command with its own id.
    expect(new Set(calls.map(([, , opts]) => opts.commandId)).size).toBe(3)
  })

  it('now and steer call the matching action only when the turn allows it', async () => {
    const allowed = actions({ interrupt: true, steer: true }, item('follow_up', [text('x')], 'a'))
    expect((await runSlash(allowed.app, '/queue now 1')).text).toBe(tt('queue.sentNow', 'en', { n: 1 }))
    expect((await runSlash(allowed.app, '/queue steer 1')).text).toBe(tt('queue.steered', 'en', { n: 1 }))
    expect(allowed.calls.map(([name, id]) => [name, id])).toEqual([
      ['sendNow', 'a'],
      ['promoteQueued', 'a'],
    ])
    expect(allowed.calls.every(([, , opts]) => opts.commandId.length > 0)).toBe(true)
    const refused = actions({}, item('follow_up', [text('x')], 'a'))
    expect((await runSlash(refused.app, '/queue now 1')).text).toBe(
      tt('queue.unavailable', 'en', { verb: 'now' }),
    )
    expect((await runSlash(refused.app, '/queue steer 1')).text).toBe(
      tt('queue.unavailable', 'en', { verb: 'steer' }),
    )
    expect(refused.calls).toEqual([])
  })

  it('says why the daemon refused an action, and lets any other failure through', async () => {
    const { session, app } = actions({}, item('follow_up', [text('x')], 'a'))
    const refuse = (error: unknown) => session.removeQueued.mockRejectedValueOnce(error)
    const wire = (...args: Parameters<typeof rpcError>) => new JsonRpcError(rpcError(...args))
    refuse(wire('SEMANTIC_REJECTED', { code: 'QUEUED_INPUT_GONE' }))
    expect((await runSlash(app, '/queue drop 1')).text).toBe(tt('queue.gone', 'en'))
    refuse(wire('CAPABILITY_DENIED', {}))
    expect((await runSlash(app, '/queue drop 1')).text).toBe(tt('queue.denied', 'en'))
    refuse(wire('SEMANTIC_REJECTED', { code: 'E_SOMETHING' }))
    expect((await runSlash(app, '/queue drop 1')).text).toBe(
      tt('queue.rejected', 'en', { code: 'E_SOMETHING' }),
    )
    refuse(new Error('boom'))
    await expect(runSlash(app, '/queue drop 1')).rejects.toThrow('boom')
  })
})

describe('/undo', () => {
  const preview = (extra: Record<string, unknown> = {}) => ({
    sessionId: 'cur',
    turn: 2,
    busy: false,
    undoable: true,
    blockedBy: 'none',
    laterTurns: [],
    shellChanges: false,
    files: [
      { path: 'a.txt', action: 'restore', undoable: true },
      { path: 'new\u001b[31m.txt', action: 'delete', undoable: true },
    ],
    ...extra,
  })
  const wire = (...args: Parameters<typeof rpcError>) => new JsonRpcError(rpcError(...args))

  it('shows the preview first, undoes only on confirm and reuses one commandId for a retry', async () => {
    const undoPreview = vi.fn(async () => preview())
    const undo = vi.fn(async (_turn: number, _options: { commandId: string }) => ({
      sessionId: 'cur',
      turn: 2,
      seq: 9,
      restored: ['a.txt', 'new.txt'],
      failed: [],
      conflicts: [],
    }))
    const app = appWith({}, { undoPreview, undo })
    const shown = await runSlash(app, '/undo')
    expect(undo).not.toHaveBeenCalled()
    expect(shown.text).toContain('Turn 2 changed 2 file(s)')
    expect(shown.text).toContain('delete')
    expect(shown.text).not.toContain('\u001b')
    expect(shown.text).toContain(tt('undo.confirm', 'en'))
    undo.mockRejectedValueOnce(new Error('connection dropped'))
    await expect(runSlash(app, '/undo confirm')).rejects.toThrow('connection dropped')
    expect((await runSlash(app, '/undo confirm')).text).toBe(tt('undo.done', 'en', { turn: 2, count: 2 }))
    expect(undo.mock.calls[0]?.[1]).toEqual(undo.mock.calls[1]?.[1])
    expect(undo.mock.calls[0]).toEqual([2, { commandId: expect.any(String) }])
    expect((await runSlash(app, '/undo confirm')).text).toBe(tt('undo.noPending', 'en'))
  })

  it('previews a given turn, drops a pending undo on cancel and does not offer a blocked one', async () => {
    const undoPreview = vi.fn(async (turn?: number) =>
      turn === 1
        ? preview({ turn: 1, undoable: false, blockedBy: 'later-turns', laterTurns: [2], shellChanges: true })
        : preview(),
    )
    const app = appWith({}, { undoPreview, undo: vi.fn() })
    const blocked = (await runSlash(app, '/undo 1')).text ?? ''
    expect(undoPreview).toHaveBeenCalledWith(1)
    expect(blocked).toContain(tt('undo.blocked.later-turns', 'en'))
    expect(blocked).toContain(tt('undo.shell', 'en'))
    expect(blocked).not.toContain(tt('undo.confirm', 'en'))
    expect((await runSlash(app, '/undo confirm')).text).toBe(tt('undo.noPending', 'en'))
    await runSlash(app, '/undo')
    expect((await runSlash(app, '/undo cancel')).text).toBe(tt('undo.cancelled', 'en'))
    expect((await runSlash(app, '/undo confirm')).text).toBe(tt('undo.noPending', 'en'))
    expect((await runSlash(app, '/undo x')).text).toContain('usage')
  })

  it('says why the daemon refused, that an old daemon cannot undo, and lets other failures through', async () => {
    const undoPreview = vi.fn(async () => preview())
    const undo = vi.fn()
    const app = appWith({}, { undoPreview, undo })
    await runSlash(app, '/undo')
    undo.mockRejectedValueOnce(
      wire('SEMANTIC_REJECTED', {
        code: 'UNDO_CONFLICT',
        conflicts: [{ path: 'b.txt', reason: 'changed-since' }],
      }),
    )
    const conflict = (await runSlash(app, '/undo confirm')).text ?? ''
    expect(conflict).toContain(tt('undo.refusedFiles', 'en'))
    expect(conflict).toContain('b.txt')
    expect(conflict).toContain(tt('undo.reason.changed-since', 'en'))
    // A refusal is final: the confirmation is gone and a new preview is needed.
    expect((await runSlash(app, '/undo confirm')).text).toBe(tt('undo.noPending', 'en'))
    undoPreview.mockRejectedValueOnce(wire('METHOD_NOT_FOUND'))
    expect((await runSlash(app, '/undo')).text).toBe(tt('undo.unsupported', 'en'))
    await runSlash(app, '/undo')
    undo.mockRejectedValueOnce(wire('SESSION_BUSY', {}))
    expect((await runSlash(app, '/undo confirm')).text).toBe(tt('undo.refusedBusy', 'en'))
    undoPreview.mockRejectedValueOnce(new Error('boom'))
    await expect(runSlash(app, '/undo')).rejects.toThrow('boom')
  })

  it('says so when no turn changed files', async () => {
    const app = appWith(
      {},
      { undoPreview: vi.fn(async () => preview({ turn: undefined, undoable: false, files: [] })) },
    )
    expect((await runSlash(app, '/undo')).text).toBe(tt('undo.nothing', 'en'))
  })
})

describe('small info commands', () => {
  const usage = {
    model: { route: 'deepseek', id: 'v4', thinking: 'high' },
    context: { tokens: 1000, window: 10000 },
    cost: { usdMicros: 1_500_000 },
  }
  const status = (o: Record<string, unknown>, opening: unknown, controls: unknown, list: unknown = []) =>
    appWith(
      { session: { list: async () => ({ items: list }) } },
      { projectUIOpening: async () => opening, controls: async () => controls },
      { o },
    )

  it('/status shows every field, and `-` for a source that fails', async () => {
    const app = status(
      { commandsDir: '/h/commands' },
      { timeline: { usage, yolo: true } },
      { pending: [{ kind: 'follow_up' }, { kind: 'steer' }, { kind: 'prompt' }] },
      [{ ...meta('cur', '/w/a'), title: 'My\u001b[31m title' }],
    )
    const rows = Object.fromEntries(
      ((await runSlash(app, '/status')).text ?? '')
        .split('\n')
        .map((r) => r.split(/\s{2,}/) as [string, string]),
    )
    expect(rows).toMatchObject({
      Session: 'cur · My[31m title',
      Preset: 'standard',
      Model: 'deepseek/v4 (high)',
      Workspace: '/w/a',
      AGH_HOME: '/h',
      Connection: 'local daemon',
      Context: '1000 / 10000 (10.0%)',
      Cost: '$1.500',
      'Queued inputs': '2',
      YOLO: 'on',
    })
    // Over --connect the local home is not the daemon's, and a failing source does not hide the rest.
    const broken = appWith(
      { session: { list: async () => Promise.reject(new Error('x')) } },
      {
        projectUIOpening: async () => Promise.reject(new Error('x')),
        controls: async () => Promise.reject(new Error('x')),
      },
      { o: { remote: true, commandsDir: '/h/commands' } },
    )
    const text = (await runSlash(broken, '/status')).text ?? ''
    expect(text).toContain('remote daemon')
    expect(text).toMatch(/AGH_HOME\s+-$/m)
    expect(text).toMatch(/Model\s+-$/m)
    expect(text).toMatch(/Queued inputs\s+-$/m)
  })

  it('/status lists the extra directories and which language servers this PATH offers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-status-'))
    try {
      const exe = (dir: string, name: string) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, name), '#!/bin/sh\n', { mode: 0o755 })
      }
      const work = join(root, 'work')
      exe(join(root, 'bin'), 'gopls')
      exe(join(root, 'bin'), 'typescript-language-server')
      exe(join(work, 'node_modules', '.bin'), 'basedpyright-langserver') // inside the workspace: skipped
      vi.stubEnv('PATH', [join(work, 'node_modules', '.bin'), join(root, 'bin')].join(delimiter))
      const here = (o: Record<string, unknown>, list: unknown[]) => {
        const app = status(o, { timeline: { usage, yolo: false } }, { pending: [] }, list)
        return Object.assign(app, { cwd: work })
      }
      const dirs = ['/x/one', '/x/two']
      const text = (
        await runSlash(here({}, [{ ...meta('cur', work), additionalDirectories: dirs }]), '/status')
      ).text
      expect(text).toMatch(/Extra directories {2}\/x\/one\n {19}\/x\/two\n/)
      expect(text).toMatch(/Language servers\s+TS ✓ · Python ✗ · Go ✓$/m)
      // Without extra directories it says none; after the binary shows up on a safe PATH it is found.
      exe(join(root, 'bin'), 'pyright-langserver')
      const plain = (await runSlash(here({}, [meta('cur', work)]), '/status')).text
      expect(plain).toMatch(/Extra directories {2}none$/m)
      expect(plain).toMatch(/Python ✓/)
      // Over --connect the local PATH says nothing about the daemon.
      const remote = (await runSlash(here({ remote: true }, [meta('cur', work)]), '/status')).text
      expect(remote).toMatch(/Language servers\s+none$/m)
    } finally {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('/status aligns every value at one display column when labels are wide (zh-CN)', async () => {
    const app = Object.assign(
      status({}, { timeline: { usage, yolo: false } }, { pending: [] }, [
        { ...meta('cur', '/w/a'), additionalDirectories: ['/x/one', '/x/two'] },
      ]),
      { locale: 'zh-CN' as const },
    )
    const lines = ((await runSlash(app, '/status')).text ?? '').split('\n')
    // Value column = display width of everything before the first non-space after the label gap.
    const cols = lines.map((line) => displayWidth(line.match(/^(.*?\S?\s{2,})(?=\S)/)?.[1] ?? ''))
    expect(lines.length).toBeGreaterThan(10)
    expect(new Set(cols).size).toBe(1)
    expect(cols[0]).toBeGreaterThan(0)
  })

  const replies = (...texts: string[]) =>
    appWith(
      {},
      {
        projectUIOpening: async () => ({
          timeline: {
            nodes: [{ kind: 'user', text: 'q' }, ...texts.map((text) => ({ kind: 'assistant', text }))],
          },
        }),
      },
      { mouse: { copy: vi.fn() } },
    )

  it('/copy takes the nth reply from the end, or its last code block, and refuses bad input', async () => {
    const app = replies('first', 'a\n```ts\none\n```\nb\n```\ntwo\nlines\n```\n')
    const copy = (app as unknown as { mouse: { copy: ReturnType<typeof vi.fn> } }).mouse.copy
    expect(await runSlash(app, '/copy')).toEqual({})
    expect(copy).toHaveBeenLastCalledWith('a\n```ts\none\n```\nb\n```\ntwo\nlines\n```\n')
    await runSlash(app, '/copy 2')
    expect(copy).toHaveBeenLastCalledWith('first')
    await runSlash(app, '/copy code')
    expect(copy).toHaveBeenLastCalledWith('two\nlines')
    copy.mockClear()
    expect((await runSlash(app, '/copy 3')).text).toBe(tt('copy.range', 'en', { n: 2 }))
    expect((await runSlash(app, '/copy 0')).text).toBe(tt('copy.usage', 'en'))
    expect((await runSlash(app, '/copy x y')).text).toBe(tt('copy.usage', 'en'))
    expect((await runSlash(replies('plain'), '/copy code')).text).toBe(tt('copy.noCode', 'en'))
    expect((await runSlash(replies(), '/copy')).text).toBe(tt('copy.none', 'en'))
    expect(copy).not.toHaveBeenCalled()
  })

  const change = (path: string, extra: Record<string, unknown> = {}) => ({
    path,
    kind: 'modified',
    added: 2,
    removed: 1,
    diffStatus: 'available',
    freshness: 'current',
    ...extra,
  })
  const DIFF = '@@ -1 +1,2 @@\n-old\n+new\u001b[2J\n+more\n'

  it('/diff lists files, asks for their diffs, escapes control characters and explains what is missing', async () => {
    const workspaceChanges = vi.fn(async (q: { scope: string; path?: string }) => ({
      scope: q.scope,
      truncated: true,
      unrecorded: true,
      files: [
        change('a.ts'),
        change('bin\u001b[1m.png', { diffStatus: 'binary' }),
        change('c.ts', { freshness: 'changed' }),
      ],
      ...(q.path ? { selected: { ...change(q.path), diff: DIFF } } : {}),
    }))
    const app = appWith({}, { workspaceChanges })
    const result = await runSlash(app, '/diff')
    const text = result.text ?? ''
    expect(result.presentation).toBe('transcript')
    expect(text).toContain(tt('diff.header', 'en', { n: 3, added: 6, removed: 3 }))
    expect(text).toContain('  +2 -1 bin[1m.png (binary, no diff)')
    expect(text).toContain('  +2 -1 c.ts (changed again since)')
    expect(text).toContain('── a.ts\n@@ -1 +1,2 @@\n-old\n+new[2J\n+more')
    expect(text).not.toContain('\u001b')
    expect(text).toContain(tt('diff.truncated', 'en'))
    expect(text).toContain(tt('diff.unrecorded', 'en'))
    // The binary file is not asked for; the available ones are.
    expect(workspaceChanges.mock.calls.map((c) => c[0])).toEqual([
      { scope: 'session' },
      { scope: 'session', path: 'a.ts' },
      { scope: 'session', path: 'c.ts' },
    ])
    await runSlash(app, '/diff turn')
    expect(workspaceChanges.mock.calls[3]?.[0]).toEqual({ scope: 'turn' })
    workspaceChanges.mockClear()
    await runSlash(app, '/diff turn src/a b.ts')
    expect(workspaceChanges.mock.calls[0]?.[0]).toEqual({ scope: 'turn', path: 'src/a b.ts' })
  })

  it('/diff says so when nothing changed, and keeps a long diff to its first rows', async () => {
    const none = (unrecorded: boolean) =>
      appWith({}, { workspaceChanges: async () => ({ files: [], truncated: false, unrecorded }) })
    expect((await runSlash(none(false), '/diff')).text).toBe(tt('diff.none', 'en'))
    expect((await runSlash(none(false), '/diff turn')).text).toBe(tt('diff.noneTurn', 'en'))
    expect((await runSlash(none(true), '/diff')).text).toContain(tt('diff.unrecorded', 'en'))
    const long = Array.from({ length: 150 }, (_, i) => `+line ${i}`).join('\n')
    const app = appWith(
      {},
      {
        workspaceChanges: async (q: { path?: string }) => ({
          files: [change('a.ts')],
          truncated: false,
          unrecorded: false,
          ...(q.path ? { selected: { ...change('a.ts'), diff: long } } : {}),
        }),
      },
    )
    const text = (await runSlash(app, '/diff')).text ?? ''
    expect(text).toContain('+line 119')
    expect(text).not.toContain('+line 120')
    expect(text).toContain(tt('diff.more', 'en', { n: 30 }))
    expect((await runSlash(app, '/diff a.ts')).text).toContain('+line 149')
  })

  it('/diff output is tinted by the diff marks, wrapped rows included, and other commands stay dim', () => {
    const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
    const text = '  +1 -1 a.ts\n@@ -1 +1 @@\n-old\n+new line that is long enough to wrap\n context'
    const rows = localCommandView(ansi)('/diff', text).render(14)
    expect(rows).toContain(ansi.fg('faint', '@@ -1 +1 @@'))
    expect(rows).toContain(ansi.fg('danger', '-old'))
    const green = ansi.fg('success', 'x').split('x')[0] as string
    expect(rows.filter((r) => r.startsWith(green)).length).toBeGreaterThan(1)
    expect(rows.find((r) => r.includes('context'))).toBe(ansi.dim('context'))
    // Any other command keeps the dim style; a `+` there means nothing.
    const other = localCommandView(ansi)('/status', '+not a diff').render(40)
    expect(other).toContain(ansi.dim('+not a diff'))
  })

  it('/diff marks the changed words of a paired -/+ line, also on a wrapped row', () => {
    const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
    const mark = (s: string) => ansi.bold(ansi.underline(s))
    const text = '-let total = price * 2 + tax\n+let total = cost * 2 + tax'
    const wide = localCommandView(ansi)('/diff', text).render(60)
    expect(wide).toContain(ansi.fg('danger', `-let total = ${mark('price')} * 2 + tax`))
    expect(wide).toContain(ansi.fg('success', `+let total = ${mark('cost')} * 2 + tax`))
    const narrow = localCommandView(ansi)('/diff', text).render(14)
    expect(narrow.join('')).toContain(mark('price'))
  })

  it('/init submits a fixed message that depends on AGENTS.md, and writes nothing itself', async () => {
    const workspaceRead = vi.fn(async (path: string) => ({ path }))
    const app = appWith({}, { workspaceRead })
    expect(await runSlash(app, '/init')).toEqual({ prompt: tt('init.existing', 'en') })
    expect(workspaceRead).toHaveBeenCalledWith('AGENTS.md')
    workspaceRead.mockRejectedValueOnce(new Error('not found'))
    expect(await runSlash(app, '/init')).toEqual({ prompt: tt('init.new', 'en') })
    expect(tt('init.new', 'en')).not.toBe(tt('init.existing', 'en'))
    expect(tt('init.new', 'zh-CN')).not.toBe(tt('init.new', 'en'))
  })

  it('/review submits a fixed message, with the named scope appended when there is one', async () => {
    const app = appWith({}, {})
    expect(await runSlash(app, '/review')).toEqual({ prompt: tt('review.prompt', 'en') })
    const scoped = await runSlash(app, '/review  src/auth  HEAD~2 ')
    expect(scoped.prompt).toBe(
      `${tt('review.prompt', 'en')}\n\n${tt('review.scoped', 'en', { scope: 'src/auth  HEAD~2' })}`,
    )
    expect(tt('review.prompt', 'zh-CN')).not.toBe(tt('review.prompt', 'en'))
  })

  it('/btw asks the side question in a panel, and refuses an empty or over-long one with a hint', async () => {
    const panel = { version: 0, show: vi.fn(), close: vi.fn() }
    const statusBar = { setNotice: vi.fn() }
    const btw = vi.fn(async () => ({ text: 'an answer', model: 'm' }))
    const app = appWith({ session: { btw } }, {}, { usagePanel: panel, statusBar })
    expect(await runSlash(app, '/btw')).toEqual({ text: tt('btw.usage', 'en') })
    expect(await runSlash(app, `/btw ${'x'.repeat(4001)}`)).toEqual({ text: tt('btw.tooLong', 'en') })
    expect(btw).not.toHaveBeenCalled()
    expect(await runSlash(app, '/btw  why   was that? ')).toEqual({})
    expect(btw).toHaveBeenCalledWith('cur', 'why   was that?')
    expect(panel.show).toHaveBeenCalledWith(tt('btw.thinking', 'en'), tt('btw.title', 'en'))
    await vi.waitFor(() => expect(panel.show).toHaveBeenLastCalledWith('an answer', tt('btw.title', 'en')))
    // The panel was dismissed or replaced while the answer was on its way: it is dropped.
    btw.mockImplementationOnce(async () => {
      panel.version++
      return { text: 'late', model: 'm' }
    })
    await runSlash(app, '/btw again')
    await new Promise((r) => setTimeout(r, 10))
    expect(panel.show).not.toHaveBeenCalledWith('late', expect.anything())
  })
})

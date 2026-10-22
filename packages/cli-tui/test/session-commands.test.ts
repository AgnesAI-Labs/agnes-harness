import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlock } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
import { deliverableBasename } from '../src/deliverable-files.js'
import { tt } from '../src/locale-extended.js'

const meta = (sessionId: string, cwd: string) => ({
  sessionId,
  createdAt: '2026-10-01T00:00:00Z',
  lastSeq: 3,
  generation: 1,
  preset: 'standard',
  cwd,
})

function appWith(client: Record<string, unknown>, session: Record<string, unknown> = {}) {
  return {
    cwd: '/w/a',
    locale: 'en',
    refuseSwitch: () => false,
    session: { id: 'cur', client, ...session },
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
    expect(result.sessionChoices).toMatchObject([{ sessionId: 'cur', forkAt: 12, title: '#1 first prompt' }])
    expect(fork).not.toHaveBeenCalled()
    await runSlash(app, '/rewind 12')
    expect(fork).toHaveBeenCalledWith('cur', 12)
    fork.mockRejectedValueOnce(new Error('fork boundary must be a completed turn/end'))
    await expect(runSlash(app, '/rewind 13')).rejects.toThrow('completed turn/end')
    projectUIOpening.mockResolvedValueOnce({ timeline: { turns: [turn(3, undefined, false)], nodes: [] } })
    expect((await runSlash(app, '/rewind')).text).toBe(tt('session.noTurns', 'en'))
  })

  it('/new <dir> creates the session in that directory and shows a daemon refusal as it comes', async () => {
    const created = vi.fn(async () => {
      throw new Error('workspace not authorised')
    })
    const app = appWith({ session: { new: created } })
    await expect(runSlash(app, '/new ../b')).rejects.toThrow('workspace not authorised')
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/w/b' }))
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
      '1\tg1\tshell[31m\tsession\t2026-10-22T00:00:00Z\ta b\n2\tg2\tshell[31m\talways\t2026-10-22T00:00:00Z\ta b',
    )
    expect(sessionGrants).toHaveBeenCalledWith('cur')
    expect((await runSlash(app, '/grants revoke 2')).text).toContain('revoked g2\t')
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
  })
})

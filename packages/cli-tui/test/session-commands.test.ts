import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'
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

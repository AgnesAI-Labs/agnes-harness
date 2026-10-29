import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSignals } from '../src/terminal-signals.js'
import { cleanTitle, TITLE_MAX, WindowTitle } from '../src/window-title.js'

const dirs: string[] = []
const prefs = (content?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-title-'))
  dirs.push(dir)
  const path = join(dir, 'tui-theme.json')
  if (content !== undefined) writeFileSync(path, content)
  return path
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A session whose list holds `titles` by id; `list` counts the reads. */
function sessionWith(titles: Record<string, string | undefined>, id = 's1') {
  const list = vi.fn(async () => ({
    items: Object.entries(titles).map(([sessionId, title]) => ({ sessionId, ...(title ? { title } : {}) })),
  }))
  return { session: { id, client: { session: { list } } } as never, list, titles }
}
const idle = { opState: null }
const running = { opState: { turn: 1 } as never }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('cleanTitle', () => {
  it('removes control and bidi characters, makes one line, and stops at 80 characters', () => {
    expect(cleanTitle(`a\x1b]0;x\x07b\nc\td\x9c${String.fromCodePoint(0x202e)}e`)).toBe('a]0;xb c de')
    expect(cleanTitle('  spaced \r\n out  ')).toBe('spaced out')
    expect(Array.from(cleanTitle('长'.repeat(200)))).toHaveLength(TITLE_MAX)
    expect(Array.from(cleanTitle('😀'.repeat(200)))).toHaveLength(TITLE_MAX)
    expect(TITLE_MAX).toBe(80)
  })
})

describe('WindowTitle', () => {
  const state = { busy: false, pending: false }

  it('builds the text for each mode and marks a running turn and a waiting approval', () => {
    const { session } = sessionWith({ s1: 'Fix the build' })
    const title = new WindowTitle({ cwd: '/work/proj', session: () => session })
    expect(title.text(state)).toBe('agh · proj')
    expect(title.text({ busy: true, pending: false })).toBe('● agh · proj')
    expect(title.text({ busy: true, pending: true })).toBe('! agh · proj')
    title.mode = 'off'
    expect(title.text(state)).toBeUndefined()
  })

  it('reads the saved mode, falls back to the default on anything else', () => {
    expect(new WindowTitle({ cwd: '/w/p', path: prefs('{"title":"off"}') }).mode).toBe('off')
    expect(new WindowTitle({ cwd: '/w/p', path: prefs('{"title":"session-cwd"}') }).mode).toBe('session-cwd')
    for (const bad of ['{"title":"loud"}', '{"title":3}', '{broken', '[]', undefined])
      expect(new WindowTitle({ cwd: '/w/p', path: prefs(bad) }).mode).toBe('cwd')
    expect(new WindowTitle({ cwd: '/w/p' }).mode).toBe('cwd')
  })

  it('uses the session name when the mode asks for it, and the directory until it is known', async () => {
    const { session, list } = sessionWith({ s1: 'Fix the build', s2: 'Other' })
    const changed = vi.fn()
    const title = new WindowTitle({ cwd: '/work/proj', session: () => session, changed })
    title.command(['session'], 'en')
    expect(title.text(state)).toBe('agh · proj')
    await settle()
    expect(title.text(state)).toBe('agh · Fix the build')
    expect(changed).toHaveBeenCalled()
    title.command(['session-cwd'], 'en')
    await settle()
    expect(title.text(state)).toBe('agh · Fix the build · proj')
    expect(list).toHaveBeenCalled()
  })

  it('reads again when a session opens and when a turn ends, never in cwd mode', async () => {
    const titles: Record<string, string | undefined> = { s1: undefined }
    const { session, list } = sessionWith(titles)
    const cwdOnly = new WindowTitle({ cwd: '/w/p', session: () => session })
    cwdOnly.tick({ sessionId: 's1', ...idle })
    await settle()
    expect(list).not.toHaveBeenCalled()

    const title = new WindowTitle({ cwd: '/w/p', path: prefs('{"title":"session"}'), session: () => session })
    title.tick({ sessionId: 's1', ...idle })
    await settle()
    expect(list).toHaveBeenCalledTimes(1)
    expect(title.text({ busy: false, pending: false })).toBe('agh · p')
    // The daemon names the session during the turn; the end of the turn picks it up.
    titles.s1 = 'Named later'
    title.tick({ sessionId: 's1', ...running })
    title.tick({ sessionId: 's1', ...idle })
    await settle()
    expect(title.text({ busy: false, pending: false })).toBe('agh · Named later')
    title.tick({ sessionId: 's1', ...idle })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps going when the list cannot be read', async () => {
    const title = new WindowTitle({
      cwd: '/w/p',
      path: prefs('{"title":"session"}'),
      session: () =>
        ({ id: 's1', client: { session: { list: () => Promise.reject(new Error('down')) } } }) as never,
    })
    title.tick({ sessionId: 's1', ...idle })
    await settle()
    expect(title.text({ busy: false, pending: false })).toBe('agh · p')
  })

  it('/title sets and saves the mode beside the other preferences, reports it, and refuses the rest', () => {
    const path = prefs('{"theme":"dark","statusLine":{"hide":["cwd"]}}')
    const title = new WindowTitle({ cwd: '/w/p', path })
    expect(title.command(['off'], 'en')).toBe('Window title: off (the terminal title is left alone)')
    expect(title.mode).toBe('off')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      theme: 'dark',
      statusLine: { hide: ['cwd'] },
      title: 'off',
    })
    expect(new WindowTitle({ cwd: '/w/p', path }).mode).toBe('off')
    expect(title.command([], 'en')).toBe(
      'Window title: off (the terminal title is left alone) · usage: /title off|session|cwd|session-cwd',
    )
    expect(title.command(['cwd'], 'zh-CN')).toBe('窗口标题：目录名')
    for (const bad of [['loud'], ['off', 'cwd']])
      expect(title.command(bad, 'en')).toBe('usage: /title off|session|cwd|session-cwd')
    expect(title.mode).toBe('cwd')
    expect(new WindowTitle({ cwd: '/w/p' }).command(['session'], 'en')).toContain('not saved')
  })
})

describe('the window title on the terminal', () => {
  const rig = (title: WindowTitle, cwd = '/work/proj') => {
    const writes: string[] = []
    const busy = { value: false }
    const signals = new TerminalSignals(
      { write: (s) => writes.push(s) },
      cwd,
      () => busy.value,
      { count: 0 },
      new Map(),
      undefined,
      title,
    )
    return { writes, busy, signals }
  }
  const osc = (writes: string[]) => writes.filter((w) => w.startsWith('\x1b]2;'))

  it('writes no escape of any kind while the mode is off, and starts writing when it is turned on', () => {
    const title = new WindowTitle({ cwd: '/work/proj' })
    title.mode = 'off'
    const { writes, busy, signals } = rig(title)
    signals.start()
    busy.value = true
    signals.sync()
    signals.stop()
    expect(writes).toEqual([])
    title.mode = 'cwd'
    busy.value = false
    signals.start()
    expect(writes).toEqual(['\x1b[22;0t', '\x1b]2;agh · proj\x07'])
    busy.value = true
    signals.sync()
    expect(osc(writes).at(-1)).toBe('\x1b]2;● agh · proj\x07')
    signals.stop()
    expect(writes.at(-1)).toBe('\x1b[23;0t')
  })

  it('never lets a name carry a control character or more than 80 characters onto the terminal', () => {
    const bidi = String.fromCodePoint(0x202e)
    const { writes, signals } = rig(
      new WindowTitle({ cwd: `/work/pr\x1b]0;x\x07o${bidi}j${'x'.repeat(200)}` }),
    )
    signals.start()
    const [title = ''] = osc(writes)
    const body = title.slice('\x1b]2;'.length, -1)
    expect(Array.from(body)).toHaveLength(TITLE_MAX)
    expect(body).toBe(cleanTitle(body))
    expect(body).not.toContain(bidi)
    // Only the sequence's own opening escape and closing bell are control characters.
    expect(Array.from(title).filter((c) => c < ' ')).toEqual(['\x1b', '\x07'])
  })
})

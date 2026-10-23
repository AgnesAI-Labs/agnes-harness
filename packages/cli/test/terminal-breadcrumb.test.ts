import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { sessionToOpen } from '../src/modes/print.js'
import { terminalBreadcrumb, terminalId } from '../src/terminal-breadcrumb.js'
import type { Booted } from '../src/types.js'

const dirs: string[] = []
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'agh-crumb-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A daemon whose listing is newest first; `text` narrows it the way the real search hint does. */
const daemon = (rows: Array<{ sessionId: string; archived?: boolean }>) =>
  ({
    client: {
      session: {
        list: async (q: { q?: { text?: string } }) => ({
          items: rows.filter((r) => q.q?.text === undefined || r.sessionId === q.q.text),
        }),
      },
    },
  }) as unknown as Booted

describe('terminal id', () => {
  it('takes the first identifier present, multiplexers before terminals', () => {
    expect(terminalId({})).toBeUndefined()
    expect(terminalId({ TERM_SESSION_ID: 'a' })).toBe('term:a')
    expect(terminalId({ TERM_SESSION_ID: 'a', ITERM_SESSION_ID: 'b' })).toBe('iterm:b')
    expect(terminalId({ ITERM_SESSION_ID: 'b', WEZTERM_PANE: '3' })).toBe('wezterm:3')
    expect(terminalId({ WEZTERM_PANE: '3', KITTY_WINDOW_ID: '9' })).toBe('kitty:9')
    expect(terminalId({ KITTY_WINDOW_ID: '9', TMUX_PANE: '%1', TMUX: '/tmp/sock,1,0' })).toBe(
      'tmux:/tmp/sock:%1',
    )
    expect(terminalId({ TMUX_PANE: '%1', ZELLIJ_PANE_ID: '2', ZELLIJ_SESSION_NAME: 's' })).toBe('zellij:s:2')
    expect(terminalId({ WT_SESSION: 'w' })).toBe('wt:w')
  })
})

describe('--continue with a terminal pane breadcrumb', () => {
  const cwd = '/work/proj'
  const env = (pane: string) => ({ TMUX_PANE: pane, TMUX: '/tmp/sock,1,0' })
  const rows = [{ sessionId: 'newest' }, { sessionId: 'pane-a' }, { sessionId: 'pane-b' }]
  const resume = (b: Booted, crumb?: ReturnType<typeof terminalBreadcrumb>) =>
    sessionToOpen(b, parseArgs(['--continue']), cwd, crumb)

  it('gives two panes in one directory each their own session, and 0600 files', async () => {
    const h = home()
    const a = terminalBreadcrumb(h, env('%1'))
    const b = terminalBreadcrumb(h, env('%2'))
    a?.write('pane-a', cwd)
    b?.write('pane-b', cwd)
    expect(await resume(daemon(rows), a)).toBe('pane-a')
    expect(await resume(daemon(rows), b)).toBe('pane-b')
    const dir = join(h, 'terminal-sessions')
    const files = readdirSync(dir)
    expect(files).toHaveLength(2)
    for (const f of files) {
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
      expect(f).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('falls back to the newest session for another directory, an archived or a missing session', async () => {
    const h = home()
    const a = terminalBreadcrumb(h, env('%1'))
    a?.write('pane-a', '/elsewhere')
    expect(await resume(daemon(rows), a)).toBe('newest')
    a?.write('pane-a', cwd)
    expect(await resume(daemon([{ sessionId: 'newest' }, { sessionId: 'pane-a', archived: true }]), a)).toBe(
      'newest',
    )
    expect(await resume(daemon([{ sessionId: 'newest' }]), a)).toBe('newest')
  })

  it('never resumes a breadcrumb hidden by the daemon owner filter', async () => {
    const a = terminalBreadcrumb(home(), env('%1'))
    a?.write('foreign-session', cwd)
    expect(await resume(daemon([{ sessionId: 'mine' }]), a)).toBe('mine')
    await expect(resume(daemon([]), a)).rejects.toThrow(/found no session/)
  })

  it('behaves as before without a pane id, and ignores a corrupt file or an unwritable home', async () => {
    expect(terminalBreadcrumb(home(), {})).toBeUndefined()
    expect(await resume(daemon(rows))).toBe('newest')
    const h = home()
    const a = terminalBreadcrumb(h, env('%1'))
    a?.write('pane-a', cwd)
    const dir = join(h, 'terminal-sessions')
    writeFileSync(join(dir, readdirSync(dir)[0] as string), '{not json')
    expect(await resume(daemon(rows), a)).toBe('newest')
    // A file where the directory should be: writing fails silently and reading finds nothing.
    const blocked = home()
    writeFileSync(join(blocked, 'terminal-sessions'), 'x')
    const c = terminalBreadcrumb(blocked, env('%1'))
    expect(() => c?.write('pane-a', cwd)).not.toThrow()
    expect(c?.read(cwd)).toBeUndefined()
  })
})

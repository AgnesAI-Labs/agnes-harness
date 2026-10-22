import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeLayout } from '@agnes/host'

/**
 * What identifies this terminal pane, from the first of these the terminal sets. A multiplexer comes
 * before the terminal around it, because a pane inside tmux inside iTerm is the tmux pane. Names only
 * a session or socket can share a pane id across servers, so those are part of the identity.
 */
export function terminalId(env: NodeJS.ProcessEnv): string | undefined {
  const at = (name: string): string | undefined => (env[name] ? env[name] : undefined)
  const pane = at('ZELLIJ_PANE_ID')
  if (pane) return `zellij:${at('ZELLIJ_SESSION_NAME') ?? ''}:${pane}`
  const tmuxPane = at('TMUX_PANE')
  // $TMUX is `socket,server-pid,session`; the socket path tells two tmux servers apart.
  if (tmuxPane) return `tmux:${(at('TMUX') ?? '').split(',')[0]}:${tmuxPane}`
  for (const [name, label] of [
    ['KITTY_WINDOW_ID', 'kitty'],
    ['WEZTERM_PANE', 'wezterm'],
    ['ITERM_SESSION_ID', 'iterm'],
    ['TERM_SESSION_ID', 'term'],
    ['WT_SESSION', 'wt'],
  ] as const) {
    const value = at(name)
    if (value) return `${label}:${value}`
  }
  return undefined
}

export type Breadcrumb = {
  /** The session last used in this pane for `cwd`, if one was left. Never throws. */
  read(cwd: string): string | undefined
  /** Remember `sessionKey` for this pane. Failures are ignored: a breadcrumb is a convenience. */
  write(sessionKey: string, cwd: string): void
}

/** Present only when the terminal identifies itself; without it nothing is read or written. */
export function terminalBreadcrumb(home: string, env: NodeJS.ProcessEnv): Breadcrumb | undefined {
  const id = terminalId(env)
  if (id === undefined) return undefined
  const file = (): string =>
    join(homeLayout(home).terminalSessions, createHash('sha256').update(id).digest('hex').slice(0, 32))
  return {
    read(cwd) {
      try {
        const value = JSON.parse(readFileSync(file(), 'utf8')) as { sessionKey?: unknown; cwd?: unknown }
        return typeof value.sessionKey === 'string' && value.cwd === cwd ? value.sessionKey : undefined
      } catch {
        return undefined
      }
    },
    write(sessionKey, cwd) {
      let temporary: string | undefined
      try {
        const target = file()
        mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
        temporary = `${target}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify({ sessionKey, cwd, at: new Date().toISOString() }), {
          mode: 0o600,
        })
        // The mode above is masked by the umask; the file must be private whatever it is.
        chmodSync(temporary, 0o600)
        renameSync(temporary, target)
        temporary = undefined
      } catch {
        // Ignored on purpose; the temporary file of a failed write is removed below.
      } finally {
        if (temporary !== undefined) rmSync(temporary, { force: true })
      }
    },
  }
}

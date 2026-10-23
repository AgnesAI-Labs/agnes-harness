import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homeLayout } from '@agnes/host'
import { createPrivateDirectorySync, createPrivateFileSync, hasPrivateDaclSync } from '@agnes/system-node'
import type { Breadcrumb } from './modes/print.js'

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
        const directory = dirname(target)
        try {
          createPrivateDirectorySync(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const stat = lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateDaclSync(directory)) return
        const pending = `${target}.${randomUUID()}.tmp`
        const fd = createPrivateFileSync(pending)
        temporary = pending
        try {
          writeFileSync(fd, JSON.stringify({ sessionKey, cwd, at: new Date().toISOString() }))
        } finally {
          closeSync(fd)
        }
        renameSync(temporary, target)
        temporary = undefined
      } catch {
        // Ignored on purpose; the temporary file of a failed write is removed below.
      } finally {
        if (temporary !== undefined) {
          try {
            rmSync(temporary, { force: true })
          } catch {
            // A breadcrumb must never make a successful CLI operation fail.
          }
        }
      }
    },
  }
}

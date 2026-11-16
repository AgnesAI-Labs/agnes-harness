import type { SessionEnvironment } from '@agnes/protocol'
import { baseEnvironment, type ExecAdapter } from './exec.js'

/** How the commands' operating system reads variable names: Windows names are case-insensitive. */
export type CommandEnvironmentFlavor = 'posix' | 'win32'

/**
 * A command's environment under its session's own environment. The order is the point: first the floor every command
 * gets (`baseEnvironment`, which already leaves the daemon's credentials, git configuration and `gh` variables
 * behind), then the caller's variables, then the session's: its removals, its variables, and its directories first on
 * PATH. A removed variable stays in the result as `undefined`, which every runner drops when it spawns or serializes
 * the environment, so it also removes a floor variable the runner would otherwise add back. For Windows commands
 * (`win32`), names compare without case: each variable keeps one entry, in the spelling it first had, so the
 * directories go first on an existing `Path` rather than into a second `PATH`, and a removal reaches every spelling.
 */
export function sessionCommandEnvironment(
  caller: Readonly<Record<string, string>> | undefined,
  session: SessionEnvironment,
  floor: Readonly<Record<string, string>> = baseEnvironment(),
  flavor: CommandEnvironmentFlavor = 'posix',
): Record<string, string> {
  if (flavor === 'win32') return windowsCommandEnvironment(caller, session, floor)
  const env: Record<string, string | undefined> = { ...floor, ...caller }
  for (const name of session.unset ?? []) env[name] = undefined
  Object.assign(env, session.set)
  if (session.pathPrepend?.length)
    env.PATH = [...session.pathPrepend, ...(env.PATH ? [env.PATH] : [])].join(':')
  return env as Record<string, string>
}

function windowsCommandEnvironment(
  caller: Readonly<Record<string, string>> | undefined,
  session: SessionEnvironment,
  floor: Readonly<Record<string, string>>,
): Record<string, string> {
  // Keyed by the upper-case name; each entry keeps the spelling the variable first had.
  const env = new Map<string, readonly [name: string, value: string | undefined]>()
  const put = (name: string, value: string | undefined): void => {
    const key = name.toUpperCase()
    env.set(key, [env.get(key)?.[0] ?? name, value])
  }
  for (const layer of [floor, caller ?? {}])
    for (const [name, value] of Object.entries(layer)) put(name, value)
  for (const name of session.unset ?? []) put(name, undefined)
  for (const [name, value] of Object.entries(session.set ?? {})) put(name, value)
  if (session.pathPrepend?.length) {
    const path = env.get('PATH')?.[1]
    put('PATH', [...session.pathPrepend, ...(path ? [path] : [])].join(';'))
  }
  return Object.fromEntries(env.values()) as Record<string, string>
}

/**
 * The runner a session's workspace fence uses: every command and process gets `read()`'s environment, read when it
 * starts, so a changed environment applies from the next command on. A `read` that throws (a damaged record) refuses
 * the command rather than running it without the environment its session was given. `flavor` is the operating system
 * the commands run on (see `sessionCommandEnvironment`).
 */
export function withSessionEnvironment(
  exec: ExecAdapter,
  read: () => SessionEnvironment | undefined,
  flavor: CommandEnvironmentFlavor = 'posix',
): ExecAdapter {
  const apply = <T extends { env?: Record<string, string> }>(options: T): T => {
    const session = read()
    return session
      ? { ...options, env: sessionCommandEnvironment(options.env, session, baseEnvironment(), flavor) }
      : options
  }
  const open = exec.openProcess?.bind(exec)
  return {
    run: (argv, options) => {
      try {
        return exec.run(argv, apply(options))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    ...(open ? { openProcess: async (argv, options) => open(argv, apply(options)) } : {}),
    killAll: () => exec.killAll(),
  }
}

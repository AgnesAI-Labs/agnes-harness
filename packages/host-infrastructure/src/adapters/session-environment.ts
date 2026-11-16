import { delimiter } from 'node:path'
import type { SessionEnvironment } from '@agnes/protocol'
import { baseEnvironment, type ExecAdapter } from './exec.js'

/**
 * A command's environment under its session's own environment. The order is the point: first the floor every command
 * gets (`baseEnvironment`, which already leaves the daemon's credentials, git configuration and `gh` variables
 * behind), then the caller's variables, then the session's: its removals, its variables, and its directories first on
 * PATH. A removed variable stays in the result as `undefined`, which every runner drops when it spawns or serializes
 * the environment, so it also removes a floor variable the runner would otherwise add back.
 */
export function sessionCommandEnvironment(
  caller: Readonly<Record<string, string>> | undefined,
  session: SessionEnvironment,
  floor: Readonly<Record<string, string>> = baseEnvironment(),
): Record<string, string> {
  const env: Record<string, string | undefined> = { ...floor, ...caller }
  for (const name of session.unset ?? []) env[name] = undefined
  Object.assign(env, session.set)
  if (session.pathPrepend?.length)
    env.PATH = [...session.pathPrepend, ...(env.PATH ? [env.PATH] : [])].join(delimiter)
  return env as Record<string, string>
}

/**
 * The runner a session's workspace fence uses: every command and process gets `read()`'s environment, read when it
 * starts, so a changed environment applies from the next command on. A `read` that throws (a damaged record) refuses
 * the command rather than running it without the environment its session was given.
 */
export function withSessionEnvironment(
  exec: ExecAdapter,
  read: () => SessionEnvironment | undefined,
): ExecAdapter {
  const apply = <T extends { env?: Record<string, string> }>(options: T): T => {
    const session = read()
    return session ? { ...options, env: sessionCommandEnvironment(options.env, session) } : options
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

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Everything between a control character and a space: a title must not move a terminal's cursor. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the purpose.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const TITLE_MAX = 60

export type SessionRow = { sessionId: string; title?: string | undefined; archived?: boolean | undefined }

/**
 * The lines `agh __complete sessions [prefix]` prints, `key<TAB>title`. A shell calls this on every
 * TAB, so it is bounded: it gives up after `timeoutMs` and any failure prints nothing, because a
 * completion that errors or hangs is worse than none.
 */
export async function completeSessions(
  prefix: string,
  list: () => Promise<SessionRow[]>,
  timeoutMs = 300,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const rows = await Promise.race([
      list(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    return rows
      .filter((row) => row.archived !== true && row.sessionId.startsWith(prefix))
      .map(
        (row) =>
          `${row.sessionId.replace(CONTROL, '')}\t${(row.title ?? '').replace(CONTROL, ' ').slice(0, TITLE_MAX)}`,
      )
  } catch {
    return []
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Prepare to read the live sessions of an already-running local daemon, which never starts one.
 * Loading the daemon, Host and SDK modules is the slow part of a cold start (several hundred
 * milliseconds), so it happens here, before the caller's deadline starts; the returned reader is
 * what that deadline bounds. A home that never ran a daemon is answered without loading anything.
 */
export async function daemonSessionReader(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<(budgetMs: number) => Promise<SessionRow[]>> {
  const { resolveHome } = await import('../boot/inputs.js')
  const home = resolveHome(env)
  if (!existsSync(join(home, 'daemon'))) return async () => []
  const [{ readDaemonDiscovery }, { connectionScope }, { ensureLocalBackend }] = await Promise.all([
    import('@agnes/daemon'),
    import('../boot/connection-scope.js'),
    import('../boot/backend.js'),
  ])
  return async (budgetMs) => {
    const scope = await connectionScope({ env, cwd, home })
    if (!(await readDaemonDiscovery(scope, { identityTimeoutMs: Math.max(50, budgetMs - 100) }))) return []
    // `attach` never spawns; the readiness deadline is the same budget the caller races against.
    const backend = await ensureLocalBackend({
      env,
      cwd,
      home,
      attach: { scope },
      retainClient: { locale: 'en' },
      readinessTimeoutMs: budgetMs,
    })
    try {
      const page = await backend.client?.session.list({ limit: 100 })
      return page?.items ?? []
    } finally {
      await backend.closeClient().catch(() => undefined)
    }
  }
}

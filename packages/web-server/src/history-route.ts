import { homedir } from 'node:os'
import { isAbsolute, join, parse, sep } from 'node:path'
import {
  AGH_DIR,
  type AppServerParams,
  type AppServerResult,
  httpRpcError,
  normalizeRpcError,
  type RpcError,
  validateMethod,
} from '@agnes/protocol'

export const HISTORY_SEARCH_PATH = '/api/history-search'

export type HistoryRouteResult = { status: number; body: unknown }

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Default ledger directory when the launcher cannot pass `historyDataDir`.
 * This is the same home/data join as the host path helper. web-server cannot import that helper.
 */
export function defaultHistoryDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const current = nonEmpty(env.AGH_HOME)
  const explicit = current ?? nonEmpty(env.AGNES_HOME)
  const selected = explicit ?? nonEmpty(env.HOME) ?? homedir()
  if (explicit !== undefined && !isAbsolute(explicit))
    throw new Error('history data directory is not absolute')
  if (sep === '\\' && (!isAbsolute(selected) || parse(selected).root.length <= 1))
    throw new Error('history data directory is not absolute')
  const home = explicit ?? join(selected, AGH_DIR)
  return join(home, 'data')
}

/** Same-origin compatibility adapter; the daemon supplies the search port. */
export async function handleHistorySearch(input: {
  method: string | undefined
  search: string
  origin: string | undefined
  site: string | string[] | undefined
  expectedOrigin: string
  searchHistory?: (
    params: AppServerParams<'_agnes/v1/admin.history.search'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.history.search'>>
}): Promise<HistoryRouteResult> {
  const site = Array.isArray(input.site) ? input.site[0] : input.site
  const failure = (status: number, code: string) => ({ status, body: { error: httpRpcError(status, code) } })
  if (
    (site !== undefined && site !== 'same-origin' && site !== 'none') ||
    (input.origin !== undefined && input.origin !== input.expectedOrigin)
  )
    return failure(403, 'ORIGIN_REJECTED')
  if (input.method !== 'GET') return failure(405, 'METHOD_NOT_ALLOWED')
  if (!input.searchHistory) return failure(503, 'UNAVAILABLE')
  const query = new URLSearchParams(input.search)
  const params = {
    query: query.get('q') ?? '',
    title: query.get('title') ?? '',
    workspace: query.get('workspace') ?? '',
    ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
  }
  if (!validateMethod('_agnes/v1/admin.history.search', 'params', params).ok)
    return failure(400, 'INVALID_REQUEST')
  try {
    return { status: 200, body: await input.searchHistory(params) }
  } catch (error) {
    const rpc = (error as { rpc?: RpcError })?.rpc
    return rpc
      ? {
          status: rpc.code === -32006 ? 403 : rpc.code === -32602 ? 400 : 503,
          body: { error: normalizeRpcError(rpc) },
        }
      : failure(503, 'UNAVAILABLE')
  }
}

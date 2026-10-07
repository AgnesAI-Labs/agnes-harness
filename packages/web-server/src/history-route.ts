import { homedir } from 'node:os'
import { isAbsolute, join, parse, sep } from 'node:path'
import { HistoryIndexError, searchHistoryDirectory } from '@agnes/history-index'
import { AGH_DIR } from '@agnes/protocol'

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

function failure(error: unknown): HistoryRouteResult {
  if (error instanceof HistoryIndexError) {
    if (error.code === 'MULTIPLE_OWNERS') return { status: 403, body: { error: { code: 'MULTIPLE_OWNERS' } } }
    if (
      error.code === 'INVALID_REQUEST' ||
      error.code === 'INVALID_QUERY' ||
      error.code === 'INVALID_CURSOR' ||
      error.code === 'STALE_CURSOR'
    )
      return { status: 400, body: { error: { code: error.code } } }
  }
  return { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
}

export function handleHistorySearch(input: {
  method: string | undefined
  search: string
  origin: string | undefined
  site: string | string[] | undefined
  expectedOrigin: string
  dataDir?: string
}): HistoryRouteResult {
  const site = Array.isArray(input.site) ? input.site[0] : input.site
  if (
    (site !== undefined && site !== 'same-origin' && site !== 'none') ||
    (input.origin !== undefined && input.origin !== input.expectedOrigin)
  )
    return { status: 403, body: { error: { code: 'ORIGIN_REJECTED' } } }
  if (input.method !== 'GET') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } }
  const params = new URLSearchParams(input.search)
  const query = params.get('q') ?? ''
  const title = params.get('title') ?? ''
  const workspace = params.get('workspace') ?? ''
  const cursor = params.get('cursor') ?? undefined
  let dataDir: string
  try {
    dataDir = input.dataDir ?? defaultHistoryDataDir()
  } catch {
    return { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
  }
  try {
    const page = searchHistoryDirectory(dataDir, {
      query,
      title,
      workspace,
      ...(cursor === undefined ? {} : { cursor }),
    })
    return {
      status: 200,
      body: { items: page.items, truncated: page.truncated, ...(page.next ? { next: page.next } : {}) },
    }
  } catch (error) {
    return failure(error)
  }
}

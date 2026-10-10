import { isAbsolute, join } from 'node:path'
import { HistoryIndexError } from './errors.js'
import { type HistoryCorpus, readLedgerDirectory, sourceStamp } from './ledger.js'
import { type HistoryAccess, type HistoryPage, openHistoryIndex } from './store.js'

/** One ledger parse per directory stamp, shared by a search that re-enters while it is in use. */
const corpusFlights = new Map<string, HistoryCorpus>()

function ledgerCorpus(dataDir: string, stamp: string): { corpus: HistoryCorpus; owner: boolean } {
  const key = `${dataDir}\0${stamp}`
  const shared = corpusFlights.get(key)
  if (shared) return { corpus: shared, owner: false }
  const corpus = readLedgerDirectory(dataDir)
  corpusFlights.set(key, corpus)
  return { corpus, owner: true }
}

export function historyIndexPath(dataDir: string): string {
  return join(dataDir, 'history-index.db')
}

export type DirectoryQuery = {
  query: string
  title: string
  workspace: string
  cursor?: string
  limit?: number
}

/**
 * Rebuild the derived index from the ledger, then search it.
 * A data directory with more than one recorded principal is refused. The caller cannot supply one.
 */
export function searchHistoryDirectory(dataDir: string, request: DirectoryQuery): HistoryPage {
  if (!isAbsolute(dataDir) || dataDir.includes('\u0000')) throw new HistoryIndexError('INVALID_REQUEST')
  if (request.query.length > 256 || request.title.length > 256) throw new HistoryIndexError('INVALID_REQUEST')
  if (
    request.workspace &&
    (request.workspace.includes('\u0000') ||
      request.workspace.length > 4096 ||
      !isAbsolute(request.workspace))
  )
    throw new HistoryIndexError('INVALID_REQUEST')
  const index = openHistoryIndex(historyIndexPath(dataDir))
  let flight: { key: string; owner: boolean } | undefined
  try {
    const stamp = sourceStamp(dataDir)
    if (index.stamp() !== stamp || index.generation() === 0) {
      const key = `${dataDir}\0${stamp}`
      const loaded = ledgerCorpus(dataDir, stamp)
      flight = { key, owner: loaded.owner }
      index.rebuild(loaded.corpus)
    }
    const principals = index.principals()
    if (principals.length > 1) throw new HistoryIndexError('MULTIPLE_OWNERS')
    const access: HistoryAccess = { kind: 'local', principal: principals[0] ?? '' }
    return index.query({
      access,
      kind: request.query.trim() ? 'search' : 'list',
      query: request.query,
      title: request.title,
      workspace: request.workspace,
      sessionId: '',
      omitSelf: false,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    })
  } finally {
    if (flight?.owner) corpusFlights.delete(flight.key)
    index.close()
  }
}

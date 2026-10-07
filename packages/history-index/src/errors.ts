export const HISTORY_DENIED = 'Not authorized to read that session.'
export const HISTORY_NOT_FOUND = 'Event not found.'
export const HISTORY_UNMOUNTED = 'History search is not mounted.'
export const HISTORY_FAILED = 'History search failed.'
export const HISTORY_INVALID_QUERY = 'The query is not valid.'
export const HISTORY_NARROW = 'Results are capped. Narrow the query.'
export const HISTORY_UNAVAILABLE = '[unavailable]'

export type HistoryCode =
  | 'LEDGER'
  | 'INDEX'
  | 'INVALID_QUERY'
  | 'INVALID_REQUEST'
  | 'STALE_CURSOR'
  | 'INVALID_CURSOR'
  | 'MULTIPLE_OWNERS'
  | 'DENIED'
  | 'NOT_FOUND'
  | 'UNMOUNTED'
  | 'FAILED'

const MESSAGES: Record<HistoryCode, string> = {
  LEDGER: 'History ledger cannot be read.',
  INDEX: 'History index cannot be opened.',
  INVALID_QUERY: HISTORY_INVALID_QUERY,
  INVALID_REQUEST: 'History search request is not valid.',
  STALE_CURSOR: 'History search page is out of date.',
  INVALID_CURSOR: 'History search page is not valid.',
  MULTIPLE_OWNERS: 'History search found multiple owners.',
  DENIED: HISTORY_DENIED,
  NOT_FOUND: HISTORY_NOT_FOUND,
  UNMOUNTED: HISTORY_UNMOUNTED,
  FAILED: HISTORY_FAILED,
}

export class HistoryIndexError extends Error {
  readonly code: HistoryCode

  constructor(code: HistoryCode, message = MESSAGES[code]) {
    super(message)
    this.name = 'HistoryIndexError'
    this.code = code
  }
}

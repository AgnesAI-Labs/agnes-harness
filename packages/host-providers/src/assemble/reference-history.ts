import { createHash } from 'node:crypto'
import type { ReferenceContext, ReferenceLimits } from '@agnes/extension-api'
import {
  type HistoryAccess,
  type HistoryIndex,
  historyIndexPath,
  openHistoryIndex,
  readLedgerDirectory,
  sourceStamp,
} from '@agnes/history-index'
import { boundReferenceText } from './reference-text.js'

export function referenceHistory(
  dataDir: string,
  self: string,
  workspace: string,
  limits: ReferenceLimits,
): ReferenceContext['sessions'] {
  const withIndex = <T>(read: (index: HistoryIndex, access: HistoryAccess) => T): T => {
    const index = openHistoryIndex(historyIndexPath(dataDir))
    try {
      if (index.stamp() !== sourceStamp(dataDir) || index.generation() === 0)
        index.rebuild(readLedgerDirectory(dataDir))
      const principal = index.principalOf(self)
      if (!principal) throw new Error('Reference history permission unavailable.')
      return read(index, { kind: 'caller', self, workspace, principal })
    } finally {
      index.close()
    }
  }
  return {
    async search(query) {
      return withIndex((index, access) => {
        const page = index.query({
          access,
          kind: query.trim() ? 'search' : 'list',
          query,
          title: '',
          workspace: '',
          sessionId: '',
          omitSelf: true,
          limit: 20,
        })
        return {
          items: page.items.map((item) => ({
            source: 'session',
            id: item.sessionId,
            label: item.title || item.sessionId,
            description: item.snippet,
          })),
          truncated: page.truncated || !!page.next,
        }
      })
    },
    async read(id) {
      return withIndex((index, access) => {
        if (id === self) throw new Error('Cannot reference the current session.')
        const value = index.referenceExcerpt(access, id)
        const snapshot = JSON.stringify({ id, title: value.title, excerpt: value.text })
        const text = value.truncated
          ? '[TRUNCATED: earlier messages or indexed text omitted]\n' + value.text
          : value.text
        const bounded = boundReferenceText(text, limits)
        return {
          label: value.title,
          text: bounded.text,
          hash: createHash('sha256').update(snapshot).digest('hex'),
          truncated: value.truncated || bounded.truncated,
        }
      })
    },
  }
}

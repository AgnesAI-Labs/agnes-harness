import type { ReactNode } from 'react'

/**
 * One trace row's summary, split into the parts a reader scans for: a tool's name, its arguments
 * and what came back; a context record's label and its raw payload. The text is exactly the
 * row's preview; only its emphasis differs, and the full record stays in the inspector.
 */
export function traceRowPreview(kind: string, preview: string): ReactNode {
  if (kind === 'tool') {
    const call = /^(\S+)(\s+.*?)?(\s→\s.*)?$/.exec(preview)
    if (call?.[1])
      return (
        <>
          <span className="trace-preview-name">{call[1]}</span>
          {call[2] ? <span className="trace-preview-raw">{call[2]}</span> : null}
          {call[3] ? <span className="trace-preview-result">{call[3]}</span> : null}
        </>
      )
  }
  if (kind === 'context') {
    const labelled = /^(\[[^\]]+\])(\s.*)?$/.exec(preview)
    if (labelled?.[1])
      return (
        <>
          <span className="trace-preview-name">{labelled[1]}</span>
          {labelled[2] ? <span className="trace-preview-raw">{labelled[2]}</span> : null}
        </>
      )
  }
  return preview
}

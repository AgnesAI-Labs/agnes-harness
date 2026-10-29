export interface WebSource {
  title: string
  url: string
  site: string
  snippet: string
}

/**
 * Reads the pages a web search returned from its result text (`[query] title`, URL, snippet per
 * block). Only complete entries with an http(s) address count; anything else is left to the raw
 * detail, so a result in another shape is never dressed up as sources.
 */
export function webSources(result: string | undefined): WebSource[] {
  if (!result) return []
  const sources: WebSource[] = []
  for (const block of result.split(/\n{2,}/)) {
    const [head = '', address = '', ...rest] = block.split('\n')
    const title = /^\[[^\]]*\]\s*(.+)$/.exec(head.trim())?.[1]
    if (!title) continue
    let url: URL
    try {
      url = new URL(address.trim())
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    sources.push({
      title,
      url: url.href,
      site: url.hostname.replace(/^www\./, ''),
      snippet: rest.join(' ').trim(),
    })
  }
  return sources
}

/** The pages behind a search step: site, linked title, two lines of what the page says. */
export function WebSourceList({ sources, label }: { sources: readonly WebSource[]; label: string }) {
  return (
    <ol className="web-sources" aria-label={label} data-testid="web-sources">
      {sources.map((source, index) => (
        // The same page can come back for two queries; position keeps the entries apart.
        // biome-ignore lint/suspicious/noArrayIndexKey: results are an append-only, ordered list.
        <li key={`${index}:${source.url}`} className="web-source">
          <span className="web-source-site" translate="no">
            {source.site}
          </span>
          <a className="web-source-title" href={source.url} target="_blank" rel="noreferrer noopener">
            {source.title}
          </a>
          {source.snippet && <span className="web-source-snippet">{source.snippet}</span>}
        </li>
      ))}
    </ol>
  )
}

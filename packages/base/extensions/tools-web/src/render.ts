/// <reference path="./gfm.d.ts" />
import { gfm } from '@joplin/turndown-plugin-gfm'
import TurndownService from 'turndown'
import { exceedsConversionDepth } from './depth.js'

export function renderHtml(html: string, base: string): string {
  if (exceedsConversionDepth(html)) throw new Error('WEB_CONVERSION_FAILED')
  const converter = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  converter.use(gfm)
  const tablesWithHeader = new WeakSet<Node>()
  converter.addRule('boundedCell', {
    filter: ['th', 'td'],
    replacement: (content) => ` ${content.trim().replace(/\|/gu, '\\|').replace(/\n/gu, ' ')} |`,
  })
  converter.addRule('boundedRow', {
    filter: 'tr',
    replacement: (content, node) => {
      let table: Node | null = node.parentNode
      while (table && table.nodeName !== 'TABLE') table = table.parentNode
      const first = table !== null && !tablesWithHeader.has(table)
      if (table) tablesWithHeader.add(table)
      const count = Array.from(node.children).filter((n) => ['TH', 'TD'].includes(n.nodeName)).length
      return `\n|${content}${first ? `\n|${' --- |'.repeat(count)}` : ''}`
    },
  })
  // Override GFM's fallback to raw HTML and its numeric colspan expansion entirely.
  converter.addRule('boundedTable', {
    filter: 'table',
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  })
  converter.addRule('safeLinks', {
    filter: 'a',
    replacement: (content, node) => {
      try {
        const url = new URL(node.getAttribute('href') ?? '', base)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return content
        return `[${content}](<${url.href.replace(/>/gu, '%3E')}>)`
      } catch {
        return content
      }
    },
  })
  converter.addRule('imageText', {
    filter: 'img',
    replacement: (_content, node) => converter.escape(node.getAttribute('alt') ?? ''),
  })
  converter.addRule('nonContent', {
    filter: (node) => {
      if (
        ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'INPUT'].includes(
          node.nodeName,
        )
      )
        return true
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true')
        return true
      return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(
        node.getAttribute('style') ?? '',
      )
    },
    replacement: () => '',
  })
  try {
    return converter.turndown(html)
  } catch {
    throw new Error('WEB_CONVERSION_FAILED')
  }
}

import { type ComponentProps, XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'
import { Button } from '../ui/button.js'
import type { UiLocale } from '../ui-locale.js'
import { decodeMarkdownEntities, escapeMarkdownHtml, safePluginDocsHref } from './markdown-policy.js'

const config: NonNullable<XMarkdownProps['config']> = {
  renderer: {
    link(token) {
      // Marked also produces link tokens for bare and angle-bracket autolinks.
      if (!token.raw.startsWith('[')) return escapeMarkdownHtml(token.raw)
      const label = this.parser.parseInline(token.tokens)
      const destination = safePluginDocsHref(token.href)
      return destination
        ? `<span data-docs-destination="${escapeMarkdownHtml(destination)}">${label}</span>`
        : label
    },
    image(token) {
      return escapeMarkdownHtml(decodeMarkdownEntities(token.text))
    },
    tablecell(token) {
      const tag = token.header ? 'th' : 'td'
      const scope = token.header ? ' scope="col"' : ''
      const align = token.align ? ` align="${token.align}"` : ''
      return `<${tag}${scope}${align}>${this.parser.parseInline(token.tokens)}</${tag}>`
    },
  },
}

const dompurifyConfig = {
  ALLOWED_TAGS: [
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  ALLOWED_ATTR: ['align', 'data-docs-destination', 'scope', 'start'],
  ALLOW_DATA_ATTR: false,
}

const components: NonNullable<XMarkdownProps['components']> = {
  span: function DocsLink({ children, 'data-docs-destination': destination }: ComponentProps) {
    if (typeof destination !== 'string') return <>{children}</>
    return (
      <Button
        appearance="link"
        className="plugin-docs-link"
        htmlType="button"
        role="link"
        onClick={() => window.open(destination, '_blank', 'noopener,noreferrer')}
      >
        {children} ({destination})
      </Button>
    )
  },
}

/** Installed package Markdown is static data. A link has no browser destination until activated. */
export function StaticPluginMarkdown({ source, locale }: { source: string; locale: UiLocale }) {
  return (
    <div lang={locale} data-testid="plugin-docs-markdown">
      <XMarkdown
        content={source}
        rootClassName="plugin-docs-markdown"
        config={config}
        components={components}
        dompurifyConfig={dompurifyConfig}
        escapeRawHtml
      />
    </div>
  )
}

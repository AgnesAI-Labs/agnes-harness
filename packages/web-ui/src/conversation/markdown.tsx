import { type ComponentProps, type Tokens, XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { fallbackT, type Translate } from '../locales/index.js'
import {
  decodeMarkdownEntities,
  escapeMarkdownHtml,
  protectEscapedMarkdownTags,
  safeMarkdownHref,
} from './markdown-policy.js'
import {
  MarkdownRevealOwner,
  planMarkdownReveal,
  type RevealPlan,
  RevealRoot,
  RevealText,
} from './markdown-reveal.js'
import { useMarkdownSnapshot } from './markdown-snapshot.js'

/** One React-owned Markdown subtree; the Web legacy DOM renderer never receives this root. */
export interface ConversationMarkdownProps {
  source: string
  part: 'body' | 'thinking'
  /** Message-owned next-chunk state; terminal snapshots flush all buffered syntax. */
  streaming?: boolean
  /** Imperative facades may preserve synchronous release; normal React callers omit it. */
  onRelease?: ((commit: () => void) => void) | undefined
  /** Immediate parsing preserves synchronous legacy facade reads, including unfinished syntax. */
  syntax?: 'streaming' | 'immediate'
  theme?: 'light' | 'dark'
  onCopy?: ((text: string) => Promise<void>) | undefined
  onFragment?: ((id: string) => void) | undefined
  /** Locale-bound translate injected by the host; render-time lookup only. */
  t?: Translate | undefined
}

const Callbacks = createContext<
  Pick<ConversationMarkdownProps, 'onCopy' | 'onFragment' | 'onRelease' | 'syntax' | 't'>
>({})
const dompurifyConfig = { ADD_ATTR: ['key'] }

function defaultFragment(id: string): void {
  const target = document.getElementById(id)
  if (!target?.matches('h1, h2, h3, h4, h5, h6')) return
  target.scrollIntoView({ block: 'nearest' })
  target.tabIndex = -1
  target.focus({ preventScroll: true })
}

function Link({ children, title, ...props }: ComponentProps) {
  const { onFragment } = useContext(Callbacks)
  const safe = safeMarkdownHref(typeof props.href === 'string' ? props.href : '')
  if (!safe) return <>{children}</>
  if (safe.startsWith('#')) {
    return (
      <a
        href={safe}
        title={title}
        onClick={(event) => {
          event.preventDefault()
          try {
            ;(onFragment ?? defaultFragment)(decodeURIComponent(safe.slice(1)))
          } catch {
            /* malformed fragment stays inert */
          }
        }}
      >
        {children}
      </a>
    )
  }
  return (
    <a href={safe} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function CodeBlock({ children, domNode }: ComponentProps) {
  const { onCopy: writeCode, onRelease, syntax, t = fallbackT } = useContext(Callbacks)
  const node = domNode as { children?: Array<{ name?: string; attribs?: Record<string, string> }> }
  const label =
    node.children
      ?.find((child) => child.name === 'code')
      ?.attribs?.['data-lang']?.trim()
      .split(/\s+/, 1)[0] || 'text'
  const codeRef = useRef<HTMLPreElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  const [state, setState] = useState<'idle' | 'success' | 'failure'>('idle')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== undefined) clearTimeout(timer.current)
    }
  }, [])
  const copy = async () => {
    const displayed = codeRef.current?.textContent ?? ''
    const text = syntax === 'immediate' ? displayed : displayed.replace(/\n$/, '')
    try {
      if (writeCode) await writeCode(text)
      else await navigator.clipboard.writeText(text)
      if (mounted.current) (onRelease ?? ((commit) => commit()))(() => setState('success'))
    } catch {
      if (mounted.current) (onRelease ?? ((commit) => commit()))(() => setState('failure'))
    }
    if (!mounted.current) return
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => (onRelease ?? ((commit) => commit()))(() => setState('idle')), 1_600)
  }
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="code-language">{label}</span>
        <button
          type="button"
          className="code-copy"
          aria-label={t('markdown.copyCode')}
          aria-live="polite"
          data-copy-state={state}
          onClick={copy}
        >
          {state === 'success'
            ? t('markdown.copied')
            : state === 'failure'
              ? t('markdown.copyFailed')
              : t('markdown.copy')}
        </button>
      </div>
      <pre ref={codeRef}>{children}</pre>
    </div>
  )
}

const components: NonNullable<XMarkdownProps['components']> = {
  a: Link,
  pre: CodeBlock,
  img: ({ alt }) => <>{alt}</>,
  span: RevealText,
  'agnes-reveal-root': RevealRoot,
  table: TableScroll,
}

function TableScroll({ children }: { children?: ReactNode }) {
  const { t = fallbackT } = useContext(Callbacks)
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of wide tables.
    <section className="table-scroll" tabIndex={0} aria-label={t('markdown.tableScroll')}>
      <table>{children}</table>
    </section>
  )
}

export function ConversationMarkdown({
  source,
  part,
  streaming = false,
  theme = 'light',
  onCopy,
  onFragment,
  onRelease,
  syntax = 'streaming',
  t,
}: ConversationMarkdownProps) {
  const host = useRef<HTMLDivElement>(null)
  const shown = useMarkdownSnapshot(host, source, streaming, onRelease)
  const reveal = useRef<RevealPlan | undefined>(
    source ? undefined : { source: '', value: '', ranges: [], serial: 0 },
  )
  useLayoutEffect(() => {
    if (!shown.source)
      reveal.current = { source: '', value: '', ranges: [], serial: reveal.current?.serial ?? 0 }
  }, [shown.source])
  const revealOwner = useMemo(() => ({ source: shown.source, committed: reveal }), [shown.source])
  const protectedSource = useMemo(() => protectEscapedMarkdownTags(shown.source), [shown.source])
  // The installed cache buffers a trailing reference definition until its line ends.
  const content =
    shown.streaming && /(?:^|\n)\[[^\]\n]+\]:\s+\S+[^\n]$/.test(protectedSource.content)
      ? `${protectedSource.content}\n`
      : protectedSource.content
  const config = useMemo<NonNullable<XMarkdownProps['config']>>(
    () => ({
      hooks: {
        postprocess(html) {
          let codeIndex = 0
          // Renderer keys normally count every inline node. A late reference would remount an
          // unchanged later code control. Key emitted code blocks by their own ordinal instead.
          const keyed = html.replace(/<pre>/g, () => `<pre key="agnes-code-${codeIndex++}">`)
          return planMarkdownReveal(
            keyed,
            shown.source,
            shown.streaming && shown.reveal,
            host.current,
            reveal.current,
          )
        },
      },
      renderer: {
        tablecell(token) {
          const tag = token.header ? 'th' : 'td'
          const scope = token.header ? ' scope="col"' : ''
          const align = token.align ? ` data-align="${token.align}"` : ''
          return `<${tag}${scope}${align}>${this.parser.parseInline(token.tokens)}</${tag}>`
        },
        code(token) {
          if (syntax !== 'immediate') return false
          const lang = token.lang ? ` data-lang="${escapeMarkdownHtml(token.lang)}"` : ''
          return `<pre><code data-block="true"${lang}>${escapeMarkdownHtml(token.text)}</code></pre>\n`
        },
        link(token) {
          const href = safeMarkdownHref(token.href)
          if (!href) return escapeMarkdownHtml(token.raw)
          const label = this.parser.parseInline(token.tokens)
          const title = token.title ? ` title="${escapeMarkdownHtml(token.title)}"` : ''
          return `<a href="${escapeMarkdownHtml(href)}"${title}>${label}</a>`
        },
        image(token) {
          return escapeMarkdownHtml(decodeMarkdownEntities(token.text))
        },
        html(token) {
          return escapeMarkdownHtml(token.raw)
        },
        text(token) {
          const text = token as Tokens.Text
          let value = text.tokens ? this.parser.parseInline(text.tokens) : text.text
          for (const [key, literal] of protectedSource.literals)
            value = value.replaceAll(
              key,
              `<span data-agnes-literal="${escapeMarkdownHtml(decodeMarkdownEntities(literal))}"></span>`,
            )
          return value
        },
      },
    }),
    [protectedSource, shown, syntax],
  )
  const callbacks = useMemo(
    () => ({ onCopy, onFragment, onRelease, syntax, t }),
    [onCopy, onFragment, onRelease, syntax, t],
  )
  const stream = useMemo(
    () => ({ hasNextChunk: shown.streaming && syntax === 'streaming', enableAnimation: false }),
    [shown.streaming, syntax],
  )
  return (
    <div ref={host} data-conversation-markdown={part}>
      <MarkdownRevealOwner.Provider value={revealOwner}>
        <Callbacks.Provider value={callbacks}>
          <XMarkdown
            key={shown.source ? 'content' : 'empty'}
            content={content}
            rootClassName={`conversation-markdown markdown x-markdown-${theme}`}
            config={config}
            components={components}
            dompurifyConfig={dompurifyConfig}
            escapeRawHtml
            streaming={stream}
          />
        </Callbacks.Provider>
      </MarkdownRevealOwner.Provider>
    </div>
  )
}

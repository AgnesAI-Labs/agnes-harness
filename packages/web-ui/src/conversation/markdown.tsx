import { type ComponentProps, type Tokens, XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  decodeMarkdownEntities,
  escapeMarkdownHtml,
  protectEscapedMarkdownTags,
  safeMarkdownHref,
} from './markdown-policy.js'
import { useMarkdownSnapshot } from './markdown-snapshot.js'

/** One React-owned Markdown subtree; the Web legacy DOM renderer never receives this root. */
export interface ConversationMarkdownProps {
  source: string
  part: 'body' | 'thinking'
  /** Message-owned next-chunk state; terminal snapshots flush all buffered syntax. */
  streaming?: boolean
  theme?: 'light' | 'dark'
  onCopy?: ((text: string) => Promise<void>) | undefined
  onFragment?: ((id: string) => void) | undefined
}

const Callbacks = createContext<Pick<ConversationMarkdownProps, 'onCopy' | 'onFragment'>>({})
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

function LiteralSpan({ children, domNode }: ComponentProps) {
  const literal = (domNode as { attribs?: Record<string, string> }).attribs?.['data-agnes-literal']
  return literal === undefined ? <span>{children}</span> : literal
}

function CodeBlock({ children, domNode }: ComponentProps) {
  const { onCopy: writeCode } = useContext(Callbacks)
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
    const text = (codeRef.current?.textContent ?? '').replace(/\n$/, '')
    try {
      if (writeCode) await writeCode(text)
      else await navigator.clipboard.writeText(text)
      if (mounted.current) setState('success')
    } catch {
      if (mounted.current) setState('failure')
    }
    if (!mounted.current) return
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1_600)
  }
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="code-language">{label}</span>
        <button
          type="button"
          className="code-copy"
          aria-label="复制代码"
          aria-live="polite"
          data-copy-state={state}
          onClick={copy}
        >
          {state === 'success' ? '已复制' : state === 'failure' ? '复制失败' : '复制'}
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
  span: LiteralSpan,
}

export function ConversationMarkdown({
  source,
  part,
  streaming = false,
  theme = 'light',
  onCopy,
  onFragment,
}: ConversationMarkdownProps) {
  const host = useRef<HTMLDivElement>(null)
  const shown = useMarkdownSnapshot(host, source, streaming)
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
          return html.replace(/<pre>/g, () => `<pre key="agnes-code-${codeIndex++}">`)
        },
      },
      renderer: {
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
    [protectedSource],
  )
  const callbacks = useMemo(() => ({ onCopy, onFragment }), [onCopy, onFragment])
  const stream = useMemo(() => ({ hasNextChunk: shown.streaming, enableAnimation: false }), [shown.streaming])
  return (
    <div ref={host} data-conversation-markdown={part}>
      <Callbacks.Provider value={callbacks}>
        <XMarkdown
          content={content}
          rootClassName={`conversation-markdown markdown x-markdown-${theme}`}
          config={config}
          components={components}
          dompurifyConfig={dompurifyConfig}
          escapeRawHtml
          streaming={stream}
        />
      </Callbacks.Provider>
    </div>
  )
}

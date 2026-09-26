import { type ComponentProps, type Tokens, XMarkdown, type XMarkdownProps } from '@ant-design/x-markdown'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  decodeMarkdownEntities,
  escapeMarkdownHtml,
  protectEscapedMarkdownTags,
  safeMarkdownHref,
} from './markdown-policy.js'

/** One React-owned Markdown subtree; the Web legacy DOM renderer never receives this root. */
export interface ConversationMarkdownProps {
  source: string
  part: 'body' | 'thinking'
  /** Reserved for W5b streaming coordination; static output is settled in this checkpoint. */
  streaming?: boolean
  theme?: 'light' | 'dark'
  onCopy?: ((text: string) => Promise<void>) | undefined
  onFragment?: ((id: string) => void) | undefined
}

function defaultFragment(id: string): void {
  const target = document.getElementById(id)
  if (!target?.matches('h1, h2, h3, h4, h5, h6')) return
  target.scrollIntoView({ block: 'nearest' })
  target.tabIndex = -1
  target.focus({ preventScroll: true })
}

function Link({
  children,
  title,
  onFragment,
  ...props
}: ComponentProps & { onFragment: ((id: string) => void) | undefined }) {
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

function CodeBlock({
  children,
  domNode,
  writeCode,
}: ComponentProps & { writeCode: ((text: string) => Promise<void>) | undefined }) {
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

export function ConversationMarkdown({
  source,
  part,
  theme = 'light',
  onCopy,
  onFragment,
}: ConversationMarkdownProps) {
  const protectedSource = useMemo(() => protectEscapedMarkdownTags(source), [source])
  const config = useMemo<NonNullable<XMarkdownProps['config']>>(
    () => ({
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
  const components = useMemo<NonNullable<XMarkdownProps['components']>>(
    () => ({
      a: (props) => <Link {...props} onFragment={onFragment} />,
      pre: (props) => <CodeBlock {...props} writeCode={onCopy} />,
      img: ({ alt }) => <>{alt}</>,
      span: LiteralSpan,
    }),
    [onCopy, onFragment],
  )
  return (
    <div data-conversation-markdown={part}>
      <XMarkdown
        content={protectedSource.content}
        rootClassName={`conversation-markdown markdown x-markdown-${theme}`}
        config={config}
        components={components}
        escapeRawHtml
        streaming={{ hasNextChunk: false, enableAnimation: false }}
      />
    </div>
  )
}

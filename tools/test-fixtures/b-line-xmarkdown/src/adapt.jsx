import { XMarkdown } from '@ant-design/x-markdown'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** Baseline with the published package defaults. */
export function DefaultMarkdown({ content, streaming = false }) {
  return <XMarkdown content={content} streaming={{ hasNextChunk: streaming, enableAnimation: streaming }} />
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function decodeEntities(text) {
  const source = text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return new DOMParser().parseFromString(source, 'text/html').documentElement.textContent ?? text
}

function hasControl(text) {
  return [...text].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f)
  })
}

export function safeHref(raw) {
  const decoded = decodeEntities(raw)
  if (decoded.startsWith('#')) {
    try {
      return hasControl(decoded) || hasControl(decodeURIComponent(decoded.slice(1))) ? undefined : decoded
    } catch {
      return undefined
    }
  }
  if (hasControl(decoded)) return undefined
  try {
    const url = new URL(decoded)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function makeConfig(literals) {
  return {
    renderer: {
      link(token) {
        const href = safeHref(token.href)
        if (!href) return escapeHtml(token.raw)
        const label = this.parser.parseInline(token.tokens)
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<a href="${escapeHtml(href)}"${title}>${label}</a>`
      },
      image(token) {
        return escapeHtml(decodeEntities(token.text))
      },
      html(token) {
        return escapeHtml(token.raw)
      },
      text(token) {
        const rendered = token.tokens ? this.parser.parseInline(token.tokens) : token.text
        let value = rendered
        for (const [key, literal] of literals)
          value = value.replaceAll(key, escapeHtml(decodeEntities(literal)))
        return value
      },
    },
  }
}

function protectEscapedTags(source) {
  const literals = new Map()
  let index = 0
  let prefix = '\uE000AGH_LITERAL_'
  while (source.includes(prefix)) prefix += '_'
  let fence = null
  let inlineTicks = 0
  let content = ''
  for (const line of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue
    const fenceMark = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line)
    if (fence) {
      content += line
      if (
        fenceMark &&
        fenceMark[1][0] === fence.char &&
        fenceMark[1].length >= fence.length &&
        !fenceMark[2].trim()
      )
        fence = null
      continue
    }
    if (fenceMark && !inlineTicks) {
      fence = { char: fenceMark[1][0], length: fenceMark[1].length }
      content += line
      continue
    }
    for (let cursor = 0; cursor < line.length; ) {
      if (line[cursor] === '`') {
        const run = /^`+/.exec(line.slice(cursor))[0]
        if (inlineTicks === run.length) inlineTicks = 0
        else if (!inlineTicks && line.indexOf(run, cursor + run.length) >= 0) inlineTicks = run.length
        content += run
        cursor += run.length
        continue
      }
      if (!inlineTicks && line[cursor] === '\\' && line[cursor + 1] === '<') {
        const match = /^\\<[^>\n]*(?:>|$)/.exec(line.slice(cursor))
        if (match) {
          const key = `${prefix}${index++}\uE001`
          literals.set(key, match[0].slice(1))
          content += key
          cursor += match[0].length
          continue
        }
      }
      content += line[cursor++]
    }
  }
  return { content, literals }
}

function Link({ href, children, title }) {
  const safe = safeHref(href ?? '')
  if (!safe) return <>{children}</>
  if (safe.startsWith('#')) {
    return (
      <a
        href={safe}
        title={title}
        onClick={(event) => {
          event.preventDefault()
          try {
            const target = document.getElementById(decodeURIComponent(safe.slice(1)))
            if (!target?.matches('h1, h2, h3, h4, h5, h6')) return
            target.scrollIntoView({ block: 'nearest' })
            target.tabIndex = -1
            target.focus({ preventScroll: true })
          } catch {
            /* invalid fragment stays inert */
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

function CodeBlock({ children, domNode }) {
  const label =
    domNode?.children
      ?.find((child) => child.name === 'code')
      ?.attribs?.['data-lang']?.trim()
      .split(/\s+/, 1)[0] || 'text'
  const codeRef = useRef(null)
  const timer = useRef(undefined)
  const mounted = useRef(true)
  const [state, setState] = useState('idle')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  const copy = async () => {
    let next
    try {
      await navigator.clipboard.writeText((codeRef.current?.textContent ?? '').replace(/\n$/, ''))
      next = 'success'
    } catch {
      next = 'failure'
    }
    if (!mounted.current) return
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1600)
  }
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="code-language">{label}</span>
        <button type="button" className="code-copy" aria-label="复制代码" aria-live="polite" onClick={copy}>
          {state === 'success' ? '已复制' : state === 'failure' ? '复制失败' : '复制'}
        </button>
      </div>
      <pre ref={codeRef}>{children}</pre>
    </div>
  )
}

const components = { a: Link, pre: CodeBlock, img: ({ alt }) => <>{alt}</> }

/** W5a candidate policy. The caller owns the stream flag and update scheduling. */
export function AdaptedMarkdown({ content, streaming = false, animation = false, theme = 'light' }) {
  const protectedSource = useMemo(() => protectEscapedTags(content), [content])
  const config = useMemo(() => makeConfig(protectedSource.literals), [protectedSource])
  // The installed streaming cache treats a final `[ref]: URL` line as a still-open link token.
  // A completed definition needs a line terminator to be committed before the next delta.
  const normalized =
    streaming && /(?:^|\n)\[[^\]\n]+\]:\s+\S+[^\n]$/.test(protectedSource.content)
      ? `${protectedSource.content}\n`
      : protectedSource.content
  return (
    <XMarkdown
      content={normalized}
      rootClassName={theme === 'dark' ? 'x-markdown-dark' : 'x-markdown-light'}
      config={config}
      components={components}
      escapeRawHtml
      streaming={{
        hasNextChunk: streaming,
        enableAnimation: animation,
        animationConfig: { fadeDuration: 480 },
      }}
    />
  )
}

function interactionInside(element) {
  if (!element) return false
  if (element.contains(document.activeElement)) return true
  const selection = document.getSelection()
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      (element.contains(selection.anchorNode) || element.contains(selection.focusNode)),
  )
}

/** W5b feasibility probe: hold the whole XMarkdown prop update while its DOM is in use. */
export function CoordinatedMarkdown({ content, streaming = false, animation = false }) {
  const element = useRef(null)
  const pending = useRef(null)
  const [shown, setShown] = useState({ content, streaming, animation })
  useLayoutEffect(() => {
    const stop = () => {
      document.removeEventListener('selectionchange', flush)
      document.removeEventListener('pointerup', flush)
      document.removeEventListener('keyup', flush)
      document.removeEventListener('focusout', afterFocusOut)
    }
    const flush = () => {
      if (!pending.current || interactionInside(element.current)) return
      setShown(pending.current)
      pending.current = null
      stop()
    }
    const afterFocusOut = () => queueMicrotask(flush)
    const next = { content, streaming, animation }
    if (interactionInside(element.current)) {
      pending.current = next
      document.addEventListener('selectionchange', flush)
      document.addEventListener('pointerup', flush)
      document.addEventListener('keyup', flush)
      document.addEventListener('focusout', afterFocusOut)
    } else {
      pending.current = null
      setShown(next)
      stop()
    }
    return stop
  }, [content, streaming, animation])
  return (
    <div ref={element}>
      <AdaptedMarkdown {...shown} />
    </div>
  )
}

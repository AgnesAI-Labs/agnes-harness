import { createTextReveal } from '@agnes/web-admin-frame'
import { Lexer, type Token, type Tokens } from 'marked'

export type MarkdownRenderer = {
  update(source: string): void
  dispose(): void
}

type MarkdownBlock = {
  key: string
  element: HTMLElement
  dispose?(): void
}

type RenderedElement = Omit<MarkdownBlock, 'key'>

function hasUnsafeControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

const fragment = (text: string): string | undefined => {
  if (!text.startsWith('#') || hasUnsafeControl(text)) return undefined
  try {
    if (hasUnsafeControl(decodeURIComponent(text.slice(1)))) return undefined
  } catch {
    return undefined
  }
  return text
}

/** Decode Markdown's character references without ever inserting parsed HTML into the document. */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  try {
    const textOnly = value.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    return new DOMParser().parseFromString(textOnly, 'text/html').documentElement.textContent ?? value
  } catch {
    return value
  }
}

/** Only user-navigable web URLs and same-page fragments become links. */
function safeHref(href: string): string | undefined {
  const decoded = decodeEntities(href)
  const hash = fragment(decoded)
  if (hash) return hash
  if (hasUnsafeControl(decoded)) return undefined
  try {
    const url = new URL(decoded)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function fragmentTarget(href: string): HTMLElement | undefined {
  try {
    const target = document.getElementById(decodeURIComponent(href.slice(1)))
    return target?.matches('h1, h2, h3, h4, h5, h6') ? target : undefined
  } catch {
    return undefined
  }
}

function appendText(parent: Node, text: string, decode = true): void {
  parent.appendChild(document.createTextNode(decode ? decodeEntities(text) : text))
}

function hasEscapedTag(text: string): boolean {
  return text.includes('\\<') || text.includes('\\>')
}

function escapedTagLiteral(text: string): string {
  return text.replaceAll('\\<', '<').replaceAll('\\>', '>')
}

function appendInlineSource(parent: HTMLElement, source: string): void {
  const escapedTag = /\\<[^>\n]*(?:>|$)/g
  let cursor = 0
  for (const match of source.matchAll(escapedTag)) {
    const index = match.index ?? 0
    if (index > cursor) appendInline(parent, Lexer.lexInline(source.slice(cursor, index), { gfm: true }))
    appendText(parent, escapedTagLiteral(match[0]))
    cursor = index + match[0].length
  }
  if (cursor < source.length) appendInline(parent, Lexer.lexInline(source.slice(cursor), { gfm: true }))
}

function appendInline(parent: HTMLElement, tokens: Token[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        const element = document.createElement('strong')
        appendInline(element, (token as Tokens.Strong).tokens)
        parent.append(element)
        break
      }
      case 'em': {
        const element = document.createElement('em')
        appendInline(element, (token as Tokens.Em).tokens)
        parent.append(element)
        break
      }
      case 'del': {
        const element = document.createElement('del')
        appendInline(element, (token as Tokens.Del).tokens)
        parent.append(element)
        break
      }
      case 'codespan': {
        const element = document.createElement('code')
        element.textContent = (token as Tokens.Codespan).text
        parent.append(element)
        break
      }
      case 'link': {
        const link = token as Tokens.Link
        const href = safeHref(link.href)
        if (!href) {
          appendText(parent, link.raw, false)
          break
        }
        const element = document.createElement('a')
        element.href = href
        if (href.startsWith('#')) {
          element.removeAttribute('target')
          element.addEventListener('click', (event) => {
            event.preventDefault()
            const target = fragmentTarget(href)
            if (!target) return
            target.scrollIntoView({ block: 'nearest' })
            target.tabIndex = -1
            target.focus({ preventScroll: true })
          })
        } else {
          element.target = '_blank'
          element.rel = 'noopener noreferrer'
        }
        if (link.title) element.title = link.title
        appendInline(element, link.tokens)
        parent.append(element)
        break
      }
      case 'image':
        // A transcript must not cause an unrequested network fetch. Alt text remains useful context.
        appendText(parent, (token as Tokens.Image).text)
        break
      case 'br':
        parent.append(document.createElement('br'))
        break
      case 'html':
        // Marked separates inline tags into tokens; preserve their source without interpreting it.
        appendText(parent, (token as Tokens.HTML | Tokens.Tag).raw, false)
        break
      case 'text': {
        const text = token as Tokens.Text
        // An escaped literal tag can contain a URL-shaped attribute. Keep the whole escaped run
        // textual so GFM's autolink pass cannot turn that attribute into a live link.
        if (hasEscapedTag(text.raw)) appendText(parent, escapedTagLiteral(text.text))
        else if (text.tokens?.length) appendInline(parent, text.tokens)
        else appendText(parent, text.text)
        break
      }
      case 'escape':
        appendText(parent, (token as Tokens.Escape).text)
        break
      default:
        appendText(parent, token.raw)
    }
  }
}

function language(value: string | undefined): string {
  const label = value?.trim().split(/\s+/, 1)[0]
  return label || 'text'
}

function codeBlock(token: Tokens.Code): RenderedElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'code-block'
  const toolbar = document.createElement('div')
  toolbar.className = 'code-toolbar'
  const label = document.createElement('span')
  label.className = 'code-language'
  label.textContent = language(token.lang)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'code-copy'
  copy.textContent = '复制'
  copy.setAttribute('aria-label', '复制代码')
  copy.setAttribute('aria-live', 'polite')
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = token.text
  pre.append(code)
  toolbar.append(label, copy)
  wrapper.append(toolbar, pre)

  let restoreTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let disposed = false
  const reportCopy = (state: 'success' | 'failure') => {
    if (disposed) return
    copy.textContent = state === 'success' ? '已复制' : '复制失败'
    copy.dataset.copyState = state
    if (restoreTimer !== undefined) globalThis.clearTimeout(restoreTimer)
    restoreTimer = globalThis.setTimeout(() => {
      copy.textContent = '复制'
      delete copy.dataset.copyState
    }, 1_600)
  }
  copy.addEventListener('click', () => {
    const write = globalThis.navigator?.clipboard?.writeText
    if (!write) {
      reportCopy('failure')
      return
    }
    try {
      void Promise.resolve(write.call(globalThis.navigator.clipboard, code.textContent ?? '')).then(
        () => reportCopy('success'),
        () => reportCopy('failure'),
      )
    } catch {
      reportCopy('failure')
    }
  })
  return {
    element: wrapper,
    dispose() {
      disposed = true
      if (restoreTimer !== undefined) globalThis.clearTimeout(restoreTimer)
    },
  }
}

function appendBlocks(parent: HTMLElement, tokens: Token[]): () => void {
  const disposers: Array<() => void> = []
  for (const token of tokens) {
    const block = createBlock(token)
    if (!block) continue
    parent.append(block.element)
    if (block.dispose) disposers.push(block.dispose)
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function list(token: Tokens.List): RenderedElement {
  const element = token.ordered ? document.createElement('ol') : document.createElement('ul')
  if (token.ordered && typeof token.start === 'number' && token.start !== 1) {
    const ordered = element as HTMLOListElement
    ordered.start = token.start
  }
  const disposers: Array<() => void> = []
  for (const item of token.items) {
    const entry = document.createElement('li')
    disposers.push(appendBlocks(entry, item.tokens))
    element.append(entry)
  }
  return {
    element,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

function table(token: Tokens.Table): RenderedElement {
  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'
  scroll.tabIndex = 0
  scroll.setAttribute('role', 'region')
  scroll.setAttribute('aria-label', '表格，可横向滚动')
  const element = document.createElement('table')
  const head = document.createElement('thead')
  const headerRow = document.createElement('tr')
  for (const cell of token.header) {
    const header = document.createElement('th')
    header.scope = 'col'
    if (cell.align) header.dataset.align = cell.align
    appendInline(header, cell.tokens)
    headerRow.append(header)
  }
  head.append(headerRow)
  element.append(head)
  if (token.rows.length) {
    const body = document.createElement('tbody')
    for (const row of token.rows) {
      const tableRow = document.createElement('tr')
      for (const cell of row) {
        const data = document.createElement('td')
        if (cell.align) data.dataset.align = cell.align
        appendInline(data, cell.tokens)
        tableRow.append(data)
      }
      body.append(tableRow)
    }
    element.append(body)
  }
  scroll.append(element)
  return { element: scroll }
}

function createBlock(token: Token): RenderedElement | undefined {
  switch (token.type) {
    case 'space':
    case 'def':
      return undefined
    case 'heading': {
      const heading = token as Tokens.Heading
      const element = document.createElement(`h${heading.depth}`)
      appendInline(element, heading.tokens)
      return { element }
    }
    case 'paragraph': {
      const paragraph = document.createElement('p')
      const paragraphToken = token as Tokens.Paragraph
      if (hasEscapedTag(paragraphToken.raw)) appendInlineSource(paragraph, paragraphToken.raw)
      else appendInline(paragraph, paragraphToken.tokens)
      return { element: paragraph }
    }
    case 'text': {
      const paragraph = document.createElement('p')
      const text = token as Tokens.Text
      if (text.tokens?.length) appendInline(paragraph, text.tokens)
      else appendText(paragraph, text.text)
      return { element: paragraph }
    }
    case 'blockquote': {
      const element = document.createElement('blockquote')
      const dispose = appendBlocks(element, (token as Tokens.Blockquote).tokens)
      return { element, dispose }
    }
    case 'list':
      return list(token as Tokens.List)
    case 'code':
      return codeBlock(token as Tokens.Code)
    case 'table':
      return table(token as Tokens.Table)
    case 'hr':
      return { element: document.createElement('hr') }
    case 'html': {
      const paragraph = document.createElement('p')
      appendText(paragraph, (token as Tokens.HTML | Tokens.Tag).raw, false)
      return { element: paragraph }
    }
    default: {
      const paragraph = document.createElement('p')
      appendText(paragraph, token.raw, false)
      return { element: paragraph }
    }
  }
}

function tokenBlocks(source: string): Token[] {
  try {
    return Lexer.lex(source, { gfm: true, breaks: false }).filter(
      (token) => token.type !== 'space' && token.type !== 'def',
    )
  } catch {
    return source
      ? [
          {
            type: 'paragraph',
            raw: source,
            text: source,
            tokens: [{ type: 'text', raw: source, text: source }],
          } as Tokens.Paragraph,
        ]
      : []
  }
}

function blockKey(token: Token): string {
  try {
    return JSON.stringify(token)
  } catch {
    return `${token.type}\u0000${token.raw}`
  }
}

function interactionInside(element: HTMLElement): boolean {
  const selection = document.getSelection()
  if (element.contains(document.activeElement)) return true
  if (!selection || selection.isCollapsed) return false
  return element.contains(selection.anchorNode) || element.contains(selection.focusNode)
}

/**
 * Renders Marked tokens through a small DOM allowlist. Existing completed blocks stay in place
 * during a stream; a selection or focused control defers the mutable tail until it is released.
 */
export function createMarkdownRenderer(element: HTMLElement, initial = ''): MarkdownRenderer {
  element.classList.add('markdown')
  const textReveal = createTextReveal(element)
  let rendered = ''
  let current: MarkdownBlock[] = []
  let pending: string | undefined
  let listening = false

  const stopListening = () => {
    if (!listening) return
    document.removeEventListener('selectionchange', flushPending)
    document.removeEventListener('pointerup', flushPending)
    document.removeEventListener('keyup', flushPending)
    document.removeEventListener('focusout', flushAfterFocusOut)
    listening = false
  }
  const apply = (source: string, animate = false) => {
    pending = undefined
    const reveal = animate && source.length > rendered.length && source.startsWith(rendered)
    const nextBlocks = tokenBlocks(source).map((token) => ({ token, key: blockKey(token) }))
    const updated: MarkdownBlock[] = []
    for (const [index, nextBlock] of nextBlocks.entries()) {
      const previous = current[index]
      if (previous?.key === nextBlock.key) {
        updated.push(previous)
        continue
      }
      const created = createBlock(nextBlock.token)
      if (!created) continue
      if (reveal && previous && textReveal.extend(previous.element, created.element)) {
        previous.key = nextBlock.key
        updated.push(previous)
        continue
      }
      if (reveal) textReveal.append(previous?.element, created.element)
      if (previous) {
        previous.dispose?.()
        previous.element.replaceWith(created.element)
      } else element.append(created.element)
      updated.push({ key: nextBlock.key, ...created })
    }
    for (let index = nextBlocks.length; index < current.length; index++) {
      const previous = current[index]
      previous?.dispose?.()
      previous?.element.remove()
    }
    current = updated
    rendered = source
  }
  const flushPending = () => {
    if (pending === undefined || interactionInside(element)) return
    const source = pending
    stopListening()
    apply(source)
  }
  const flushAfterFocusOut = () => queueMicrotask(flushPending)
  const startListening = () => {
    if (listening) return
    document.addEventListener('selectionchange', flushPending)
    document.addEventListener('pointerup', flushPending)
    document.addEventListener('keyup', flushPending)
    document.addEventListener('focusout', flushAfterFocusOut)
    listening = true
  }

  apply(initial)
  return {
    update(source) {
      if (source === rendered && pending === undefined) return
      if (interactionInside(element)) {
        pending = source
        startListening()
        return
      }
      const animate = pending === undefined
      stopListening()
      apply(source, animate)
    },
    dispose() {
      pending = undefined
      stopListening()
      for (const block of current) block.dispose?.()
      current = []
    },
  }
}

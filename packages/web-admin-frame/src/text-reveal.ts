const REVEAL_DURATION_MS = 480
const MAX_RANGES = 32
const MAX_TEXT_LENGTH = 65_536
const MAX_VISITED_NODES = 4_096
const MAX_FRAGMENTS = 128
const EXCLUDED_CONTENT =
  'button, input, select, textarea, .code-toolbar, script, style, [hidden], [aria-hidden="true"]'

type RevealRange = { start: number; end: number; startedAt: number }
type RevealState = { length: number; ranges: RevealRange[] }
type TextSegment = { node: Text; start: number; end: number }
type TextSnapshot = { value: string; segments: TextSegment[] }
type RevealPiece = { start: number; end: number; range?: RevealRange }

/** Read in document order without measuring layout or including code-copy controls. */
function snapshot(element: HTMLElement): TextSnapshot | undefined {
  if (element.matches(EXCLUDED_CONTENT)) return undefined
  const segments: TextSegment[] = []
  const values: string[] = []
  let length = 0
  let visited = 0
  let exceeded = false
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        visited++
        if (visited > MAX_VISITED_NODES) {
          exceeded = true
          return NodeFilter.FILTER_ACCEPT
        }
        if (node.nodeType === Node.ELEMENT_NODE)
          return (node as Element).matches(EXCLUDED_CONTENT)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP
        return NodeFilter.FILTER_ACCEPT
      },
    },
  )
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (exceeded) return undefined
    const text = node as Text
    if (text.length === 0) continue
    const end = length + text.length
    if (end > MAX_TEXT_LENGTH) return undefined
    segments.push({ node: text, start: length, end })
    values.push(text.data)
    length = end
  }
  return { value: values.join(''), segments }
}

function splitsSurrogate(value: string, offset: number): boolean {
  const before = value.charCodeAt(offset - 1)
  const after = value.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/**
 * The caller excludes initial/history paints and selection-deferred flushes, and decides whether
 * the Markdown source is an append. Only validated plain paragraphs can be extended in place.
 */
export function createTextReveal(container: HTMLElement): {
  append(previous: HTMLElement | undefined, next: HTMLElement): void
  extend(previous: HTMLElement, next: HTMLElement): boolean
} {
  const states = new WeakMap<HTMLElement, RevealState>()
  const fragments = new WeakMap<HTMLElement, { range: RevealRange; style: string }>()
  const document = container.ownerDocument
  const mayAnimate = (): boolean => {
    const view = document.defaultView
    return Boolean(
      container.isConnected &&
        container.closest('.assistant[data-streaming="true"]') &&
        !container.closest('[hidden], [aria-hidden="true"], details:not([open])') &&
        document.visibilityState !== 'hidden' &&
        view &&
        typeof view.matchMedia === 'function' &&
        !view.matchMedia('(prefers-reduced-motion: reduce)').matches,
    )
  }
  const revealFragment = (value: string, range: RevealRange, now: number): HTMLElement => {
    const fragment = document.createElement('span')
    fragment.className = 'message-reveal-fragment'
    fragment.style.animationDuration = `${REVEAL_DURATION_MS}ms`
    fragment.style.animationDelay = `${-Math.max(0, now - range.startedAt)}ms`
    fragment.textContent = value
    fragments.set(fragment, { range, style: fragment.style.cssText })
    return fragment
  }
  return {
    extend(previous, next) {
      if (
        previous.tagName !== 'P' ||
        next.tagName !== 'P' ||
        previous === next ||
        !container.contains(previous) ||
        next.isConnected ||
        next.ownerDocument !== document ||
        previous.attributes.length !== next.attributes.length ||
        Array.from(previous.attributes).some(
          (attribute) => next.getAttribute(attribute.name) !== attribute.value,
        ) ||
        previous.childNodes.length > MAX_VISITED_NODES ||
        next.childNodes.length > MAX_VISITED_NODES
      )
        return false
      let nextLength = 0
      for (const node of next.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) return false
        nextLength += (node as Text).length
        if (nextLength > MAX_TEXT_LENGTH) return false
      }

      const inherited = states.get(previous)
      const inheritedRanges = new Set(inherited?.ranges)
      const children: Array<{ node: ChildNode; end: number; range?: RevealRange }> = []
      let length = 0
      let visited = 0
      let fragmentCount = 0
      for (const node of previous.childNodes) {
        visited++
        let range: RevealRange | undefined
        if (node.nodeType === Node.TEXT_NODE) length += (node as Text).length
        else {
          const fragment = node as HTMLElement
          const owned = fragments.get(fragment)
          if (
            !owned ||
            fragment.tagName !== 'SPAN' ||
            fragment.className !== 'message-reveal-fragment' ||
            fragment.attributes.length !== 2 ||
            fragment.style.cssText !== owned.style ||
            fragment.childNodes.length !== 1 ||
            fragment.firstChild?.nodeType !== Node.TEXT_NODE ||
            !inheritedRanges.has(owned.range)
          )
            return false
          range = owned.range
          if (length < range.start) return false
          length += (fragment.firstChild as Text).length
          if (length > range.end || ++fragmentCount > MAX_FRAGMENTS) return false
          visited++
        }
        if (length > MAX_TEXT_LENGTH || visited > MAX_VISITED_NODES) return false
        children.push({ node, end: length, ...(range ? { range } : {}) })
      }
      const before = previous.textContent ?? ''
      const after = next.textContent ?? ''
      if (
        after.length > MAX_TEXT_LENGTH ||
        !after.startsWith(before) ||
        splitsSurrogate(after, before.length) ||
        (fragmentCount > 0 && inherited?.length !== before.length)
      )
        return false

      const now = document.defaultView?.performance.now() ?? 0
      const animate = mayAnimate() && !previous.matches(EXCLUDED_CONTENT)
      const ranges =
        animate && inherited?.length === before.length
          ? inherited.ranges.filter((range) => now - range.startedAt < REVEAL_DURATION_MS)
          : []
      const suffix = after.slice(before.length)
      const added =
        animate && suffix ? { start: before.length, end: after.length, startedAt: now } : undefined
      if (added) ranges.push(added)
      if (ranges.length > MAX_RANGES) ranges.splice(0, ranges.length - MAX_RANGES)
      if (ranges.some((range) => splitsSurrogate(after, range.start) || splitsSurrogate(after, range.end)))
        return false
      const active = new Set(ranges)
      let prefixCount = 0
      let prefixLength = 0
      let retainedNodes = 0
      let retainedFragments = 0
      for (const child of children) {
        if (child.range && active.has(child.range)) retainedFragments++
        else if (retainedFragments === 0) {
          prefixCount++
          prefixLength = child.end
          continue
        } else if (child.range) return false
        retainedNodes += child.range ? 2 : 1
      }
      const finalNodes = retainedNodes + (prefixCount ? 1 : 0) + (added ? 2 : suffix && !prefixCount ? 1 : 0)
      if (retainedFragments + (added ? 1 : 0) > MAX_FRAGMENTS || finalNodes > MAX_VISITED_NODES) return false

      // All rejection paths precede mutation. Retire only a prefix, during this safe update.
      if (prefixCount > 0) {
        const first = previous.firstChild
        const stable = first?.nodeType === Node.TEXT_NODE ? (first as Text) : document.createTextNode('')
        if (stable !== first) previous.insertBefore(stable, first)
        if (prefixLength > stable.length) stable.appendData(before.slice(stable.length, prefixLength))
        for (const child of children.slice(0, prefixCount)) if (child.node !== stable) child.node.remove()
      }
      if (added) previous.append(revealFragment(suffix, added, now))
      else if (suffix) {
        const last = previous.lastChild
        if (last?.nodeType === Node.TEXT_NODE) (last as Text).appendData(suffix)
        else previous.append(document.createTextNode(suffix))
      }
      states.set(previous, { length: after.length, ranges })
      return true
    },
    append(previous, next) {
      const view = document.defaultView
      if (
        !view ||
        !mayAnimate() ||
        next.isConnected ||
        next.ownerDocument !== document ||
        (previous !== undefined && !container.contains(previous)) ||
        next.querySelector('.message-reveal-fragment')
      )
        return

      const before = previous === undefined ? { value: '', segments: [] } : snapshot(previous)
      const after = snapshot(next)
      if (!before || !after || !after.value.startsWith(before.value)) return
      const now = view.performance.now()
      const inherited = previous === undefined ? undefined : states.get(previous)
      const ranges =
        inherited?.length === before.value.length
          ? inherited.ranges.filter((range) => now - range.startedAt < REVEAL_DURATION_MS)
          : []
      if (after.value.length > before.value.length)
        ranges.push({ start: before.value.length, end: after.value.length, startedAt: now })
      // Retired ranges stay as plain text; a busy stream must not discard the newest fade-in.
      if (ranges.length > MAX_RANGES) ranges.splice(0, ranges.length - MAX_RANGES)
      if (
        ranges.length === 0 ||
        ranges.some(
          (range) => splitsSurrogate(after.value, range.start) || splitsSurrogate(after.value, range.end),
        )
      )
        return

      // Plan all intersections before changing any node, so an over-complex block stays untouched.
      const plans: Array<{ node: Text; pieces: RevealPiece[] }> = []
      let rangeIndex = 0
      let fragmentCount = 0
      for (const segment of after.segments) {
        while (rangeIndex < ranges.length) {
          const range = ranges[rangeIndex]
          if (!range || range.end > segment.start) break
          rangeIndex++
        }
        const pieces: RevealPiece[] = []
        let cursor = 0
        for (let index = rangeIndex; index < ranges.length; index++) {
          const range = ranges[index]
          if (!range || range.start >= segment.end) break
          const start = Math.max(range.start, segment.start) - segment.start
          const end = Math.min(range.end, segment.end) - segment.start
          if (start > cursor) pieces.push({ start: cursor, end: start })
          pieces.push({ start, end, range })
          cursor = end
          if (++fragmentCount > MAX_FRAGMENTS) return
        }
        if (pieces.length === 0) continue
        if (cursor < segment.node.length) pieces.push({ start: cursor, end: segment.node.length })
        plans.push({ node: segment.node, pieces })
      }
      for (const { node, pieces } of plans) {
        const replacement = document.createDocumentFragment()
        for (const piece of pieces) {
          const value = node.data.slice(piece.start, piece.end)
          if (!piece.range) {
            replacement.append(document.createTextNode(value))
            continue
          }
          replacement.append(revealFragment(value, piece.range, now))
        }
        node.replaceWith(replacement)
      }
      states.set(next, { length: after.value.length, ranges })
    },
  }
}

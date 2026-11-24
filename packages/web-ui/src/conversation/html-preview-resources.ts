import type { ArtifactRef, ToolCall, ToolResult } from '@agnes/protocol'
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse } from 'parse5'
import { cssUrls, cssUrlValue } from './html-preview-css.js'

const LIMIT = 1024 * 1024
const mime: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}
type Snapshot = { path: string; ref: ArtifactRef }
type Detail = { call: ToolCall; result?: ToolResult }
type Element = DefaultTreeAdapterTypes.Element
type Location = NonNullable<Element['sourceCodeLocation']>
type Edit = { start: number; end: number; value: string }
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const address = (path: string) =>
  new URL(path.replaceAll('\\', '/').replace(/^([a-z]:\/)/i, '/$1'), 'https://preview.invalid/')
const local = (url: string) => !!url.trim() && !/^(?:#|data:|blob:|[a-z][a-z\d+.-]*:|\/\/)/i.test(url.trim())
const mediaTags = new Set(['img', 'source', 'video', 'audio'])
const attribute = (element: Element, name: string) => element.attrs.find((attr) => attr.name === name)?.value
const attributeText = (name: string, value: string) =>
  `${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`

function replaceRanges(source: string, edits: Edit[]): string {
  let cursor = 0
  const parts = []
  for (const { start, end, value } of edits.sort((a, b) => a.start - b.start)) {
    if (start < cursor) throw Error('overlapping preview resources')
    parts.push(source.slice(cursor, start), value)
    cursor = end
  }
  return parts.join('') + source.slice(cursor)
}

function elementLocations(html: string): Array<{ element: Element; location: Location }> {
  // The HTML tokenizer supplies source offsets and decoded attributes, including the browser's
  // rules for comments, foreign content and raw text. Its tree is plain JavaScript data.
  const pending: DefaultTreeAdapterTypes.Node[] = [parse(html, { sourceCodeLocationInfo: true })]
  const result = []
  for (const node of pending) {
    if (defaultTreeAdapter.isElementNode(node) && node.sourceCodeLocation?.startTag)
      result.push({ element: node, location: node.sourceCodeLocation })
    // Template contents are inert and are not children of the template element.
    if ('childNodes' in node) for (const child of node.childNodes) pending.push(child)
  }
  return result.sort((a, b) => a.location.startOffset - b.location.startOffset)
}

function stylesheet(element: Element, location: Location, html: string): string {
  return element.tagName === 'style'
    ? html.slice(location.startTag?.endOffset, location.endTag?.startOffset ?? location.endOffset)
    : ''
}

/** Follow srcset URL/descriptor boundaries; commas inside a data URL are part of the URL. */
function imageCandidates(value: string): Array<{ url: string; descriptor: string }> {
  const candidates = []
  let index = 0
  while (index < value.length) {
    while (/[\s,]/.test(value[index] ?? '')) index++
    const start = index
    while (index < value.length && !/\s/.test(value[index] ?? '')) index++
    const url = value.slice(start, index)
    if (!url) break
    if (url.endsWith(',')) {
      candidates.push({ url: url.replace(/,+$/, ''), descriptor: '' })
      continue
    }
    let descriptor = '',
      parentheses = 0
    while (index < value.length) {
      const character = value[index++] ?? ''
      if (character === ',' && parentheses === 0) break
      if (character === '(') parentheses++
      else if (character === ')') parentheses = Math.max(0, parentheses - 1)
      descriptor += character
    }
    candidates.push({ url, descriptor: descriptor.trim() })
  }
  return candidates
}

/** Rewrite only static dependencies explicitly snapshotted in this exact present call. No workspace reads. */
export async function prepareHtmlPreview(
  html: string,
  artifact: ArtifactRef,
  detail: () => Promise<Detail>,
  read: (ref: ArtifactRef) => Promise<{ base64: string; bytes: ArrayBuffer }>,
): Promise<string> {
  try {
    if (artifact.size > LIMIT || html.length > LIMIT) throw Error('preview limit')
    const references = elementLocations(html).filter(({ element, location }) => {
      const src = attribute(element, 'src')
      const srcset = attribute(element, 'srcset')
      const style = attribute(element, 'style')
      const css = stylesheet(element, location, html)
      const declarations = style === undefined ? [] : cssUrls(style)
      const hasCssUrl = [...declarations, ...cssUrls(css)].some(({ url }) => local(url))
      return (
        hasCssUrl ||
        (src && local(src) && (mediaTags.has(element.tagName) || element.tagName === 'script')) ||
        (srcset && imageCandidates(srcset).some(({ url }) => local(url))) ||
        (element.tagName === 'object' && local(attribute(element, 'data') ?? '')) ||
        (element.tagName === 'link' &&
          attribute(element, 'rel') === 'stylesheet' &&
          local(attribute(element, 'href') ?? ''))
      )
    })
    if (!references.length) return html
    const { call, result } = await detail()
    const args = object(call.args).files
    const rows = object(result?.structured).deliverables
    if (
      call.name !== 'present' ||
      result?.isError ||
      result?.toolUseId !== call.toolUseId ||
      !Array.isArray(args) ||
      !Array.isArray(rows) ||
      args.length !== rows.length ||
      rows.length > 16
    )
      throw Error('snapshot unavailable')
    const snapshots: Snapshot[] = rows.map((row, index) => {
      const path = object(args[index]).path,
        ref = object(row).ref
      if (typeof path !== 'string' || !path || path.length > 4096) throw Error('snapshot path')
      return { path, ref: ref as ArtifactRef }
    })
    const originals = snapshots.filter(
      ({ ref }) =>
        ref?.sha256 === artifact.sha256 && ref.size === artifact.size && ref.mime === artifact.mime,
    )
    const original = originals[0]
    if (originals.length !== 1 || !original) throw Error('snapshot identity')
    const base = address(original.path),
      directory = new URL('.', base).pathname
    const files = new Map<string, Snapshot>()
    for (const snapshot of snapshots) {
      const path = address(snapshot.path).pathname
      if (files.has(path)) throw Error('ambiguous snapshot')
      files.set(path, snapshot)
    }
    const cached = new Map<string, { base64: string; bytes: ArrayBuffer }>()
    let size = artifact.size
    let expanded = html.length
    const bounded = (value: string) => {
      expanded += value.length
      if (expanded > 4 * LIMIT) throw Error('expanded preview limit')
      return value
    }
    const resource = async (url: string, relativeTo = base) => {
      const target = new URL(url, relativeTo)
      if (target.origin !== base.origin || !target.pathname.startsWith(directory))
        throw Error('outside directory')
      const file = files.get(target.pathname)
      const type = mime[target.pathname.split('.').at(-1)?.toLowerCase() ?? '']
      if (!file || !type || file.ref?.sha256 === artifact.sha256) throw Error('missing snapshot')
      let data = cached.get(target.pathname)
      if (!data) {
        if (!Number.isSafeInteger(file.ref?.size) || file.ref.size < 0 || size + file.ref.size > LIMIT)
          throw Error('preview limit')
        data = await read(file.ref)
        size += data.bytes.byteLength
        if (size > LIMIT) throw Error('preview limit')
        cached.set(target.pathname, data)
      }
      return { ...data, type, target }
    }
    const dataUrl = async (url: string, relativeTo = base) => {
      if (!local(url)) return url
      const data = await resource(url, relativeTo)
      return bounded(`data:${data.type};base64,${data.base64}${data.target.hash}`)
    }
    const css = async (text: string, relativeTo = base) => {
      const edits: Edit[] = []
      for (const { start, end, url } of cssUrls(text)) {
        if (local(url)) edits.push({ start, end, value: cssUrlValue(await dataUrl(url, relativeTo)) })
      }
      return replaceRanges(text, edits)
    }
    const edits: Edit[] = []
    let replacedObjectEnd = 0
    for (const { element, location } of references) {
      // Validate references in object fallback content too. Its edits are covered by the image.
      const covered = location.startOffset < replacedObjectEnd
      const edit = (range: { startOffset: number; endOffset: number }, value: string) => {
        if (!covered) edits.push({ start: range.startOffset, end: range.endOffset, value })
      }
      const replaceAttribute = (name: string, value?: string) => {
        const range = location.attrs?.[name]
        if (!range) throw Error('missing attribute location')
        edit(range, value ?? '')
      }
      const style = attribute(element, 'style')
      const url = attribute(element, 'data') ?? ''
      const href = attribute(element, 'href') ?? ''
      const src = attribute(element, 'src') ?? ''
      const srcset = attribute(element, 'srcset')
      if (element.tagName === 'object' && local(url)) {
        const data = await resource(url)
        if (!data.type.startsWith('image/')) throw Error('unsupported object')
        const attrs = []
        for (const name of ['id', 'class', 'width', 'height']) {
          const value = attribute(element, name)
          if (value !== undefined) attrs.push(attributeText(name, value))
        }
        // Author declarations override the defaults through the normal CSS cascade.
        attrs.push(
          attributeText('style', `width:100%;height:100%;display:block;${await css(style ?? '')}`),
          attributeText('alt', attribute(element, 'aria-label') ?? ''),
          attributeText('src', await dataUrl(url)),
        )
        edit(location, `<img ${attrs.join(' ')}>`)
        if (!covered) replacedObjectEnd = location.endOffset
        continue
      }
      if (element.tagName === 'link' && attribute(element, 'rel') === 'stylesheet' && local(href)) {
        const data = await resource(href)
        if (data.type !== 'text/css') throw Error('stylesheet type')
        const text = bounded(await css(new TextDecoder().decode(data.bytes), data.target))
        if (/<\/style(?=[\t\n\f\r />]|$)/i.test(text)) throw Error('stylesheet end tag')
        const media = attribute(element, 'media')
        const tag = media === undefined ? '<style>' : `<style ${attributeText('media', media)}>`
        edit(location, `${tag}${text}</style>`)
        if (style !== undefined) await css(style)
        continue
      } else if (element.tagName === 'script' && local(src)) {
        if ((await resource(src)).type !== 'text/javascript') throw Error('script type')
        replaceAttribute('src', attributeText('src', await dataUrl(src)))
        if (attribute(element, 'integrity') !== undefined) replaceAttribute('integrity')
      } else {
        if (mediaTags.has(element.tagName) && local(src))
          replaceAttribute('src', attributeText('src', await dataUrl(src)))
        const candidates = imageCandidates(srcset ?? '')
        if (candidates.some(({ url }) => local(url))) {
          const rewritten = []
          for (const { url, descriptor } of candidates)
            rewritten.push([await dataUrl(url), descriptor].filter(Boolean).join(' '))
          replaceAttribute('srcset', attributeText('srcset', rewritten.join(', ')))
        }
      }
      if (element.tagName === 'style') {
        const before = stylesheet(element, location, html)
        const after = await css(before)
        if (before !== after)
          edit(
            {
              startOffset: location.startTag?.endOffset ?? location.endOffset,
              endOffset: location.endTag?.startOffset ?? location.endOffset,
            },
            after,
          )
      }
      if (style !== undefined) {
        const after = await css(style)
        if (style !== after) replaceAttribute('style', attributeText('style', after))
      }
    }
    const output = replaceRanges(html, edits)
    if (output.length > 4 * LIMIT) throw Error('expanded preview limit')
    return output
  } catch {
    throw Object.assign(new Error('HTML preview resources are unavailable'), {
      code: 'HTML_PREVIEW_RESOURCE_UNAVAILABLE',
    })
  }
}

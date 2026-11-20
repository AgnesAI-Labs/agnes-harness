import type { ArtifactRef, ToolCall, ToolResult } from '@agnes/protocol'
import { documentHtmlElement } from './document-preview-policy.js'

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
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const address = (path: string) =>
  new URL(path.replaceAll('\\', '/').replace(/^([a-z]:\/)/i, '/$1'), 'https://preview.invalid/')
const local = (url: string) => !!url.trim() && !/^(?:#|data:|blob:|[a-z][a-z\d+.-]*:|\/\/)/i.test(url.trim())
const cssUrls = (text: string) => [...text.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi)]

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
  // An inert document preserves html/head/body attributes without mounting authored nodes.
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const root = parsed.documentElement
  const references = [
    ...root.querySelectorAll('[src],[srcset],object[data],link[rel=stylesheet],[style],style'),
  ]
  if (root.hasAttribute('style')) references.unshift(root)
  if (
    !references.some(
      (element) =>
        ['src', 'data', 'href'].some((attr) => local(element.getAttribute(attr) ?? '')) ||
        imageCandidates(element.getAttribute('srcset') ?? '').some(({ url }) => local(url)) ||
        [
          element.getAttribute('style') ?? '',
          element.tagName === 'STYLE' ? (element.textContent ?? '') : '',
        ].some((text) => /@import\b/i.test(text) || cssUrls(text).some((match) => local(match[2] ?? ''))),
    )
  )
    return html
  try {
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
    const css = async (text: string, relativeTo = base): Promise<string> => {
      // Imports need another stylesheet graph; refuse rather than silently render an incomplete page.
      if (/@import\b/i.test(text)) throw Error('stylesheet import unavailable')
      const matches = cssUrls(text)
      for (const match of matches)
        text = text.replace(match[0], `url("${await dataUrl(match[2] ?? '', relativeTo)}")`)
      return text
    }
    for (const element of references) {
      if (element.tagName === 'OBJECT') {
        const url = element.getAttribute('data') ?? ''
        if (!local(url)) continue
        const data = await resource(url)
        if (!data.type.startsWith('image/')) throw Error('unsupported object')
        const image = documentHtmlElement('img')
        for (const name of ['id', 'class', 'style', 'width', 'height']) {
          const value = element.getAttribute(name)
          if (value !== null) image.setAttribute(name, value)
        }
        image.setAttribute('alt', element.getAttribute('aria-label') ?? '')
        image.setAttribute('src', await dataUrl(url))
        if (element.hasAttribute('style'))
          image.setAttribute('style', await css(element.getAttribute('style') ?? ''))
        // Authored object styles commonly size only `object`, so retain that layout after conversion.
        image.style.width ||= '100%'
        image.style.height ||= '100%'
        image.style.display ||= 'block'
        element.replaceWith(image)
      } else if (element.tagName === 'LINK' && element.getAttribute('rel') === 'stylesheet') {
        const url = element.getAttribute('href') ?? ''
        if (local(url)) {
          const data = await resource(url)
          if (data.type !== 'text/css') throw Error('stylesheet type')
          const style = documentHtmlElement('style')
          style.textContent = bounded(await css(new TextDecoder().decode(data.bytes), data.target))
          if (element.hasAttribute('media')) style.setAttribute('media', element.getAttribute('media') ?? '')
          element.replaceWith(style)
        }
      } else if (element.tagName === 'SCRIPT' && local(element.getAttribute('src') ?? '')) {
        const data = await resource(element.getAttribute('src') ?? '')
        if (data.type !== 'text/javascript') throw Error('script type')
        element.setAttribute('src', await dataUrl(element.getAttribute('src') ?? ''))
        element.removeAttribute('integrity')
      } else {
        const src = element.getAttribute('src')
        if (src && ['IMG', 'SOURCE', 'VIDEO', 'AUDIO'].includes(element.tagName))
          element.setAttribute('src', await dataUrl(src))
        const srcset = element.getAttribute('srcset')
        if (srcset) {
          const rewritten = []
          for (const { url, descriptor } of imageCandidates(srcset))
            rewritten.push([await dataUrl(url), descriptor].filter(Boolean).join(' '))
          element.setAttribute('srcset', rewritten.join(', '))
        }
      }
      if (element.tagName === 'STYLE') element.textContent = await css(element.textContent ?? '')
      if (element.hasAttribute('style'))
        element.setAttribute('style', await css(element.getAttribute('style') ?? ''))
    }
    const doctype = parsed.doctype ? new XMLSerializer().serializeToString(parsed.doctype) : ''
    return doctype + root.outerHTML
  } catch {
    throw Object.assign(new Error('HTML preview resources are unavailable'), {
      code: 'HTML_PREVIEW_RESOURCE_UNAVAILABLE',
    })
  }
}

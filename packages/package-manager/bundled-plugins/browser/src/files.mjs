import { randomUUID, timingSafeEqual } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { failure } from './policy.mjs'

// Content types describe bytes; rendering/codec support still belongs to the pinned Chromium.
const types = {
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  apng: 'image/apng',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  vtt: 'text/vtt',
}
const inside = (root, target) => {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
const denied = () =>
  failure('FILE_DENIED', 'File preview is outside its authorized directory or unavailable.')
const privatePath = (name) =>
  name
    .split(/[\\/]/)
    .some(
      (part) => ['.git', '.agh', '.ssh', '.aws'].includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part),
    )
const samePath = (left, right) =>
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
const canonicalPath = (path) =>
  realpath(path).catch(() => {
    throw denied()
  })
const textType = (mime, text) =>
  (mime === 'text/html' && /<meta\b[^>]*\bcharset\s*=/i.test(text)) ||
  (mime === 'text/css' && /^@charset\s+["']/i.test(text))
    ? mime
    : mime + '; charset=utf-8'
async function contentType(path, files) {
  const known = types[extname(path).slice(1).toLowerCase()]
  if (known && !known.startsWith('text/')) return known
  const bytes = await files.read(path, { offset: 0, limit: 4096 })
  // Extensionless downloads and renamed files still use their native renderer.
  // Only inspect a bounded prefix, including on range requests for large media.
  const prefix = Buffer.from(bytes)
  const ascii = (start, end) => prefix.toString('latin1', start, end)
  const hex = prefix.subarray(0, 12).toString('hex')
  let text
  try {
    // A bounded prefix may end halfway through a valid multi-byte character.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: bytes.length === 4096 })
  } catch {
    // Preserve BOM/legacy browser decoding instead of declaring non-UTF-8 bytes as UTF-8.
  }
  if (known) return text === undefined ? known : textType(known, text)
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (/^GIF8[79]a/.test(ascii(0, 6))) return 'image/gif'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (hex.startsWith('00000100')) return 'image/x-icon'
  if (ascii(0, 4) === 'RIFF') {
    if (ascii(8, 12) === 'WEBP') return 'image/webp'
    if (ascii(8, 12) === 'WAVE') return 'audio/wav'
  }
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if (ascii(0, 4) === 'OggS') return 'application/ogg'
  if (ascii(0, 4) === 'fLaC') return 'audio/flac'
  if (hex.startsWith('1a45dfa3') && prefix.includes(Buffer.from('webm'))) return 'video/webm'
  if (ascii(4, 8) === 'ftyp') {
    if (/avif|avis/.test(ascii(8, 40))) return 'image/avif'
    return 'video/mp4'
  }
  if (hex.startsWith('fffe') || hex.startsWith('feff')) return 'text/plain'
  if (ascii(0, 3) === 'ID3' || (prefix[0] === 255 && (prefix[1] & 0xe0) === 0xe0))
    return (prefix[1] & 0xf6) === 0xf0 ? 'audio/aac' : 'audio/mpeg'
  if (text !== undefined) {
    if (
      [...text].some((char) => {
        const code = char.codePointAt(0)
        return code < 9 || (code > 13 && code < 32)
      })
    )
      return undefined
    const markup = text.replace(/^\s*<\?xml[^?]*\?>/i, '').trimStart()
    if (/^(?:<!doctype html|<html[\s>])/i.test(markup)) return textType('text/html', text)
    if (/^<svg[\s>]/i.test(markup)) return 'image/svg+xml'
    if (/^\s*<\?xml[\s>]/i.test(text)) return 'application/xml'
    return textType('text/plain', text)
  }
}

export function localFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw denied()
  if (/^file:/i.test(value)) {
    const url = new URL(value)
    if (url.hostname || url.search) throw denied()
    return { path: fileURLToPath(url), hash: url.hash }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined
  return { path: value, hash: '' }
}

/** A tab-owned loopback resource, not an HTTP file server exposed to the user/network.
 * Chromium routing adds an unexposed admission header. Every byte window re-enters
 * current session filesystem authority; there is no retained call fs or whole-file buffer. */
export async function openFilePreview({ value, root, previewRoot, files, assertCurrent }) {
  if (!files || !root) throw denied()
  const input = localFile(value)
  if (!input) throw denied()
  const target = resolve(root, input.path)
  const directory = resolve(root, previewRoot ?? dirname(target))
  if (!inside(resolve(root), directory) || !inside(directory, target) || privatePath(relative(root, target)))
    throw denied()
  // Reject aliases before handing a path to a browser. The filesystem port independently
  // checks current policy and performs its canonical no-follow reads on every window.
  const canonical = await canonicalPath(directory)
  if (!samePath(canonical, directory) || !samePath(await canonicalPath(target), target)) throw denied()
  const check = async (path) => {
    assertCurrent()
    if (!inside(directory, path) || privatePath(relative(directory, path))) throw denied()
    if (!samePath(await canonicalPath(path), path) || !samePath(await canonicalPath(directory), directory))
      throw denied()
    const info = await files.stat(path)
    assertCurrent()
    if (info.kind !== 'file' || !Number.isSafeInteger(info.size) || info.size < 0) throw denied()
    return info
  }
  await check(target)
  const initialType = await contentType(target, files)
  if (!initialType || initialType.startsWith('font/') || initialType === 'application/wasm')
    throw failure('UNSUPPORTED_FILE', 'This file type cannot be rendered by the pinned browser.')
  const secret = randomUUID()
  let stopped = false,
    origin
  const server = createServer(async (request, response) => {
    try {
      const supplied = request.headers['x-agh-browser-resource']
      if (
        stopped ||
        request.headers.host !== new URL(origin).host ||
        typeof supplied !== 'string' ||
        supplied.length !== secret.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
      )
        throw denied()
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405).end()
        return
      }
      const url = new URL(request.url, origin)
      const name = decodeURIComponent(url.pathname).replace(/^\//, '')
      if (name.includes('\\') || name.includes('\0') || name.includes(':')) throw denied()
      const path = resolve(directory, name)
      const info = await check(path)
      const mime = (await contentType(path, files)) ?? 'application/octet-stream'
      let start = 0,
        end = info.size - 1,
        status = 200
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
        if (!range || (!range[1] && !range[2])) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end()
          return
        }
        if (!range[1]) start = Math.max(0, info.size - Number(range[2]))
        else {
          start = Number(range[1])
          if (range[2]) end = Math.min(end, Number(range[2]))
        }
        if (![start, end].every(Number.isSafeInteger) || start < 0 || start > end || start >= info.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end()
          return
        }
        status = 206
      }
      response.writeHead(status, {
        'Content-Type': mime,
        'Content-Length': Math.max(0, end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      for (let offset = start; offset <= end && !response.destroyed; ) {
        if (stopped) throw denied()
        await check(path)
        const bytes = await files.read(path, { offset, limit: Math.min(256 * 1024, end - offset + 1) })
        assertCurrent()
        if (stopped || !bytes.length) throw denied()
        offset += bytes.length
        if (!response.write(bytes))
          await new Promise((done) => {
            const finish = () => {
              response.off('drain', finish)
              response.off('close', finish)
              done()
            }
            response.once('drain', finish)
            response.once('close', finish)
          })
      }
      response.end()
    } catch {
      if (!response.headersSent) response.writeHead(403).end()
      else response.destroy()
    }
  })
  server.maxConnections = 16
  server.headersTimeout = 5000
  server.requestTimeout = 15000
  server.keepAliveTimeout = 1000
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  origin = 'http://127.0.0.1:' + server.address().port
  server.unref()
  return {
    directory,
    origin,
    url: origin + '/' + relative(directory, target).split(sep).map(encodeURIComponent).join('/') + input.hash,
    fileUrl: pathToFileURL(target).href + input.hash,
    sourceUrl(value) {
      const url = new URL(value)
      return (
        pathToFileURL(resolve(directory, decodeURIComponent(url.pathname).replace(/^\//, ''))).href +
        url.search +
        url.hash
      )
    },
    headers: { 'x-agh-browser-resource': secret },
    close() {
      if (stopped) return
      stopped = true
      server.closeAllConnections()
      server.close()
    },
  }
}

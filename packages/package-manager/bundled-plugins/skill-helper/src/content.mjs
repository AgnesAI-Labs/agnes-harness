import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

export const LIMITS = Object.freeze({
  file: 1024 * 1024,
  total: 8 * 1024 * 1024,
  archive: 16 * 1024 * 1024,
  files: 64,
  entries: 128,
})
export const fail = (code, message = code) => Object.assign(new Error(message), { code })
export function segment(value) {
  if (
    typeof value !== 'string' ||
    !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/.test(value) ||
    value.endsWith('.') ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  )
    throw fail('INVALID_NAME')
  return value
}
export function filePath(value) {
  if (typeof value !== 'string' || value.length > 640 || value.split('/').length > 5)
    throw fail('INVALID_FILE_PATH')
  value.split('/').forEach(segment)
  return value
}
export function checkedFiles(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > LIMITS.files) throw fail('FILE_LIMIT')
  const seen = new Set(),
    directories = new Set()
  let total = 0
  const result = input.map(({ path, content }) => {
    filePath(path)
    const lower = path.toLowerCase()
    if (seen.has(lower)) throw fail('DUPLICATE_FILE')
    seen.add(lower)
    const parts = lower.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) throw fail('INVALID_CONTENT')
    const bytes = Buffer.from(content)
    total += bytes.length
    if (bytes.length > LIMITS.file || total > LIMITS.total) throw fail('SIZE_LIMIT')
    return { path, content: bytes }
  })
  if (directories.size + seen.size > LIMITS.entries || [...directories].some((dir) => seen.has(dir)))
    throw fail('FILE_DIRECTORY_CONFLICT')
  const document = result.find((file) => file.path === 'SKILL.md')
  if (
    !document ||
    document.content.length > 256 * 1024 ||
    !/^---\r?\n/.test(document.content.toString('utf8'))
  )
    throw fail('SKILL_DOCUMENT_REQUIRED')
  return result
}
export function localPath(input, cwd) {
  if (typeof input !== 'string' || !input || [...input].some((c) => c.charCodeAt(0) < 32))
    throw fail('INVALID_LOCAL_PATH')
  return isAbsolute(input) ? input : resolve(cwd, input)
}
export function requireInstall(ctx) {
  if (!ctx.skillInstall?.request)
    throw fail('AGH_UPGRADE_REQUIRED', '请更新 AGH：当前宿主没有受控 Skill 安装通道。')
  if (ctx.session.depth !== 0) throw fail('MAIN_SESSION_REQUIRED')
  ctx.signal.throwIfAborted()
  return ctx.skillInstall
}
export async function stage(ctx, name, files) {
  // Same code as the host's directory-name check, so both carry one naming hint.
  try {
    segment(name)
  } catch {
    throw fail('SKILL_NAME_INVALID')
  }
  const checked = checkedFiles(files)
  const directory = join(ctx.cwd, '.skill-helper', randomUUID(), name)
  for (const file of checked) {
    ctx.signal.throwIfAborted()
    await ctx.fs.write(join(directory, ...file.path.split('/')), file.content)
  }
  return directory
}
export function httpsURL(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw fail('INVALID_URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw fail('PUBLIC_HTTPS_REQUIRED')
  return url
}
export async function publicText(ctx, value) {
  const url = httpsURL(value)
  if (!ctx.net.fetchPublic) throw fail('AGH_PUBLIC_FETCH_REQUIRED')
  ctx.signal.throwIfAborted()
  const response = await ctx.net.fetchPublic(url.href)
  ctx.signal.throwIfAborted()
  if (response.statusCode < 200 || response.statusCode >= 300) throw fail(`HTTP_${response.statusCode}`)
  if (response.truncation.bytes || response.truncation.decoded) throw fail('DOWNLOAD_TRUNCATED')
  if (response.body.kind !== 'text')
    throw fail(
      'DIRECT_TEXT_REQUIRED',
      '需要原始 Markdown 或 JSON 地址；网页、登录页和远程压缩包请先下载到本地。',
    )
  const content = response.body.content
  if (Buffer.byteLength(content) > LIMITS.file * 2) throw fail('DOWNLOAD_TOO_LARGE')
  return content
}
export async function publicJSON(ctx, url) {
  try {
    return JSON.parse(await publicText(ctx, url))
  } catch (error) {
    if (error.code) throw error
    throw fail('INVALID_JSON')
  }
}
export async function publicZip(ctx, value) {
  const url = httpsURL(value)
  if (!ctx.net.fetchPublic) throw fail('AGH_PUBLIC_FETCH_REQUIRED')
  ctx.signal.throwIfAborted()
  const response = await ctx.net.fetchPublic(url.href, { responseType: 'zip' })
  ctx.signal.throwIfAborted()
  if (response.statusCode < 200 || response.statusCode >= 300) throw fail(`HTTP_${response.statusCode}`)
  if (response.truncation.bytes || response.truncation.decoded) throw fail('GITHUB_ARCHIVE_TOO_LARGE')
  if (response.body.kind !== 'zip' || typeof response.body.base64 !== 'string')
    throw fail('GITHUB_ARCHIVE_UNAVAILABLE')
  const bytes = Buffer.from(response.body.base64, 'base64')
  if (bytes.toString('base64') !== response.body.base64) throw fail('GITHUB_ARCHIVE_UNAVAILABLE')
  return bytes
}

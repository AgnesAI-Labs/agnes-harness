import { checkedFiles, fail, httpsURL, LIMITS, localPath, publicText } from './content.mjs'
import { github } from './github.mjs'
import { archive } from './zip.mjs'

export const sourceAdapters = Object.freeze({
  github,
  async url(ctx, input) {
    const url = httpsURL(input.source)
    if (/\.(zip|gz|tar|7z)(?:$|\/)/i.test(url.pathname))
      throw fail('DOWNLOAD_ARCHIVE_LOCALLY', '远程压缩包请先下载到本地，再导入；不会绕过 AGH 公开网络保护。')
    const text = await publicText(ctx, url.href)
    if (/^---\r?\n/.test(text)) {
      if (!input.name) throw fail('SKILL_NAME_REQUIRED', '导入单个 Markdown 时请提供安装目录名 name。')
      return {
        name: input.name,
        files: checkedFiles([{ path: 'SKILL.md', content: text }]),
        message: '单文件导入不包含文中链接的附属文件。',
      }
    }
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      throw fail('DIRECT_SKILL_OR_MANIFEST_REQUIRED')
    }
    if (manifest?.version !== 1 || typeof manifest.name !== 'string' || !Array.isArray(manifest.files))
      throw fail('INVALID_SKILL_MANIFEST')
    return { name: input.name ?? manifest.name, files: checkedFiles(manifest.files) }
  },
  async archive(ctx, input) {
    const path = localPath(input.source, ctx.cwd)
    const stat = await ctx.fs.stat(path)
    if (stat.kind !== 'file' || stat.size > LIMITS.archive) throw fail('ARCHIVE_SIZE_OR_TYPE')
    ctx.signal.throwIfAborted()
    const bytes = await ctx.fs.read(path)
    if (bytes.length !== stat.size) throw fail('SOURCE_CHANGED')
    return archive(bytes, input)
  },
  async local(ctx, input) {
    // No source scan here: the core asks before reading even outside the workspace.
    return { directory: localPath(input.source, ctx.cwd) }
  },
})
export function sourceKind(source) {
  if (/^https:\/\//i.test(source)) return httpsURL(source).hostname === 'github.com' ? 'github' : 'url'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw fail('PUBLIC_HTTPS_REQUIRED')
  return /\.zip$/i.test(source) ? 'archive' : 'local'
}

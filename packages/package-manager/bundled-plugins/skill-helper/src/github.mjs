import {
  checkedFiles,
  fail,
  filePath,
  httpsURL,
  LIMITS,
  publicJSON,
  publicText,
  publicZip,
  segment,
} from './content.mjs'
import { archive } from './zip.mjs'

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/')
export function githubLocation(source, ref, subdirectory) {
  const url = httpsURL(source)
  if (url.hostname !== 'github.com' || url.search) throw fail('INVALID_GITHUB_URL')
  const parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent)
  if (parts.length < 2) throw fail('INVALID_GITHUB_URL')
  const owner = segment(parts[0]),
    repo = segment(parts[1].replace(/\.git$/, ''))
  let path = subdirectory ?? ''
  if (parts.length > 2) {
    if (!['tree', 'blob'].includes(parts[2]) || !parts[3]) throw fail('INVALID_GITHUB_URL')
    ref ??= parts[3]
    path = subdirectory ?? parts.slice(4).join('/')
    if (parts[2] === 'blob' && path.endsWith('SKILL.md')) path = path.split('/').slice(0, -1).join('/')
  }
  if (path) filePath(path)
  if (ref !== undefined && (typeof ref !== 'string' || !ref || ref.length > 256 || ref.startsWith('-')))
    throw fail('INVALID_GIT_REF')
  return { owner, repo, ref, path }
}
async function githubApi(ctx, input, location) {
  const api = `https://api.github.com/repos/${location.owner}/${location.repo}`
  const ref = location.ref ?? (await publicJSON(ctx, api)).default_branch
  if (typeof ref !== 'string' || !ref) throw fail('GITHUB_REF_UNAVAILABLE')
  const commit = (await publicJSON(ctx, `${api}/commits/${encodeURIComponent(ref)}`)).sha
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw fail('INVALID_GITHUB_COMMIT')
  let count = 0,
    bytes = 0
  const files = [],
    candidates = []
  const walk = async (path, relative, depth) => {
    if (depth > 4) throw fail('DIRECTORY_DEPTH_LIMIT')
    const entries = await publicJSON(ctx, `${api}/contents/${encodePath(path)}?ref=${commit}`)
    if (!Array.isArray(entries)) throw fail('GITHUB_DIRECTORY_REQUIRED')
    if (count + entries.length > LIMITS.entries)
      throw fail('DIRECTORY_ENTRY_LIMIT', '目录太大，请提供具体 Skill 子目录地址。')
    count += entries.length
    for (const entry of entries) {
      segment(entry.name)
      const actual = path ? `${path}/${entry.name}` : entry.name
      if (
        entry.path !== actual ||
        !['file', 'dir'].includes(entry.type) ||
        entry.submodule_git_url ||
        entry.target
      )
        throw fail('GITHUB_SPECIAL_ENTRY')
      const target = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.type === 'dir') {
        await walk(actual, target, depth + 1)
        continue
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > LIMITS.file)
        throw fail('SIZE_LIMIT')
      bytes += entry.size
      if (bytes > LIMITS.total || files.length >= LIMITS.files)
        throw fail('SIZE_LIMIT', '目录太大，请提供具体 Skill 子目录地址。')
      files.push({ path: target, remote: actual, size: entry.size })
      if (entry.name === 'SKILL.md') candidates.push(relative)
    }
  }
  await walk(location.path, '', 0)
  if (!candidates.includes('')) {
    return {
      state: 'selection_required',
      commit,
      candidates: candidates.map((p) => ({
        source: input.source,
        ref: commit,
        subdirectory: [location.path, p].filter(Boolean).join('/'),
      })),
      message: candidates.length
        ? '请选择一个 Skill 子目录，再导入。'
        : '没有找到 SKILL.md，请提供具体目录。',
    }
  }
  const result = []
  for (const file of files) {
    const data = await publicJSON(ctx, `${api}/contents/${encodePath(file.remote)}?ref=${commit}`)
    if (
      data.type !== 'file' ||
      data.target ||
      data.submodule_git_url ||
      data.path !== file.remote ||
      data.encoding !== 'base64' ||
      typeof data.content !== 'string'
    )
      throw fail('GITHUB_FILE_UNAVAILABLE')
    const encoded = data.content.replace(/\n/g, '')
    const content = Buffer.from(encoded, 'base64')
    if (content.toString('base64') !== encoded || content.length !== file.size)
      throw fail('GITHUB_FILE_CHANGED')
    result.push({ path: file.path, content })
  }
  return {
    name: input.name ?? (location.path.split('/').at(-1) || location.repo),
    files: checkedFiles(result),
    commit,
  }
}
async function githubArchive(ctx, input, location) {
  const feed = location.ref
    ? `https://github.com/${location.owner}/${location.repo}/commits/${encodeURIComponent(location.ref)}.atom`
    : `https://github.com/${location.owner}/${location.repo}/commits.atom`
  const commit = /^[a-f0-9]{40}$/.test(location.ref ?? '')
    ? location.ref
    : /<entry>\s*<id>tag:github\.com,2008:Grit::Commit\/([a-f0-9]{40})<\/id>/.exec(
        await publicText(ctx, feed),
      )?.[1]
  if (!commit) throw fail('GITHUB_REF_UNAVAILABLE')
  const bytes = await publicZip(
    ctx,
    `https://codeload.github.com/${location.owner}/${location.repo}/zip/${commit}`,
  )
  const listed = archive(bytes, { candidatesOnly: true })
  const roots = new Set(listed.candidates.map((candidate) => candidate.split('/')[0]))
  if (roots.size !== 1) throw fail('GITHUB_ARCHIVE_LAYOUT')
  const prefix = [...roots][0]
  if (!prefix.startsWith(`${location.repo}-`)) throw fail('GITHUB_ARCHIVE_LAYOUT')
  const selected = [prefix, location.path].filter(Boolean).join('/')
  if (!listed.candidates.includes(selected)) {
    const candidates = listed.candidates
      .filter((candidate) => candidate.startsWith(`${selected}/`))
      .map((candidate) => ({
        source: input.source,
        ref: commit,
        subdirectory: candidate.slice(prefix.length + 1),
      }))
    return {
      state: 'selection_required',
      commit,
      candidates,
      message: candidates.length
        ? '请选择一个 Skill 子目录，再导入。'
        : '没有找到 SKILL.md，请提供具体目录。',
    }
  }
  const result = archive(bytes, {
    name: input.name ?? (location.path.split('/').at(-1) || location.repo),
    subdirectory: selected,
  })
  return { ...result, commit }
}
export async function github(ctx, input) {
  const location = githubLocation(input.source, input.ref, input.subdirectory)
  try {
    return await githubApi(ctx, input, location)
  } catch (error) {
    if (!['HTTP_403', 'HTTP_429'].includes(error?.code)) throw error
    return githubArchive(ctx, input, location)
  }
}

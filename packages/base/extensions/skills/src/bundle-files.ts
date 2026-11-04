import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  isSkillBundleIgnored,
  isSkillBundleMarker,
  isSkillBundlePath,
  SKILL_BUNDLE_LIMITS,
  SKILL_BUNDLE_MARKER,
  skillBundleFileKind,
} from '@agnes/protocol'
import type { SkillFile } from './assets.js'
import type { SkillFs } from './discover.js'

const fail = (): never => {
  throw Object.assign(new Error('Incomplete Skill bundle'), { code: 'SKILL_ATTACHMENTS_UNREADABLE' })
}

/** A managed bundle is complete or unavailable; no unsupported bytes are silently omitted. */
export async function collectSkillBundle(
  fs: SkillFs,
  directory: string,
): Promise<readonly SkillFile[] | undefined> {
  let rootEntries: Awaited<ReturnType<SkillFs['list']>>
  try {
    rootEntries = await fs.list(directory)
  } catch {
    return undefined
  }
  const markerEntry = rootEntries.find((entry) => entry.name === SKILL_BUNDLE_MARKER)
  if (!markerEntry) return undefined
  if (markerEntry.kind !== 'file') fail()
  const markerPath = join(directory, SKILL_BUNDLE_MARKER)
  if (fs.realpath && (await fs.realpath(markerPath)) !== markerPath) fail()
  const markerStat = await fs.stat(markerPath)
  if (markerStat.kind !== 'file' || markerStat.size > 256 || markerStat.size < 0) fail()
  const marker = await fs.read(markerPath)
  if (
    marker.byteLength > 256 ||
    !isSkillBundleMarker(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker)))
  )
    fail()
  const files: SkillFile[] = []
  const seen = new Set<string>()
  let total = 0
  let visits = 0
  const walk = async (relative: string) => {
    for (const entry of await fs.list(join(directory, relative))) {
      if (isSkillBundleIgnored(entry.name)) continue
      if (++visits > SKILL_BUNDLE_LIMITS.entries) fail()
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (!isSkillBundlePath(name) || seen.has(name.normalize('NFKC').toLowerCase())) fail()
      seen.add(name.normalize('NFKC').toLowerCase())
      if (entry.kind === 'dir') {
        await walk(name)
        continue
      }
      if (entry.kind !== 'file') fail()
      const kind = skillBundleFileKind(name)
      if (!kind) fail()
      const path = join(directory, name)
      if (fs.realpath && (await fs.realpath(path)) !== path) fail()
      const stat = await fs.stat(path)
      if (
        stat.kind !== 'file' ||
        stat.size < 0 ||
        stat.size > SKILL_BUNDLE_LIMITS.fileBytes ||
        !Number.isSafeInteger(stat.size)
      )
        fail()
      const bytes = await fs.read(path)
      total += bytes.byteLength
      if (
        bytes.byteLength !== stat.size ||
        total > SKILL_BUNDLE_LIMITS.bytes ||
        seen.size > SKILL_BUNDLE_LIMITS.files
      )
        fail()
      // Source files can contain literal NUL separators inside valid JS strings. Validate UTF-8
      // without rewriting the reviewed bytes; text-only authoring retains its stricter rules.
      if (kind === 'text') new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (name === 'SKILL.md') continue
      files.push({
        relativePath: name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        kind: kind ?? fail(),
        mime: kind === 'text' ? 'text/plain' : 'application/octet-stream',
        bytes,
      })
    }
  }
  await walk('')
  // Keep the marker itself in the revision; removing it changes the candidate's revision too.
  return Object.freeze(files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)))
}

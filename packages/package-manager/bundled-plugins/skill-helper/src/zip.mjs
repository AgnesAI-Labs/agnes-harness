import { inflateRawSync } from 'node:zlib'
import { checkedFiles, fail, filePath, LIMITS, segment } from './content.mjs'

export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
/** Parse central metadata before inflation. No paths are extracted by a shell or archive program. */
export function archive(bytes, { name, subdirectory, candidatesOnly = false } = {}) {
  try {
    return readArchive(Buffer.from(bytes), name, subdirectory, candidatesOnly)
  } catch (error) {
    if (error.code && !error.code.startsWith('ERR_') && !error.code.startsWith('Z_')) throw error
    throw fail('INVALID_ZIP')
  }
}
function readArchive(data, name, selected, candidatesOnly) {
  if (data.length > LIMITS.archive) throw fail('ARCHIVE_SIZE_LIMIT')
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) {
      end = i
      break
    }
  }
  if (end < 0) throw fail('INVALID_ZIP')
  const count = data.readUInt16LE(end + 10),
    size = data.readUInt32LE(end + 12),
    offset = data.readUInt32LE(end + 16)
  if (
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== count ||
    count > LIMITS.entries ||
    offset + size !== end
  )
    throw fail('ZIP_LAYOUT_UNSUPPORTED')
  const entries = [],
    spans = [],
    seen = new Set()
  let cursor = offset,
    total = 0
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw fail('INVALID_ZIP')
    const flags = data.readUInt16LE(cursor + 8),
      method = data.readUInt16LE(cursor + 10)
    const crc = data.readUInt32LE(cursor + 16),
      compressed = data.readUInt32LE(cursor + 20),
      original = data.readUInt32LE(cursor + 24)
    const length = data.readUInt16LE(cursor + 28),
      extra = data.readUInt16LE(cursor + 30),
      comment = data.readUInt16LE(cursor + 32)
    const mode = (data.readUInt32LE(cursor + 38) >>> 16) & 0xf000,
      local = data.readUInt32LE(cursor + 42)
    const rawName = data.subarray(cursor + 46, cursor + 46 + length)
    const path = rawName.toString('utf8'),
      directory = path.endsWith('/')
    const clean = directory ? path.slice(0, -1) : path
    if (Buffer.from(path).compare(rawName) !== 0 || clean.split('/').length > 7)
      throw fail('INVALID_FILE_PATH')
    clean.split('/').forEach(segment)
    if (seen.has(clean.toLowerCase())) throw fail('DUPLICATE_FILE')
    seen.add(clean.toLowerCase())
    if (
      flags & 1 ||
      flags & 0x40 ||
      ![0, 8].includes(method) ||
      ![0, 0x4000, 0x8000].includes(mode) ||
      data.readUInt16LE(cursor + 34) ||
      (directory && original !== 0) ||
      (mode === 0x4000 && !directory) ||
      (mode === 0x8000 && directory)
    )
      throw fail('ZIP_SPECIAL_ENTRY')
    total += original
    if (original > LIMITS.file || total > LIMITS.total) throw fail('SIZE_LIMIT')
    if (
      data.readUInt32LE(local) !== 0x04034b50 ||
      local >= offset ||
      data.readUInt16LE(local + 6) !== flags ||
      data.readUInt16LE(local + 8) !== method
    )
      throw fail('INVALID_ZIP')
    const localLength = data.readUInt16LE(local + 26),
      localExtra = data.readUInt16LE(local + 28)
    if (!rawName.equals(data.subarray(local + 30, local + 30 + localLength))) throw fail('ZIP_NAME_MISMATCH')
    const start = local + 30 + localLength + localExtra
    if (start + compressed > offset) throw fail('INVALID_ZIP')
    if (spans.some(([a, b]) => local < b && start + compressed > a)) throw fail('ZIP_OVERLAPPING_ENTRIES')
    spans.push([local, start + compressed])
    entries.push({ path: clean, directory, crc, original, compressed, start, method })
    cursor += 46 + length + extra + comment
    if (cursor > end) throw fail('INVALID_ZIP')
  }
  if (cursor !== end) throw fail('INVALID_ZIP')
  const candidates = entries
    .filter((e) => !e.directory && e.path.split('/').at(-1) === 'SKILL.md')
    .map((e) => e.path.split('/').slice(0, -1).join('/'))
  if (!candidates.length) throw fail('SKILL_DOCUMENT_REQUIRED')
  if (candidatesOnly) return { state: 'selection_required', candidates }
  if (selected !== undefined && selected !== '') filePath(selected)
  if (selected === undefined) {
    if (candidates.includes('')) selected = ''
    else if (candidates.length === 1) selected = candidates[0]
    else return { state: 'selection_required', candidates, message: '请选择压缩包中的 Skill 子目录。' }
  }
  if (!candidates.includes(selected)) throw fail('SKILL_DOCUMENT_REQUIRED')
  const prefix = selected ? `${selected}/` : ''
  const files = entries
    .filter((e) => !e.directory && e.path.startsWith(prefix))
    .map((e) => {
      const compressed = data.subarray(e.start, e.start + e.compressed)
      const content =
        e.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: Math.max(1, e.original) })
      if (content.length !== e.original || crc32(content) !== e.crc) throw fail('ZIP_INTEGRITY_FAILED')
      return { path: e.path.slice(prefix.length), content }
    })
  return { name: name ?? (selected.split('/').at(-1) || 'imported-skill'), files: checkedFiles(files) }
}

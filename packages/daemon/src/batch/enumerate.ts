import type { Dirent, OpenDirOptions } from 'node:fs'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { BatchSpecError, inside, MAX_ITEMS, singleLine, toPosix } from './spec.js'

export type ItemKind = 'image' | 'text' | 'other'
export type EnumeratedItem = Readonly<{
  path: string
  kind: ItemKind
  bytes: number
  skip?: 'too_large' | 'unsupported_type' | 'outside_root' | 'unreadable_name'
}>

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg'])
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'log',
  'xml',
  'yaml',
  'yml',
])
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_BYTES = 1024 * 1024
/** Every directory entry seen counts, listed or not, so a huge tree is refused instead of walked. */
export const MAX_ENTRIES = 200_000
const MAX_DEPTH = 32

/** Earlier batches write their results here; they are never inputs. */
export const RESULTS_FOLDER = 'agh-batch'

/** The name as text when its bytes are UTF-8 that survives a round trip; otherwise undefined. */
export function decodeName(raw: Uint8Array): string | undefined {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined
}

/** A name that is not UTF-8, one byte per `\xNN` outside printable ASCII (and for `\`): one line, distinct per name. */
export function escapeName(raw: Uint8Array): string {
  let text = ''
  for (const byte of raw)
    text +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`
  return text
}

type Entry = Readonly<{
  name: string
  readable: boolean
  type: 'directory' | 'file' | 'link' | 'other'
}>

const typeOf = (entry: Dirent<Buffer>): Entry['type'] =>
  entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other'

// Readable names before escaped ones that read the same, so the real file keeps the plain path.
const byName = (a: Entry, b: Entry): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : Number(b.readable) - Number(a.readable)

/**
 * Walks `dirAbs` in name order. Hidden entries, the results folder and the whole `agh-batch` folder
 * are left out, directory links are not followed, file links count only when they resolve to a
 * regular file, and anything that is not a regular file (pipes, sockets, devices) is left out. Only
 * metadata is read: no file is opened. Item paths are workspace-relative and lexical: a file link
 * keeps the link's own path. A name that is not UTF-8 (possible on Linux) cannot be named to the read
 * tool, so it is listed as skipped under an escaped path (a folder once, for all it holds); paths are
 * made distinct.
 */
export async function enumerateItems(input: {
  root: string
  dirAbs: string
  outAbs: string
  ext?: readonly string[]
  maxItems?: number
  maxEntries?: number
}): Promise<EnumeratedItem[]> {
  const maxItems = input.maxItems ?? MAX_ITEMS
  const maxEntries = input.maxEntries ?? MAX_ENTRIES
  const results = join(input.root, RESULTS_FOLDER)
  if (input.dirAbs.includes('\0') || !inside(input.root, input.dirAbs))
    throw new BatchSpecError('dir must stay inside the workspace')
  if (inside(results, input.dirAbs))
    throw new BatchSpecError(`dir must not be inside ${RESULTS_FOLDER}, where batch results are kept`)
  const rootReal = await realpath(input.root).catch(() => undefined)
  if (!rootReal) throw new BatchSpecError('the workspace folder does not exist')
  const dirReal = await realpath(input.dirAbs).catch(() => undefined)
  const dirInfo = dirReal ? await stat(dirReal).catch(() => undefined) : undefined
  if (!dirReal || !dirInfo?.isDirectory()) throw new BatchSpecError('dir is not an existing folder')
  if (!inside(rootReal, dirReal)) throw new BatchSpecError('dir resolves outside the workspace')
  const allow = input.ext && input.ext.length > 0 ? new Set(input.ext) : undefined
  const items: EnumeratedItem[] = []
  let entries = 0
  const push = (item: EnumeratedItem): void => {
    items.push(item)
    if (items.length > maxItems) throw new BatchSpecError(`dir holds more than ${maxItems} files`)
  }
  const add = (path: string, ext: string, bytes: number): void => {
    const kind: ItemKind = IMAGE_EXTENSIONS.has(ext) ? 'image' : TEXT_EXTENSIONS.has(ext) ? 'text' : 'other'
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
    push(
      kind === 'other'
        ? { path, kind, bytes, skip: 'unsupported_type' }
        : bytes > limit
          ? { path, kind, bytes, skip: 'too_large' }
          : { path, kind, bytes },
    )
  }
  const relativePath = (abs: string): string => toPosix(relative(input.root, abs))
  // Streams the listing so the entry limit applies before a huge directory is held in memory. Names
  // are read as bytes so that one which is not UTF-8 is seen as such, not silently replaced.
  const list = async (dir: string): Promise<Entry[]> => {
    const cannot = () => new BatchSpecError(`cannot list ${singleLine(relativePath(dir)) || '.'}`)
    const found: Entry[] = []
    const handle = await opendir(dir, { encoding: 'buffer' } as unknown as OpenDirOptions).catch(() => {
      throw cannot()
    })
    try {
      for await (const entry of handle as AsyncIterable<unknown> as AsyncIterable<Dirent<Buffer>>) {
        if (++entries > maxEntries) throw new BatchSpecError(`dir holds more than ${maxEntries} entries`)
        if (entry.name[0] === 0x2e) continue
        const name = decodeName(entry.name)
        found.push({
          name: name ?? escapeName(entry.name),
          readable: name !== undefined,
          type: typeOf(entry),
        })
      }
    } catch (error) {
      throw error instanceof BatchSpecError ? error : cannot()
    }
    return found.sort(byName)
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new BatchSpecError(`dir nests folders deeper than ${MAX_DEPTH} levels`)
    for (const entry of await list(dir)) {
      if (entry.type === 'other') continue
      const ext = extname(entry.name).slice(1).toLowerCase()
      if (!entry.readable) {
        if (entry.type === 'directory' || !allow || allow.has(ext))
          push({
            path: `${relativePath(dir)}/${entry.name}`,
            kind: 'other',
            bytes: 0,
            skip: 'unreadable_name',
          })
        continue
      }
      const abs = join(dir, entry.name)
      if (inside(input.outAbs, abs) || inside(results, abs)) continue
      if (entry.type === 'directory') {
        await walk(abs, depth + 1)
        continue
      }
      if (allow && !allow.has(ext)) continue
      const path = relativePath(abs)
      if (entry.type === 'link') {
        // Dangling and looping links fail realpath; links to folders or special files are not items.
        const target = await realpath(abs).catch(() => undefined)
        const info = target ? await stat(target).catch(() => undefined) : undefined
        if (!target || !info?.isFile()) continue
        if (!inside(rootReal, target)) push({ path, kind: 'other', bytes: 0, skip: 'outside_root' })
        else add(path, ext, info.size)
        continue
      }
      // The entry may have changed since it was listed; only a regular file is an item.
      const info = await lstat(abs).catch(() => undefined)
      if (info?.isFile()) add(path, ext, info.size)
    }
  }
  await walk(input.dirAbs, 0)
  return distinctPaths(items)
}

/** An escaped name can read like a real one (`a\\xff` is a legal name); the escaped entry gives way. */
function distinctPaths(items: EnumeratedItem[]): EnumeratedItem[] {
  const taken = new Set<string>()
  const seen = new Map<string, number>()
  for (const item of items) {
    taken.add(item.path)
    seen.set(item.path, (seen.get(item.path) ?? 0) + 1)
  }
  return items.map((item) => {
    if (item.skip !== 'unreadable_name' || seen.get(item.path) === 1) return item
    let suffix = 2
    while (taken.has(`${item.path}~${suffix}`)) suffix += 1
    const path = `${item.path}~${suffix}`
    taken.add(path)
    return { ...item, path }
  })
}

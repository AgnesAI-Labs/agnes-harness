import type { Dirent } from 'node:fs'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { BatchSpecError, inside, MAX_ITEMS, toPosix } from './spec.js'

export type ItemKind = 'image' | 'text' | 'other'
export type EnumeratedItem = Readonly<{
  path: string
  kind: ItemKind
  bytes: number
  skip?: 'too_large' | 'unsupported_type' | 'outside_root'
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
export const MAX_ENTRIES = 1_000_000
const MAX_DEPTH = 32

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * Walks `dirAbs` in name order. Hidden entries and the results folder are left out, directory links
 * are not followed, file links count only when they resolve to a regular file, and anything that is
 * not a regular file (pipes, sockets, devices) is left out. Only metadata is read: no file is opened.
 * Item paths are workspace-relative and lexical: a file link keeps the link's own path.
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
  if (input.dirAbs.includes('\0') || !inside(input.root, input.dirAbs))
    throw new BatchSpecError('dir must stay inside the workspace')
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
  // Streams the listing so the entry limit applies before a huge directory is held in memory.
  const list = async (dir: string): Promise<Dirent[]> => {
    const cannot = () => new BatchSpecError(`cannot list ${toPosix(relative(input.root, dir)) || '.'}`)
    const found: Dirent[] = []
    const handle = await opendir(dir).catch(() => {
      throw cannot()
    })
    try {
      for await (const entry of handle) {
        if (++entries > maxEntries) throw new BatchSpecError(`dir holds more than ${maxEntries} entries`)
        found.push(entry)
      }
    } catch (error) {
      throw error instanceof BatchSpecError ? error : cannot()
    }
    return found.sort(byName)
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new BatchSpecError(`dir nests folders deeper than ${MAX_DEPTH} levels`)
    for (const entry of await list(dir)) {
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (inside(input.outAbs, abs)) continue
      if (entry.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const ext = extname(entry.name).slice(1).toLowerCase()
      if (allow && !allow.has(ext)) continue
      const path = toPosix(relative(input.root, abs))
      if (entry.isSymbolicLink()) {
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
  return items
}

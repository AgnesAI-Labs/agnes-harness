import type { ToolContext } from '@agnes/extension-api'
import { within } from '../deadline.js'

export type FindFs = Pick<ToolContext['fs'], 'list' | 'stat' | 'read' | 'revision'>
export type FindCandidate = { path: string; lexicalScore: number }
export type FindScan = {
  candidates: FindCandidate[]
  entriesVisited: number
  failures: number
  partial: boolean
  reasons: string[]
}
const ENTRY_LIMIT = 10000
const CANDIDATE_LIMIT = 128
const READ_LIMIT = 1024 * 1024
const OMIT_DIR = new Set([
  '.agh',
  '.git',
  '.hg',
  '.svn',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
])
const OMIT_FILE =
  /(?:^\.env(?:\.|$)|^(?:\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|authorized_keys|known_hosts)$|(?:^|[-_.])(?:credentials|secrets?)(?:[-_.]|$)|\.(?:pem|key|p12|pfx|keystore|jks)$|(?:^|[.-])lock(?:\.|$)|^(?:go\.sum|yarn\.lock|Cargo\.lock|Gemfile\.lock)$)/i
const BINARY =
  /\.(?:png|jpe?g|gif|webp|ico|avif|pdf|zip|gz|br|tar|7z|rar|woff2?|ttf|eot|mp[34]|wav|ogg|mov|avi|exe|dll|so|dylib|a|o|class|pyc|wasm|sqlite3?|db|bin|pack)$/i
function hasControl(text: string, whitespace = false): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 127 || (code < 32 && !(whitespace && [9, 10, 13].includes(code)))) return true
  }
  return false
}
const safeName = (name: string) =>
  !!name && name !== '.' && name !== '..' && !/[\\/:]/.test(name) && !hasControl(name) && !/[. ]$/.test(name)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const findTerms = (query: string): string[] =>
  [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 64)

/** Canonical spelling only; the authorized filesystem remains the authority for resolution. */
export function findRoot(path: string): string | null {
  if (!path || path.length > 2048 || hasControl(path)) return null
  const normal = path.replaceAll('\\', '/')
  const drive = /^[A-Za-z]:\//.test(normal) ? normal.slice(0, 3) : normal.startsWith('/') ? '/' : null
  if (!drive || normal.startsWith('//')) return null
  const parts = normal.slice(drive.length).split('/').filter(Boolean)
  if (parts.some((part) => !safeName(part) || OMIT_DIR.has(part.toLowerCase()) || OMIT_FILE.test(part)))
    return null
  return drive + parts.join('/')
}
function permittedFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return !OMIT_FILE.test(name) && !BINARY.test(name)
}
function order(a: FindCandidate, b: FindCandidate): number {
  return b.lexicalScore - a.lexicalScore || compare(a.path, b.path)
}
async function operation<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return within(run(), signal)
}

/** Bounds consumed entries/enqueued directories; list() itself is the existing unpaged Host port. */
export async function scanFindCandidates(
  fs: FindFs,
  requestedRoot: string,
  query: string,
  signal: AbortSignal,
): Promise<FindScan> {
  const result: FindScan = { candidates: [], entriesVisited: 0, failures: 0, partial: false, reasons: [] }
  const reason = (value: string) => {
    result.partial = true
    if (!result.reasons.includes(value)) result.reasons.push(value)
  }
  const root = findRoot(requestedRoot)
  if (!root) {
    reason('unsafe_root')
    return result
  }
  const terms = findTerms(query)
  const candidate = (path: string) => {
    if (!permittedFile(path)) return
    const lower = path.toLowerCase()
    result.candidates.push({ path, lexicalScore: terms.filter((term) => lower.includes(term)).length })
    result.candidates.sort(order)
    if (result.candidates.length > CANDIDATE_LIMIT) {
      result.candidates.pop()
      reason('candidate_limit')
    }
  }
  try {
    const stat = await operation(signal, () => fs.stat(root))
    if (stat.kind === 'file') {
      candidate(root)
      return result
    }
    if (stat.kind !== 'dir') {
      reason('unsafe_root')
      return result
    }
    const queue = [root]
    let scheduled = 0
    while (queue.length) {
      const directory = queue.shift()
      if (directory === undefined) break
      try {
        // Recheck listed kinds before traversal, including a directory changed to a link.
        if ((await operation(signal, () => fs.stat(directory))).kind !== 'dir') {
          reason('changed')
          continue
        }
        const entries = await operation(signal, () => fs.list(directory))
        const remaining = ENTRY_LIMIT - scheduled
        const bounded = entries.slice(0, remaining)
        scheduled += bounded.length
        if (entries.length > remaining) reason('entry_limit')
        bounded.sort((a, b) => compare(a.name, b.name))
        for (const entry of bounded) {
          signal.throwIfAborted()
          result.entriesVisited++
          if (!safeName(entry.name) || OMIT_DIR.has(entry.name.toLowerCase()) || OMIT_FILE.test(entry.name))
            continue
          const path = `${directory.replace(/\/$/, '')}/${entry.name}`
          if (path.length > 2048) {
            reason('path_limit')
            continue
          }
          if (entry.kind === 'dir') queue.push(path)
          else if (entry.kind === 'file') candidate(path)
        }
      } catch {
        if (signal.aborted) throw signal.reason
        result.failures++
        reason('unreadable_directory')
      }
    }
  } catch {
    if (signal.aborted) reason('cancelled')
    else {
      result.failures++
      reason('unreadable_root')
    }
  }
  return result
}

export type FindRead =
  | { status: 'ok'; text: string; truncated: boolean }
  | { status: 'skipped' | 'failed'; reason: string }
/** Revalidate names and metadata; discard detected replacements rather than send unstable bytes. */
export async function readFindCandidate(
  fs: FindFs,
  requestedRoot: string,
  requestedPath: string,
  signal: AbortSignal,
): Promise<FindRead> {
  const root = findRoot(requestedRoot)
  const path = findRoot(requestedPath)
  if (
    !root ||
    !path ||
    (path !== root && !path.startsWith(`${root.replace(/\/$/, '')}/`)) ||
    !permittedFile(path)
  )
    return { status: 'skipped', reason: 'unsafe_path' }
  try {
    const before = await operation(signal, () => fs.stat(path))
    if (before.kind !== 'file') return { status: 'skipped', reason: 'not_file' }
    const readRevision = fs.revision?.bind(fs)
    const revision = readRevision ? await operation(signal, () => readRevision(path)) : undefined
    const bytes = await operation(signal, () => fs.read(path, { offset: 0, limit: READ_LIMIT }))
    if (bytes.length > READ_LIMIT) return { status: 'failed', reason: 'read_limit' }
    const after = await operation(signal, () => fs.stat(path))
    const nextRevision = readRevision ? await operation(signal, () => readRevision(path)) : undefined
    if (
      after.kind !== 'file' ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      revision !== nextRevision
    )
      return { status: 'failed', reason: 'changed' }
    const truncated = before.size > bytes.length
    // Streaming accepts only an incomplete final code point caused by the bounded prefix.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
    if (hasControl(text, true)) return { status: 'skipped', reason: 'binary' }
    return { status: 'ok', text, truncated }
  } catch {
    return { status: 'failed', reason: signal.aborted ? 'cancelled' : 'unreadable_or_binary' }
  }
}

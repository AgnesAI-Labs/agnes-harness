import { spawn } from 'node:child_process'
import { ripgrepPath } from '@agnes/base'
import type { HostSession } from '@agnes/host'
import { fileReferenceBrowse, type ReferenceSelection, rpcError } from '@agnes/protocol'
import {
  authorizeWorkspaceReferenceCandidates,
  listWorkspace,
  normalizeWorkspacePath,
  readWorkspaceReference,
} from './workspace-files.js'

const MAX_CANDIDATE_BYTES = 32 * 1024 * 1024

/** Ripgrep only lists names. It never decides whether a reference may be shown or read. */
async function referenceFileNames(cwd: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const binary = ripgrepPath()
  return new Promise<{ paths: string[]; truncated: boolean }>((resolve, reject) => {
    // Keep ripgrep's ignore handling enabled: keyword completion must not enumerate dependency
    // trees or other workspace-excluded paths before the authoritative AGH checks below.
    const child = spawn(binary, ['--files', '--hidden', '--null', '--', '.'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let stderr = ''
    const abort = () => child.kill()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      size += chunk.length
      if (size > MAX_CANDIDATE_BYTES) {
        truncated = true
        child.kill()
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(0, 2048)
    })
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) return reject(signal.reason)
      if (!truncated && (code === null || code > 1 || stderr)) {
        if (size === 0) return reject(new Error(`Reference file enumeration failed: ${stderr || code}`))
        truncated = true
      }
      const paths: string[] = []
      const listing = Buffer.concat(chunks).toString('utf8')
      const complete = listing.endsWith('\0') ? listing : listing.slice(0, listing.lastIndexOf('\0') + 1)
      for (const name of complete.split('\0')) {
        if (!name) continue
        try {
          const path = normalizeWorkspacePath(name)
          if (path) paths.push(path)
        } catch {
          truncated = true
        }
      }
      resolve({ paths, truncated })
    })
  })
}

/** Rank one bounded name enumeration; only currently authorized paths become candidates. */
export async function searchReferenceFiles(
  cwd: string,
  authority: Parameters<typeof listWorkspace>[2],
  query: string,
  signal: AbortSignal,
) {
  const browse = fileReferenceBrowse(query)
  if (browse) {
    signal.throwIfAborted()
    const page = await listWorkspace(cwd, browse.path, authority, false, true)
    signal.throwIfAborted()
    const files = page.entries.filter(
      (entry) => entry.kind === 'file' && entry.name.toLowerCase().includes(browse.filter.toLowerCase()),
    )
    return {
      items: files.slice(0, 20).map((entry) => {
        const id = browse.path ? `${browse.path}/${entry.name}` : entry.name
        return { source: 'file', id, label: id }
      }),
      truncated: page.truncated || files.length > 20,
    }
  }
  // A path rejected by the browser grammar must never trigger global keyword search.
  if (query.includes('/') || query.includes('\\') || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(query))
    return { items: [], truncated: false }
  const names = await referenceFileNames(cwd, signal)
  const ranked = [...new Set(names.paths)]
    .map((id) => ({ id, rank: fuzzyRank(id, query) }))
    .filter((item): item is { id: string; rank: number } => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
  const authorized = await authorizeWorkspaceReferenceCandidates(
    cwd,
    authority,
    signal,
    ranked.map((item) => item.id),
    21,
  )
  return {
    items: authorized.paths.slice(0, 20).map((id) => ({ source: 'file', id, label: id })),
    truncated: names.truncated || authorized.truncated || authorized.paths.length > 20,
  }
}

export function fuzzyRank(path: string, query: string): number | undefined {
  const name = path.toLowerCase()
  const wanted = query.toLowerCase().trim()
  let at = -1
  let score = name.length
  for (const char of wanted) {
    const next = name.indexOf(char, at + 1)
    if (next < 0) return undefined
    score += next - at - 1
    at = next
  }
  if (name.includes(wanted)) score -= 1000
  return score
}

/** Worker command cancellation is scoped to this request id, never to the session run. */
export async function commandReferences(
  session: HostSession,
  operation: unknown,
  input: unknown,
  runId: unknown,
  aborts: Map<string, AbortController>,
) {
  if (operation !== 'search' && operation !== 'resolve') throw new Error('Invalid reference operation')
  if (runId === undefined) return sessionReferences(session, operation, input as never)
  const id = String(runId)
  if (!id.startsWith('reference:') || aborts.has(id)) throw new Error('Invalid reference id')
  const controller = new AbortController()
  aborts.set(id, controller)
  try {
    return await sessionReferences(session, operation, input as never, controller.signal)
  } finally {
    if (aborts.get(id) === controller) aborts.delete(id)
  }
}

export async function sessionReferences(
  session: HostSession,
  operation: 'search' | 'resolve',
  input: string | readonly ReferenceSelection[],
  signal: AbortSignal = AbortSignal.timeout(10000),
) {
  const port = session.d.workspaceInvocation
  const resolver = session.referenceResolvers
  const sessions = session.referenceSessions
  const limits = session.referenceLimits
  if (!port || !resolver || !sessions || !limits)
    throw rpcError('CAPABILITY_DENIED', { reason: 'Reference resolver unavailable.' })
  const invoke = async (view: Parameters<Parameters<typeof port.run>[0]>[0]) => {
    const context = {
      reader: { principalId: session.d.actor.id, sessionId: session.key, workspaceRoot: view.root },
      signal,
      limits,
      sessions,
      files: {
        search: (query: string) => searchReferenceFiles(view.root, view.fs(), query, signal),
        read: (path: string) => readWorkspaceReference(view.root, path, view.fs(), limits.maxSourceBytes),
      },
    }
    return operation === 'search'
      ? resolver.search(input as string, context)
      : resolver.resolve(input as readonly ReferenceSelection[], context)
  }
  return session.d.workspacePublication
    ? session.d.workspacePublication.workspace(() => ({ port, handler: invoke }))
    : port.run(invoke)
}

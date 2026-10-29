import type { HostSession } from '@agnes/host'
import { type ReferenceSelection, rpcError } from '@agnes/protocol'
import { listWorkspace, readWorkspaceReference } from './workspace-files.js'

/** Bound and rank traversal work so typing cannot enqueue an unbounded workspace walk. */
export async function searchReferenceFiles(
  cwd: string,
  authority: Parameters<typeof listWorkspace>[2],
  query: string,
  signal: AbortSignal,
) {
  const pending = ['']
  const matches: Array<{ source: string; id: string; label: string; rank: number }> = []
  let walked = 0
  let entries = 0
  let truncated = false
  while (pending.length && walked < 2000 && entries < 50000) {
    signal.throwIfAborted()
    const path = pending.shift() ?? ''
    let page: Awaited<ReturnType<typeof listWorkspace>>
    try {
      page = await listWorkspace(cwd, path, authority, false, true)
    } catch (error) {
      signal.throwIfAborted()
      if (path === '') throw error
      truncated = true
      walked++
      continue
    }
    walked++
    truncated ||= page.truncated
    for (const entry of page.entries) {
      if (++entries > 50000) {
        truncated = true
        break
      }
      const id = path ? `${path}/${entry.name}` : entry.name
      if (entry.kind === 'directory') {
        if (pending.length < 5000) pending.push(id)
        else truncated = true
      }
      if (entry.kind !== 'file') continue
      const rank = fuzzyRank(id, query)
      if (rank !== undefined) matches.push({ source: 'file', id, label: id, rank })
    }
  }
  matches.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
  return {
    items: matches.slice(0, 20).map(({ rank: _rank, ...item }) => item),
    truncated: truncated || pending.length > 0 || matches.length > 20,
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

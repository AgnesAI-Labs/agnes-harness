import { CoreError } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { SessionImpl } from '../../step/session.js'

const EVENT = 'x/core/tool-disclosed'
const loaded = new WeakMap<SessionImpl, Set<string>>()

export function loadedToolNames(s: SessionImpl): ReadonlySet<string> {
  return loaded.get(s) ?? new Set<string>()
}

/** Durable discovery survives compaction and reopen; current catalog membership still governs use. */
export async function restoreToolDisclosure(s: SessionImpl): Promise<void> {
  const names = new Set<string>()
  for (const row of await scanAll((query) => s.d.log.scan(query), {
    type: EVENT,
    lane: s.lane,
    toSeq: s.lastSeq,
  })) {
    if (row.origin !== 'system' || row.trust !== 'trusted') continue
    const name = (row.data as { name?: unknown }).name
    if (typeof name === 'string') names.add(name)
  }
  loaded.set(s, names)
}

/** Disclosure is only a schema selection. Execution still uses normal validation and policy. */
export async function discloseTool(s: SessionImpl, name: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const def = s.turn?.snapshot.byName.get(name)
  if (!def || (name === 'computer_use' && !s.computerUseAllowed()))
    throw new CoreError('E_ENVELOPE', 'Cannot disclose a tool outside the available turn catalog')
  if (def.meta.deferLoading !== true || loadedToolNames(s).has(name)) return
  await s.d.log.append([s.ev(EVENT, { name }, { ignorable: true })])
  const names = new Set(loadedToolNames(s))
  names.add(name)
  loaded.set(s, names)
}

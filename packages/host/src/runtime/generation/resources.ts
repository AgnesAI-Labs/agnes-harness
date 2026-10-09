import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  RuntimeGenerationResourceInput,
  RuntimeGenerationResourceSnapshot,
} from '@agnes/package-manager'
import type { JsonValue } from '@agnes/protocol'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import type { Host, HostOptions } from '../lifecycle/host.js'

type PreparedRow = Parameters<Host['extensionRows']['prepare']>[0]
type ResourceData = {
  version: 1
  scoped: boolean
  rows: {
    extensionId: string
    entryRevision?: string
    generation?: NonNullable<NonNullable<PreparedRow['dynamic']>['generation']>
  }[]
  extensionRowIds?: string[]
}

export function captureGenerationResources(
  skills: SkillRuntimeInput | undefined,
  rows: Iterable<PreparedRow>,
  extensionRowIds?: readonly string[],
): RuntimeGenerationResourceInput {
  const data: ResourceData = {
    version: 1,
    scoped: !!skills?.scopeWorkspace,
    ...(extensionRowIds ? { extensionRowIds: [...extensionRowIds] } : {}),
    rows: [...rows]
      .filter((row) => row.dynamic && row.dynamic.generation?.kind !== 'mcp-server')
      .map((row) => ({
        extensionId: row.extensionId,
        ...(row.entryRevision ? { entryRevision: row.entryRevision } : {}),
        ...(row.dynamic?.generation ? { generation: row.dynamic.generation } : {}),
      })),
  }
  return { data: data as unknown as JsonValue, directories: [] }
}

function resourceData(snapshot: RuntimeGenerationResourceSnapshot): ResourceData {
  const data = snapshot.data as unknown as ResourceData
  if (data?.version !== 1 || !Array.isArray(data.rows) || typeof data.scoped !== 'boolean')
    throw new Error('E_GENERATION_RESOURCE_INTEGRITY: invalid private resource metadata')
  if (
    data.extensionRowIds !== undefined &&
    (!Array.isArray(data.extensionRowIds) ||
      data.extensionRowIds.some((id) => typeof id !== 'string' || !id.startsWith('ext:')))
  )
    throw new Error('E_GENERATION_RESOURCE_INTEGRITY: invalid extension row selection')
  return data
}

/** Code generations consume current resources; workspace authorization is scoped to each turn. */
export function createGenerationSkills(original: SkillRuntimeInput | undefined) {
  const calls = new AsyncLocalStorage<{ key: string; active: boolean }>()
  const current = (key?: string) => {
    const call = calls.getStore()
    if (call && (!call.active || (key !== undefined && key !== call.key))) return undefined
    if (!call && original?.scopeWorkspace && key !== undefined) return undefined
    return original
  }
  const input: SkillRuntimeInput = {
    list: () => current()?.list() ?? [],
    invocation: (id) => current()?.invocation?.(id),
    read: (id, session) =>
      current(session.sessionKey)?.read(id, session) ?? { ok: false, code: 'UNAUTHORIZED' },
    readFile: (id, revision, path, session) =>
      current(session.sessionKey)?.readFile(id, revision, path, session) ?? {
        ok: false,
        code: 'UNAUTHORIZED',
      },
    readRoots: () => {
      const view = current()
      let snapshot: ReturnType<NonNullable<SkillRuntimeInput['generationSnapshot']>> | undefined
      try {
        snapshot = view?.generationSnapshot?.()
      } catch {
        // Custom live inputs may expose reads without a serializable resource view.
      }
      return snapshot
        ? snapshot.entries
            .filter(
              (entry) =>
                entry.actual.actual === 'ready' &&
                entry.directory &&
                (calls.getStore()?.active || entry.actual.sourceIdentity.scope === 'user'),
            )
            .map((entry) => entry.directory as string)
        : (view?.readRoots?.() ?? [])
    },
    async scopeWorkspace(root, key, invoke) {
      const call = { key, active: true }
      const run = () => calls.run(call, invoke)
      try {
        return await (original?.scopeWorkspace ? original.scopeWorkspace(root, key, run) : run())
      } finally {
        call.active = false
      }
    },
  }
  return { input }
}

export async function restoreGenerationRows(
  snapshot: RuntimeGenerationResourceSnapshot,
  options: HostOptions,
  live?: ReadonlyMap<string, PreparedRow>,
): Promise<readonly PreparedRow[]> {
  const rows: PreparedRow[] = []
  for (const row of resourceData(snapshot).rows) {
    if (row.generation?.kind === 'mcp-server') continue
    const current = live?.get(row.extensionId)
    if (current?.dynamic) {
      rows.push(current)
      continue
    }
    if (!row.generation || !options.restoreGenerationExtension)
      throw new Error(`E_GENERATION_FACTORY_UNAVAILABLE: ${row.extensionId} has no durable factory restorer`)
    const dynamic = await options.restoreGenerationExtension(row.generation)
    if (dynamic.spec.id !== row.extensionId)
      throw new Error('E_GENERATION_FACTORY_INCOMPATIBLE: restored extension id changed')
    rows.push({
      extensionId: row.extensionId,
      ...(row.entryRevision ? { entryRevision: row.entryRevision } : {}),
      dynamic,
    })
  }
  return rows
}

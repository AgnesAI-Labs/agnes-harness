import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  RuntimeGenerationResourceInput,
  RuntimeGenerationResourceSnapshot,
  RuntimeGenerationSnapshotStore,
} from '@agnes/package-manager'
import type { JsonValue } from '@agnes/protocol'
import {
  restoreSkillGeneration,
  type SkillGenerationSnapshot,
  type SkillRuntimeInput,
} from '@agnes/resource-control-runtime'
import type { Host, HostOptions } from './host.js'

type PreparedRow = Parameters<Host['extensionRows']['prepare']>[0]
type ResourceData = {
  version: 1
  skills?: SkillGenerationSnapshot
  scoped: boolean
  unavailable?: string
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
  const directories: string[] = []
  let view: SkillGenerationSnapshot | undefined, unavailable: string | undefined
  if (skills) {
    try {
      if (!skills.generationSnapshot) throw new Error('custom Skills input provides no generationSnapshot()')
      view = skills.generationSnapshot()
      view = {
        ...view,
        entries: view.entries.map((entry) => {
          if (!entry.directory) return entry
          let index = directories.indexOf(entry.directory)
          if (index === -1) index = directories.push(entry.directory) - 1
          return { ...entry, directory: String(index) }
        }),
      }
    } catch (error) {
      unavailable = `E_GENERATION_SKILLS_UNRESTORABLE: ${String(error)}`
    }
  }
  const data: ResourceData = {
    version: 1,
    scoped: !!skills?.scopeWorkspace,
    ...(view ? { skills: view } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(extensionRowIds ? { extensionRowIds: [...extensionRowIds] } : {}),
    rows: [...rows]
      .filter((row) => row.dynamic)
      .map((row) => ({
        extensionId: row.extensionId,
        ...(row.entryRevision ? { entryRevision: row.entryRevision } : {}),
        ...(row.dynamic?.generation ? { generation: row.dynamic.generation } : {}),
      })),
  }
  return { data: data as unknown as JsonValue, directories }
}

function resourceData(snapshot: RuntimeGenerationResourceSnapshot): ResourceData {
  const data = snapshot.data as unknown as ResourceData
  if (!data || data.version !== 1 || !Array.isArray(data.rows) || typeof data.scoped !== 'boolean')
    throw new Error('E_GENERATION_RESOURCE_INTEGRITY: invalid private resource metadata')
  if (
    data.extensionRowIds !== undefined &&
    (!Array.isArray(data.extensionRowIds) ||
      data.extensionRowIds.some((id) => typeof id !== 'string' || !id.startsWith('ext:')))
  )
    throw new Error('E_GENERATION_RESOURCE_INTEGRITY: invalid extension row selection')
  return data
}

function restoreSkills(snapshot: RuntimeGenerationResourceSnapshot): SkillRuntimeInput | undefined {
  const data = resourceData(snapshot)
  if (data.unavailable) throw new Error(data.unavailable)
  if (!data.skills) return undefined
  return restoreSkillGeneration({
    ...data.skills,
    entries: data.skills.entries.map((entry) => {
      if (!entry.directory) return entry
      const directory = snapshot.directories[Number(entry.directory)]
      if (!directory || String(Number(entry.directory)) !== entry.directory)
        throw new Error('E_GENERATION_SKILLS_DIRECTORY_MISSING: pinned Skill directory is missing')
      return { ...entry, directory }
    }),
  })
}

/** This wrapper is fitted before assembly and sealed to the copied view before any session opens. */
export function createGenerationSkills(
  original: SkillRuntimeInput | undefined,
  store: RuntimeGenerationSnapshotStore,
) {
  let shared = original
  let scoped = !!original?.scopeWorkspace
  let fallback = false
  const views = new Map<string, SkillRuntimeInput>()
  const calls = new AsyncLocalStorage<{ key: string; view: SkillRuntimeInput; active: boolean }>()
  const current = (key?: string) => {
    const call = calls.getStore()
    if (call) return call.active && (key === undefined || key === call.key) ? call.view : undefined
    return !fallback && scoped && key !== undefined ? undefined : shared
  }
  const bind = async (key: string, root: string, existing: boolean) => {
    const saved = store.sessionResources(key)
    if (saved) {
      const view = restoreSkills(saved)
      if (view) views.set(key, view)
      return
    }
    if (!scoped || !original) return
    if (fallback) return
    if (existing)
      throw new Error('E_GENERATION_SKILLS_WORKSPACE_MISSING: session has no pinned workspace Skills view')
    const capture = () => Promise.resolve(captureGenerationResources(original, []))
    const input = original.scopeWorkspace
      ? await original.scopeWorkspace(root, key, capture)
      : await capture()
    const view = restoreSkills(store.pinSessionResources(key, input))
    if (view) views.set(key, view)
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
      const call = calls.getStore()
      const active = !!call?.active
      return [
        ...new Set(
          (active ? [call.view] : [shared]).flatMap((view) => {
            let data: SkillGenerationSnapshot | undefined
            try {
              data = view?.generationSnapshot?.()
            } catch {
              /* A live custom view is not serializable. */
            }
            return data
              ? data.entries
                  .filter(
                    (entry) =>
                      entry.actual.actual === 'ready' &&
                      entry.directory &&
                      (active || entry.actual.sourceIdentity.scope === 'user'),
                  )
                  .map((entry) => entry.directory as string)
              : (view?.readRoots?.() ?? [])
          }),
        ),
      ]
    },
    async scopeWorkspace(root, key, invoke) {
      if (fallback && original?.scopeWorkspace) return original.scopeWorkspace(root, key, invoke)
      if (!views.has(key) && scoped) await bind(key, root, !!store.session(key)?.resourcesDigest)
      const view = views.get(key) ?? shared
      if (!view) return invoke()
      const call = { key, view, active: true }
      try {
        return await calls.run(call, invoke)
      } finally {
        call.active = false
      }
    },
  }
  return {
    input,
    bind,
    seal(snapshot: RuntimeGenerationResourceSnapshot, allowLiveFallback: boolean) {
      const data = resourceData(snapshot)
      scoped = data.scoped
      if (data.unavailable && allowLiveFallback) {
        fallback = true
        return
      }
      shared = restoreSkills(snapshot)
    },
  }
}

export async function restoreGenerationRows(
  snapshot: RuntimeGenerationResourceSnapshot,
  options: HostOptions,
  live?: ReadonlyMap<string, PreparedRow>,
): Promise<readonly PreparedRow[]> {
  const rows: PreparedRow[] = []
  for (const row of resourceData(snapshot).rows) {
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

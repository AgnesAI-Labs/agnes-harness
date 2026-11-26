import {
  type ChildControlStore,
  type ChildTaskRecord,
  childBackend,
  createSessionFileReader,
  externalChild,
  externalChildren,
  platformView,
  projectChildStatus,
  type SeamImplementations,
} from '@agnes/core'
import type { ChildAgentListing, Logger, ServiceContext, SessionChildJobs } from '@agnes/extension-api'
import { createNetFetch } from '@agnes/host-infrastructure/adapters/net'
import { type Decision, inspectJsonData, validateAgainst } from '@agnes/protocol'
import { Action, Decision as DecisionSchema, Target } from '@agnes/protocol/gen/authz'
import { frozenJson } from './frozen-json.js'
import type { ServiceInvocationDeps } from './service-invocation.js'

const MAX_DESCENDANT_LIST = 128

type ChildJobListing = ChildAgentListing &
  Readonly<{
    ownerSessionId?: string
    direct?: boolean
    readOnly?: boolean
    ambiguous?: boolean
    source?: 'local' | 'external'
  }>

type ChildCancelTarget = Readonly<{
  providerId?: string
  ownerSessionId?: string
}>

type SessionChildJobsPort = SessionChildJobs &
  Readonly<{
    list(): Promise<readonly ChildJobListing[]>
    readDetail(id: string): Promise<ChildJobListing | undefined>
    readDirect(id: string): Promise<ChildJobListing | undefined>
    cancel?(id: string, target?: ChildCancelTarget): Promise<void>
  }>

function cleanChildLabel(inputText: string): string {
  const firstLine = inputText.trim().split(/\r?\n/, 1)[0] ?? ''
  const cleaned = firstLine
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned
}

function ownsDirectRecord(record: ChildTaskRecord, ownerKey: string): boolean {
  return record.parentKey === ownerKey || record.runtimeOwnerSessionKey === ownerKey
}

function listingFromRecord(record: ChildTaskRecord): ChildAgentListing {
  const projected = projectChildStatus(record)
  const label = cleanChildLabel(record.inputText)
  return {
    id: record.childKey,
    providerId: 'in-process',
    status: projected.status,
    executionState: projected.executionState,
    continuable: record.state === 'idle' || record.state === 'interrupted' || record.state === 'paused',
    ...(label ? { label } : {}),
  }
}

function omitText(row: ChildAgentListing): ChildAgentListing {
  if (row.text === undefined) return row
  const { text: _omitted, ...light } = row
  return light
}

async function lightweightLocalChildren(
  parentKey: string,
  rootStore?: ChildControlStore,
): Promise<readonly ChildAgentListing[]> {
  const backend = childBackend(parentKey)
  const store = backend?.childEvents?.store ?? rootStore
  if (store) return (await store.listByParent(parentKey)).map(listingFromRecord)
  if (!backend) return []
  return (await backend.list()).map(omitText)
}

async function findDirectLocalChild(rootKey: string, id: string): Promise<ChildAgentListing | undefined> {
  const backend = childBackend(rootKey)
  if (!backend) return undefined
  const store = backend.childEvents?.store
  if (store) {
    const record = await store.lookupByKey(id)
    if (!record || !ownsDirectRecord(record, rootKey)) return undefined
    return listingFromRecord(record)
  }
  return (await backend.list()).find((row) => row.id === id)
}

async function readLocalText(parentKey: string, id: string, fallback?: string): Promise<string | undefined> {
  const backend = childBackend(parentKey)
  if (backend && typeof backend.inspect === 'function') {
    const inspected = await backend.inspect(id)
    if (inspected?.text !== undefined) return inspected.text
  }
  return fallback
}

async function isOwnedDescendant(
  store: ChildControlStore,
  rootKey: string,
  record: ChildTaskRecord,
): Promise<boolean> {
  const seen = new Set<string>([record.childKey])
  let current: ChildTaskRecord | null | undefined = record
  while (current) {
    if (ownsDirectRecord(current, rootKey)) return true
    if (seen.has(current.parentKey)) return false
    seen.add(current.parentKey)
    current = await store.lookupByKey(current.parentKey)
  }
  return false
}

async function readDirectChild(rootKey: string, id: string): Promise<ChildJobListing | undefined> {
  const external = externalChild(rootKey, id)
  const local = await findDirectLocalChild(rootKey, id)
  if (external && local)
    return {
      ...omitText(local),
      ownerSessionId: rootKey,
      direct: false,
      readOnly: true,
      ambiguous: true,
      source: 'local',
    }
  if (local)
    return {
      ...omitText(local),
      ownerSessionId: rootKey,
      direct: true,
      readOnly: false,
      ambiguous: false,
      source: 'local',
    }
  if (external)
    return {
      ...omitText(external.listing),
      ownerSessionId: rootKey,
      direct: true,
      readOnly: false,
      ambiguous: false,
      source: 'external',
    }
  return undefined
}

async function readChildDetail(rootKey: string, id: string): Promise<ChildJobListing | undefined> {
  const external = externalChild(rootKey, id)
  const local = await findDirectLocalChild(rootKey, id)
  if (local) {
    const ambiguous = Boolean(external)
    const text = await readLocalText(rootKey, id, local.text)
    return {
      ...local,
      ...(text !== undefined ? { text } : {}),
      ownerSessionId: rootKey,
      direct: !ambiguous,
      readOnly: ambiguous,
      ambiguous,
      source: 'local',
    }
  }
  if (external)
    return {
      ...external.listing,
      ownerSessionId: rootKey,
      direct: true,
      readOnly: false,
      ambiguous: false,
      source: 'external',
    }
  const rootStore = childBackend(rootKey)?.childEvents?.store
  if (rootStore) {
    const record = await rootStore.lookupByKey(id)
    if (record && (await isOwnedDescendant(rootStore, rootKey, record))) {
      const base = listingFromRecord(record)
      const text = await readLocalText(record.parentKey, id)
      return {
        ...base,
        ...(text !== undefined ? { text } : {}),
        ownerSessionId: record.parentKey,
        direct: false,
        readOnly: true,
        ambiguous: false,
        source: 'local',
      }
    }
  }
  // Fallback for external grandchildren or stub backends without a ChildControlStore.
  const seen = new Set<string>([rootKey])
  const queue: string[] = [rootKey]
  while (queue.length) {
    const parentKey = queue.shift()!
    if (parentKey !== rootKey) {
      const ext = externalChild(parentKey, id)
      if (ext)
        return {
          ...ext.listing,
          ownerSessionId: parentKey,
          direct: false,
          readOnly: true,
          ambiguous: false,
          source: 'external',
        }
    }
    const backend = childBackend(parentKey)
    const localRows =
      parentKey !== rootKey && backend && !backend.childEvents?.store
        ? await backend.list()
        : await lightweightLocalChildren(parentKey, rootStore)
    for (const row of localRows) {
      if (parentKey !== rootKey && row.id === id) {
        const text = await readLocalText(parentKey, id, row.text)
        return {
          ...row,
          ...(text !== undefined ? { text } : {}),
          ownerSessionId: parentKey,
          direct: false,
          readOnly: true,
          ambiguous: false,
          source: 'local',
        }
      }
      if (seen.has(row.id)) continue
      seen.add(row.id)
      queue.push(row.id)
    }
  }
  return undefined
}

async function listChildTree(rootKey: string): Promise<readonly ChildJobListing[]> {
  const rootStore = childBackend(rootKey)?.childEvents?.store
  const seen = new Set<string>([rootKey])
  const queue: string[] = [rootKey]
  const rows: ChildJobListing[] = []
  let descendants = 0
  while (queue.length) {
    const parentKey = queue.shift()!
    const isDirectParent = parentKey === rootKey
    if (!isDirectParent && descendants >= MAX_DESCENDANT_LIST) break
    const local = await lightweightLocalChildren(parentKey, rootStore)
    const externals = externalChildren(parentKey)
    const localIds = new Set(local.map((row) => row.id))
    const externalIds = new Set(externals.map((ext) => ext.listing.id))
    for (const row of local) {
      if (seen.has(row.id)) continue
      if (!isDirectParent && descendants >= MAX_DESCENDANT_LIST) break
      seen.add(row.id)
      const ambiguous = externalIds.has(row.id)
      const direct = isDirectParent && !ambiguous
      rows.push({
        ...omitText(row),
        ownerSessionId: parentKey,
        direct,
        readOnly: !direct,
        ambiguous,
        source: 'local',
      })
      if (!isDirectParent) descendants++
      queue.push(row.id)
    }
    for (const ext of externals) {
      if (seen.has(ext.listing.id)) continue
      if (!isDirectParent && descendants >= MAX_DESCENDANT_LIST) break
      seen.add(ext.listing.id)
      const ambiguous = localIds.has(ext.listing.id)
      const direct = isDirectParent && !ambiguous
      rows.push({
        ...omitText(ext.listing),
        ownerSessionId: parentKey,
        direct,
        readOnly: !direct,
        ambiguous,
        source: 'external',
      })
      if (!isDirectParent) descendants++
    }
  }
  return rows
}

async function cancelDirectChild(rootKey: string, id: string, target?: ChildCancelTarget): Promise<void> {
  if (target?.ownerSessionId !== undefined && target.ownerSessionId !== rootKey)
    throw new Error('CAPABILITY_DENIED: child cancellation is restricted to direct children of this session')
  const external = externalChild(rootKey, id)
  const local = await findDirectLocalChild(rootKey, id)
  if (external && local)
    throw new Error(
      `CAPABILITY_DENIED: ambiguous child id "${id}" exists in both local and external registries`,
    )
  if (!external && !local)
    throw new Error(`CAPABILITY_DENIED: child "${id}" is not a direct child of session "${rootKey}"`)
  if (external) {
    if (external.listing.id !== id) throw new Error('CAPABILITY_DENIED: child identity mismatch')
    if (target?.providerId !== undefined && external.listing.providerId !== target.providerId)
      throw new Error('CAPABILITY_DENIED: child provider mismatch')
    if (!external.cancel) throw new Error('child cancellation is unavailable')
    await external.cancel()
    return
  }
  const backend = childBackend(rootKey)
  if (!backend) throw new Error('child backend is unavailable')
  if (local!.id !== id) throw new Error('CAPABILITY_DENIED: child identity mismatch')
  if (target?.providerId !== undefined && local!.providerId !== target.providerId)
    throw new Error('CAPABILITY_DENIED: child provider mismatch')
  await backend.cancel(id)
}

function createChildJobsPort(rootKey: string, isEffect: boolean, alive: () => void): SessionChildJobsPort {
  return Object.freeze({
    list: async () => {
      alive()
      return listChildTree(rootKey)
    },
    readDetail: async (id: string) => {
      alive()
      return readChildDetail(rootKey, id)
    },
    readDirect: async (id: string) => {
      alive()
      return readDirectChild(rootKey, id)
    },
    ...(isEffect
      ? {
          cancel: async (id: string, target?: ChildCancelTarget) => {
            alive()
            return cancelDirectChild(rootKey, id, target)
          },
        }
      : {}),
  })
}

/** Queries cannot open a side-effect path around the deferred durable effect executor. */
export function serviceContext(deps: {
  seams: SeamImplementations
  networkAllow: readonly string[]
  log: Logger
  workspaceInvocationFor?: (sessionKey: string) => import('@agnes/core').WorkspaceInvocationPort
  authorizeProcess?: (
    identity: Pick<ServiceContext, 'actor' | 'session' | 'requestId' | 'signal'>,
    cwd: string,
  ) => Promise<void>
}): ServiceInvocationDeps['context'] {
  return (entry, identity, alive, workspace) => {
    const refuse = (): never => {
      throw new Error('service operation unavailable')
    }
    const read = async <T>(fn: () => Promise<T>): Promise<T> => {
      alive()
      const result = await fn()
      alive()
      return result
    }
    const artifacts = () => {
      alive()
      if (entry.manifest.capabilities.artifacts !== true) refuse()
      return deps.seams.artifacts
    }
    return Object.freeze({
      ...identity,
      ...(identity.session && deps.workspaceInvocationFor
        ? {
            sessionFiles: createSessionFileReader(deps.workspaceInvocationFor(identity.session.key), () =>
              entry.assertRunning(),
            ),
          }
        : {}),
      actor: Object.freeze(identity.actor),
      cwd: workspace.root,
      ...(identity.session
        ? {
            childJobs: createChildJobsPort(identity.session.key, entry.capability.kind === 'effect', alive),
          }
        : {}),
      ...(entry.capability.kind === 'effect' && workspace.hookSandbox().openProcess
        ? {
            sandbox: Object.freeze({
              openProcess: async (
                request: Parameters<
                  NonNullable<import('@agnes/extension-api').ToolContext['sandbox']['openProcess']>
                >[0],
              ) => {
                alive()
                if (!deps.authorizeProcess) refuse()
                await deps.authorizeProcess!(identity, request.cwd ?? workspace.root)
                alive()
                return workspace.hookSandbox().openProcess!(request)
              },
            }),
          }
        : {}),
      // Facts at call time. Queries have no process or child cancellation opening.
      platform: platformView(deps.seams.platform),
      log: Object.freeze({
        debug: deps.log.debug.bind(deps.log),
        info: deps.log.info.bind(deps.log),
        warn: deps.log.warn.bind(deps.log),
        error: deps.log.error.bind(deps.log),
      }),
      exec: refuse,
      fs: Object.freeze({
        read: (path, opts) => read(() => workspace.fs().read(path, opts)),
        list: (path) => read(() => workspace.fs().list(path)),
        stat: (path) => read(() => workspace.fs().stat(path)),
        write: refuse,
      } satisfies ServiceContext['fs']),
      net: Object.freeze({
        fetch: async (url, init) => {
          alive()
          const target = new URL(url),
            caps = entry.manifest.capabilities.network
          const hosts = caps ?? []
          const host = target.hostname.toLowerCase(),
            port = target.port || (target.protocol === 'https:' ? '443' : '80')
          const matches = (list: readonly string[]) =>
            list.some((value) => value.toLowerCase() === host || value.toLowerCase() === `${host}:${port}`)
          if (
            !['http:', 'https:'].includes(target.protocol) ||
            target.username ||
            target.password ||
            !matches(hosts) ||
            !matches(deps.networkAllow) ||
            !['GET', 'HEAD'].includes(init?.method ?? 'GET') ||
            init?.body !== undefined
          )
            refuse()
          return createNetFetch({ signal: identity.signal, redirect: 'error' })(url, {
            method: init?.method ?? 'GET',
            ...(init?.headers ? { headers: init.headers } : {}),
            timeoutMs: Math.min(init?.timeoutMs ?? identity.timeoutMs, identity.timeoutMs),
          })
        },
      } satisfies ServiceContext['net']),
      artifacts: Object.freeze({
        get: (ref) => artifacts().get(ref),
        // Core ArtifactJob lacks public JobStatus fields. A separate jobs adapter must supply them.
        poll: refuse,
        put: refuse,
        submitJob: refuse,
        cancel: refuse,
      } satisfies ServiceContext['artifacts']),
      authorize: async (action, target) => {
        alive()
        const request = inspectJsonData({ action, target })
        if (!request.ok) return refuse()
        const checkedRequest = frozenJson(request.value) as { action: typeof action; target: typeof target }
        if (
          !validateAgainst(Action, checkedRequest.action).ok ||
          !validateAgainst(Target, checkedRequest.target).ok
        )
          return refuse()
        const result = inspectJsonData(
          await deps.seams.principals.authorize(identity.actor, checkedRequest.action, checkedRequest.target),
        )
        alive()
        if (!result.ok) return refuse()
        const checked = validateAgainst<Decision>(DecisionSchema, result.value)
        return checked.ok ? checked.value : refuse()
      },
    } satisfies ServiceContext)
  }
}

import { remoteFrontendOrigin } from '@agnes/protocol'

export const CLOUD_CREDENTIAL_STORAGE_PREFIX = 'agnes.cloud.credential.v1:'
export const CLOUD_CREDENTIAL_GENERATION_PREFIX = 'agnes.cloud.credential-gen.v1:'
export const CLOUD_DISCOVERY_KEY = 'agnes.cloud.auto-credential.v1'
const CLOUD_CREDENTIAL_DELETION_PREFIX = 'agnes.cloud.credential-deleted.v1:'
const storageKey = (origin: string) => `${CLOUD_CREDENTIAL_STORAGE_PREFIX}${remoteFrontendOrigin(origin)}`
const generationKey = (ref: string) => `${CLOUD_CREDENTIAL_GENERATION_PREFIX}${ref}`
const deletionKey = (ref: string) => `${CLOUD_CREDENTIAL_DELETION_PREFIX}${ref}`
const isReference = (value: string | null): value is string =>
  Boolean(value && /^secret:\/\/generic\/[a-f0-9-]{36}$/u.test(value))
export const isCloudDeletionGeneration = (generation: string) => generation.startsWith('deleted:')

const memoryGenerations = new Map<string, string>()
const lastObservedPersisted = new Map<string, string | null>()
const seenGenerations = new Map<string, Set<string>>()
const deliveredGenerations = new Map<string, string>()
const replacementListeners = new Set<(ref: string, generation: string) => void>()

function readPersistedGeneration(ref: string): string | null {
  try {
    return localStorage.getItem(deletionKey(ref)) ?? localStorage.getItem(generationKey(ref))
  } catch {
    return null
  }
}

function markSeen(ref: string, generation: string): void {
  let seen = seenGenerations.get(ref)
  if (!seen) {
    seen = new Set()
    seenGenerations.set(ref, seen)
  }
  seen.add(generation)
}

export function recordCloudCredentialGeneration(
  ref: string,
  generation: string,
  notify = false,
  write?: { persisted: boolean; basePersisted?: string | null },
): void {
  if (!isReference(ref) || !generation) return
  const current = readCloudCredentialGeneration(ref)
  if (isCloudDeletionGeneration(current) && !isCloudDeletionGeneration(generation)) return
  const durable = readPersistedGeneration(ref)
  if (generation !== current) {
    const supersededInStorage =
      write !== undefined &&
      durable !== null &&
      (write.persisted
        ? durable !== generation
        : write.basePersisted !== undefined && durable !== write.basePersisted)
    if (supersededInStorage || seenGenerations.get(ref)?.has(generation)) {
      markSeen(ref, generation)
      return
    }
    memoryGenerations.set(ref, generation)
    markSeen(ref, generation)
    if (durable === generation) lastObservedPersisted.set(ref, durable)
  }
  if (!notify || deliveredGenerations.get(ref) === generation) return
  deliveredGenerations.set(ref, generation)
  for (const listener of replacementListeners) listener(ref, generation)
}

const credentialChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('agnes.cloud.credentials.v1') : undefined
;(credentialChannel as unknown as { unref?: () => void } | undefined)?.unref?.()
credentialChannel?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {
    kind?: unknown
    credentialRef?: unknown
    generation?: unknown
    persisted?: unknown
    basePersisted?: unknown
  } | null
  if (
    data?.kind === 'credential-replaced' &&
    typeof data.credentialRef === 'string' &&
    typeof data.generation === 'string'
  ) {
    const write =
      typeof data.persisted === 'boolean'
        ? {
            persisted: data.persisted,
            ...(data.basePersisted === null || typeof data.basePersisted === 'string'
              ? { basePersisted: data.basePersisted }
              : {}),
          }
        : undefined
    recordCloudCredentialGeneration(data.credentialRef, data.generation, true, write)
  }
})

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.newValue) return
    for (const prefix of [CLOUD_CREDENTIAL_GENERATION_PREFIX, CLOUD_CREDENTIAL_DELETION_PREFIX]) {
      if (!event.key.startsWith(prefix)) continue
      const ref = event.key.slice(prefix.length)
      recordCloudCredentialGeneration(ref, event.newValue, true, { persisted: true })
      break
    }
  })
}

export function subscribeCloudCredentialReplacement(
  listener: (ref: string, generation: string) => void,
): () => void {
  replacementListeners.add(listener)
  return () => replacementListeners.delete(listener)
}

export function readCloudCredentialGeneration(ref: string): string {
  const known = memoryGenerations.get(ref)
  if (known && isCloudDeletionGeneration(known)) return known
  const persisted = readPersistedGeneration(ref)
  if (persisted !== lastObservedPersisted.get(ref)) {
    lastObservedPersisted.set(ref, persisted)
    if (persisted) {
      memoryGenerations.set(ref, persisted)
      markSeen(ref, persisted)
    }
  }
  const active = memoryGenerations.get(ref) ?? persisted ?? '0'
  if (active !== '0') markSeen(ref, active)
  return active
}

export function bumpCloudCredentialGeneration(ref: string, deleted = false): string {
  if (!isReference(ref)) return '0'
  const current = readCloudCredentialGeneration(ref)
  if (isCloudDeletionGeneration(current)) return current
  const basePersisted = readPersistedGeneration(ref)
  const next = `${deleted ? 'deleted:' : ''}${crypto.randomUUID()}`
  lastObservedPersisted.set(ref, basePersisted)
  memoryGenerations.set(ref, next)
  markSeen(ref, next)
  deliveredGenerations.set(ref, next)
  let persisted = false
  try {
    localStorage.setItem(deleted ? deletionKey(ref) : generationKey(ref), next)
    lastObservedPersisted.set(ref, next)
    persisted = true
  } catch {
    /* quota or storage unavailable: in-memory + BroadcastChannel still propagate */
  }
  try {
    credentialChannel?.postMessage({
      kind: 'credential-replaced',
      credentialRef: ref,
      generation: next,
      persisted,
      basePersisted,
    })
  } catch {
    /* channel may be unavailable */
  }
  if (deleted) for (const listener of replacementListeners) listener(ref, next)
  return next
}

export function deleteCloudCredential(ref: string): void {
  if (!isReference(ref)) return
  const generation = bumpCloudCredentialGeneration(ref, true)
  recordCloudCredentialGeneration(ref, generation, true)
  try {
    if (localStorage.getItem(CLOUD_DISCOVERY_KEY) === ref) localStorage.removeItem(CLOUD_DISCOVERY_KEY)
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.startsWith(CLOUD_CREDENTIAL_STORAGE_PREFIX) && localStorage.getItem(key) === ref)
        localStorage.removeItem(key)
    }
  } catch {
    /* The deletion generation still fences matching bindings when storage is unavailable. */
  }
}

export function storedCloudCredentialRefs(): Set<string> {
  const refs = new Set<string>()
  try {
    const discovery = localStorage.getItem(CLOUD_DISCOVERY_KEY)
    if (isReference(discovery)) refs.add(discovery)
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(CLOUD_CREDENTIAL_STORAGE_PREFIX)) continue
      const ref = localStorage.getItem(key)
      if (isReference(ref)) refs.add(ref)
    }
  } catch {
    /* Storage may be unavailable. Active or pending references can still be checked separately. */
  }
  return refs
}

/** Browser persistence contains only a reference; the original Key belongs to A's credential store. */
export function readCloudCredentialRef(origin: string): string | undefined {
  try {
    const value = localStorage.getItem(storageKey(origin))
    return isReference(value) && !isCloudDeletionGeneration(readCloudCredentialGeneration(value))
      ? value
      : undefined
  } catch {
    return undefined
  }
}
/** A's outer workbench validates ownership before binding; it never creates or changes a secret. */
export function bindCloudCredential(origin: string, ref: string, available: readonly { id: string }[]): void {
  if (
    !isReference(ref) ||
    isCloudDeletionGeneration(readCloudCredentialGeneration(ref)) ||
    !available.some((item) => item.id === ref)
  )
    throw new Error('cloud credential unavailable')
  localStorage.setItem(storageKey(origin), ref)
}

export function forgetCloudCredential(origin: string): void {
  try {
    localStorage.removeItem(storageKey(origin))
  } catch {
    /* storage may be unavailable */
  }
}

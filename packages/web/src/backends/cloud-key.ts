import { remoteFrontendOrigin } from '@agnes/protocol'

export const CLOUD_CREDENTIAL_STORAGE_PREFIX = 'agnes.cloud.credential.v1:'
export const CLOUD_CREDENTIAL_GENERATION_PREFIX = 'agnes.cloud.credential-gen.v1:'
const storageKey = (origin: string) => `${CLOUD_CREDENTIAL_STORAGE_PREFIX}${remoteFrontendOrigin(origin)}`
const generationKey = (ref: string) => `${CLOUD_CREDENTIAL_GENERATION_PREFIX}${ref}`
const isReference = (value: string | null): value is string =>
  Boolean(value && /^secret:\/\/generic\/[a-f0-9-]{36}$/u.test(value))

const memoryGenerations = new Map<string, string>()
const lastObservedPersisted = new Map<string, string | null>()
const seenGenerations = new Map<string, Set<string>>()
const deliveredGenerations = new Map<string, string>()
const replacementListeners = new Set<(ref: string, generation: string) => void>()

function readPersistedGeneration(ref: string): string | null {
  try {
    return localStorage.getItem(generationKey(ref))
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
    if (event.key?.startsWith(CLOUD_CREDENTIAL_GENERATION_PREFIX) && event.newValue) {
      const ref = event.key.slice(CLOUD_CREDENTIAL_GENERATION_PREFIX.length)
      recordCloudCredentialGeneration(ref, event.newValue, true, { persisted: true })
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

export function bumpCloudCredentialGeneration(ref: string): string {
  if (!isReference(ref)) return '0'
  const basePersisted = readPersistedGeneration(ref)
  const next = crypto.randomUUID()
  lastObservedPersisted.set(ref, basePersisted)
  memoryGenerations.set(ref, next)
  markSeen(ref, next)
  deliveredGenerations.set(ref, next)
  let persisted = false
  try {
    localStorage.setItem(generationKey(ref), next)
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
  return next
}

/** Browser persistence contains only a reference; the original Key belongs to A's credential store. */
export function readCloudCredentialRef(origin: string): string | undefined {
  try {
    const value = localStorage.getItem(storageKey(origin))
    return isReference(value) ? value : undefined
  } catch {
    return undefined
  }
}
/** A's outer workbench validates ownership before binding; it never creates or changes a secret. */
export function bindCloudCredential(origin: string, ref: string, available: readonly { id: string }[]): void {
  if (!isReference(ref) || !available.some((item) => item.id === ref))
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

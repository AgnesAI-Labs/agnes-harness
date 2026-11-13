import { remoteFrontendOrigin } from '@agnes/protocol'
import { CredentialError, CredentialsApi } from '@agnes/resource-control-web/credentials-api'

const storageKey = (origin: string) => `agnes.cloud.credential.v1:${remoteFrontendOrigin(origin)}`
const isReference = (value: string | null): value is string =>
  Boolean(value && /^secret:\/\/generic\/[a-f0-9-]{36}$/u.test(value))

/** Browser persistence contains only a reference; the original Key belongs to A's credential store. */
export function readCloudCredentialRef(origin: string): string | undefined {
  try {
    const value = localStorage.getItem(storageKey(origin))
    return isReference(value) ? value : undefined
  } catch {
    return undefined
  }
}
const writes = new Map<string, Promise<void>>()

/** Serialize replacements so repeated Save clicks cannot create competing credential bindings. */
export async function saveCloudKey(origin: string, key: string): Promise<void> {
  const previous = writes.get(origin) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => writeCloudKey(origin, key))
  writes.set(origin, next)
  try {
    await next
  } finally {
    if (writes.get(origin) === next) writes.delete(origin)
  }
}

/** Called by A's outer workbench, whose fetch is never redirected to the selected cloud backend. */
async function writeCloudKey(origin: string, key: string): Promise<void> {
  if (!key.trim() || key.length > 4096) throw new Error('invalid cloud Key')
  const api = new CredentialsApi()
  const existing = readCloudCredentialRef(origin)
  let id = existing
  if (existing) {
    try {
      await api.set(existing, key)
    } catch (error) {
      if (!(error instanceof CredentialError && error.reason === 'missing')) throw error
      id = undefined
    }
  }
  if (!id) id = (await api.create(`Cloud · ${remoteFrontendOrigin(origin)}`.slice(0, 128), key)).id
  localStorage.setItem(storageKey(origin), id)
}

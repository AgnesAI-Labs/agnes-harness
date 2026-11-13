import { remoteFrontendOrigin } from '@agnes/protocol'

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
/** A's outer workbench validates ownership before binding; it never creates or changes a secret. */
export function bindCloudCredential(origin: string, ref: string, available: readonly { id: string }[]): void {
  if (!isReference(ref) || !available.some((item) => item.id === ref))
    throw new Error('cloud credential unavailable')
  localStorage.setItem(storageKey(origin), ref)
}

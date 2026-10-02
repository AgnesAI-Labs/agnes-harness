/** Host-private source identity; this is not a serialized Runtime payload or a permission. */
export type IdentityCredentialSource = Readonly<
  | { kind: 'deployment'; generation: string; keyId: string | null }
  | { kind: 'http-session'; ownerRef: string; revision: number }
>

export function identityCredentialSource(value: unknown): IdentityCredentialSource | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const keys = Object.keys(source).sort().join(',')
  if (
    source.kind === 'deployment' &&
    keys === 'generation,keyId,kind' &&
    typeof source.generation === 'string' &&
    source.generation &&
    (source.keyId === null || (typeof source.keyId === 'string' && source.keyId))
  )
    return Object.freeze({ kind: 'deployment', generation: source.generation, keyId: source.keyId })
  if (
    source.kind === 'http-session' &&
    keys === 'kind,ownerRef,revision' &&
    typeof source.ownerRef === 'string' &&
    source.ownerRef &&
    typeof source.revision === 'number' &&
    Number.isSafeInteger(source.revision) &&
    source.revision > 0
  )
    return Object.freeze({ kind: 'http-session', ownerRef: source.ownerRef, revision: source.revision })
  return null
}

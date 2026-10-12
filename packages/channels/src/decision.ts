import type { UINode } from '@agnes/protocol'

type Ref = NonNullable<Extract<UINode, { kind: 'approval' }>['decisionRef']>
export function decisionKey(ref: Ref): string {
  return [ref.sessionId, ref.id, String(ref.revision)].map(encodeURIComponent).join('/')
}
export function decisionRef(key: string): Ref | undefined {
  try {
    const parts = key.split('/').map(decodeURIComponent)
    if (parts.length !== 3) return undefined
    const [sessionId, id, rev] = parts
    const revision = Number(rev)
    if (
      !sessionId ||
      !id ||
      sessionId.length > 512 ||
      id.length > 256 ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      return undefined
    return { sessionId, id, revision }
  } catch {
    return undefined
  }
}

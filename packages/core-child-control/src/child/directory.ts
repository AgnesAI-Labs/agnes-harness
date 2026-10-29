import type { ChildAgentListing } from '@agnes/extension-api'

export type ExternalChildControls = {
  listing: ChildAgentListing
  sendMessage?(text: string, signal: AbortSignal): Promise<{ messageId: string }>
  interrupt?(): Promise<{ accepted: boolean }>
  cancel?(): Promise<void>
}

const bySession = new Map<string, Map<string, ExternalChildControls>>()

/** Track a child that does not live in the in-process session factory. */
export function trackExternalChild(sessionKey: string, controls: ExternalChildControls): () => void {
  let session = bySession.get(sessionKey)
  if (!session) {
    session = new Map()
    bySession.set(sessionKey, session)
  }
  session.set(controls.listing.id, controls)
  return () => {
    const current = bySession.get(sessionKey)
    if (current?.get(controls.listing.id) !== controls) return
    current.delete(controls.listing.id)
    if (current.size === 0) bySession.delete(sessionKey)
  }
}

export function externalChildren(sessionKey: string): readonly ExternalChildControls[] {
  return [...(bySession.get(sessionKey)?.values() ?? [])]
}

export function externalChild(sessionKey: string, childId: string): ExternalChildControls | undefined {
  return bySession.get(sessionKey)?.get(childId)
}

export function updateExternalChild(sessionKey: string, childId: string, listing: ChildAgentListing): void {
  const controls = bySession.get(sessionKey)?.get(childId)
  if (controls) controls.listing = listing
}

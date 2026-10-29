import type { WorkspaceInvocationPort } from '@agnes/core'

/** Host-private lookup. Resolving a missing or closing session must fail closed. */
export type WorkspaceInvocationResolver = (sessionKey: string) => WorkspaceInvocationPort

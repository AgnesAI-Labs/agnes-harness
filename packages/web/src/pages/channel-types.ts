import type { ChannelManifest, JsonValue, SessionMeta } from '@agnes/protocol'

export type Provider = {
  extension: string
  packageId: string
  rowId: string
  revision?: string
  manifest: ChannelManifest
  configSchema: Record<string, unknown>
  bindingAvailable: boolean
}
export type Instance = {
  id: string
  workspace: string
  agent: string
  credentialRefs: Record<string, string>
  allowFrom: string[]
  requireMention: boolean
  config?: JsonValue
}
export type SessionInstance = {
  id: string
  version: number
  connection: { channel: string; daemon: string } | null
  targets: { id: string; label: string; confirmed: boolean; unavailable: boolean }[]
  bindings: { targetId: string; label: string; state: string }[]
}
export type ManagedInstance = Instance & {
  connection: SessionInstance['connection']
  version: number
  bindings: (SessionInstance['bindings'][number] & { sessionId: string; sessionTitle: string })[]
  unavailable: boolean
  statusUnavailable?: boolean
  recovery?: boolean
  intendedSession?: SessionMeta
}
export type ChannelGroup = {
  provider: Provider
  configurationRevision?: string
  instances: ManagedInstance[]
  error?: boolean
}
export type ChannelOverview = { channels: ChannelGroup[]; sessions: SessionMeta[] }
export type ChannelContext = {
  sessionId: string
  title: string
  workspace: string
  agent: string
  agentTitle: { en: string; 'zh-CN': string }
  instanceId: string
}

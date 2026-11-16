import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ChannelManifest, JsonValue, ProfileServiceReceipt } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import type { Instance } from './channel-workbench.js'

/** A connection created on its own, not derived from a session and never bound by this flow. */
const DEDICATED_ID = /^d-[a-f0-9]{12}$/
/** A deterministic refusal: the same request is refused again until the person changes or re-reads it. */
export class ChannelRefusal extends Error {
  /** `exists`: the connection id is already configured, for example by an earlier unconfirmed attempt. */
  constructor(readonly reason?: 'exists') {
    super('Channel workbench request refused')
  }
}
function refuse(reason?: 'exists'): never {
  throw new ChannelRefusal(reason)
}

/**
 * Dedicated channel connections for an app that claims a whole instance. The server picks the identity,
 * workspace path and agent; creation only appends to the reviewed configuration and never binds,
 * pairs or claims anything.
 */
export function dedicatedChannels(deps: {
  client: Client
  catalog(): Promise<{ extension: string; manifest: ChannelManifest }[]>
  scoped<T>(
    extension: string,
    service: string,
    input?: unknown,
    operationId?: string,
    expectedConfigurationRevision?: string,
  ): Promise<T>
  replay(extension: string, operationId: string): Promise<ProfileServiceReceipt | undefined>
}) {
  const { client, catalog, scoped, replay } = deps
  const provider = async (extension: string) => {
    const found = (await catalog()).find((item) => item.extension === extension)
    if (!found) refuse()
    return found
  }
  // Only registered, available workspaces with an absolute root can host a dedicated connection.
  const workspaces = async () =>
    (await client.workspace.list()).items.flatMap((item) =>
      item.workspaceId && item.available && isAbsolute(item.path)
        ? [{ workspaceId: item.workspaceId, name: item.name, path: item.path }]
        : [],
    )
  const dedicatedContext = async (extension: string) => {
    await provider(extension)
    return {
      instanceId: `d-${randomBytes(6).toString('hex')}`,
      agent: 'default',
      agentTitle: { en: 'Default assistant', 'zh-CN': '默认助手' },
      workspaces: await workspaces(),
    }
  }
  /** Adds one new connection to the reviewed configuration. It never binds, pairs or claims anything. */
  const configureDedicated = async (params: Record<string, unknown>) => {
    const extension = String(params.extension),
      instanceId = String(params.instanceId),
      operationId = String(params.operationId),
      expected = String(params.configurationRevision)
    const declared = (await provider(extension)).manifest.credentials
    if (!DEDICATED_ID.test(instanceId)) refuse()
    // Read before the replay: the Host settles a pending operation whose configuration moved since review.
    const configuration = await scoped<{ output: { instances: Instance[] } }>(extension, 'configuration')
    const replayed = await replay(extension, operationId)
    if (replayed) return { receipt: replayed, instanceId }
    const credentialRefs = params.credentialRefs as Record<string, string>
    if (
      Object.keys(credentialRefs).some(
        (key) => !declared.required.includes(key) && !declared.optional.includes(key),
      ) ||
      declared.required.some((key) => !credentialRefs[key])
    )
      refuse()
    if (configuration.output.instances.some((instance) => instance.id === instanceId)) refuse('exists')
    const workspace = (await workspaces()).find((item) => item.workspaceId === params.workspaceId)
    if (!workspace) refuse()
    const next: Instance = {
      id: instanceId,
      workspace: workspace.path,
      agent: 'default',
      credentialRefs,
      config: (params.config ?? {}) as JsonValue,
      allowFrom: (params.allowFrom ?? []) as string[],
      requireMention: params.requireMention !== false,
    }
    // A stale form is still sent: the Host journals its no-write refusal under this operation id. It
    // compares the reviewed revision before review and again inside its write transaction.
    const instances = [...configuration.output.instances, next]
    const receipt = await scoped<ProfileServiceReceipt>(
      extension,
      'configure',
      { instances },
      operationId,
      expected,
    )
    return { receipt, instanceId }
  }
  return { dedicatedContext, configureDedicated }
}

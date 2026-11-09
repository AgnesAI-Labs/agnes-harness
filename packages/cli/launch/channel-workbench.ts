import { createHash, randomBytes } from 'node:crypto'
import type { ChannelManifest, JsonValue, ProfileServiceReceipt, SessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'

type Instance = {
  id: string
  workspace: string
  agent: string
  credentialRefs: Record<string, string>
  allowFrom: string[]
  requireMention: boolean
  config?: JsonValue
}
type Provider = {
  extension: string
  manifest: ChannelManifest
  bindingAvailable: boolean
  [key: string]: unknown
}
type Binding = { sessionId: string; targetId: string; label: string; state: string }
type Health = {
  id: string
  version: number
  connection: { channel: string; daemon: string } | null
  bindings?: Binding[]
  recovery?: boolean
}
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const prefix = (extension: string, sessionId: string) => `s-${revision([extension, sessionId]).slice(0, 12)}`
function refuse(): never {
  throw new Error('Channel workbench request refused')
}

/** Private loopback workbench contract. Session facts and configuration merges stay server-owned. */
export function channelWorkbench(client: Client, profile: string) {
  const catalog = async () =>
    (await client.call<{ providers: Provider[] }>('_agnes/v1/channels.catalog', {})).providers
  const scoped = async <T>(extension: string, service: string, input: unknown = {}, operationId?: string) =>
    client.call<T>('_agnes/v1/extension.callScoped', {
      extension,
      service: `channel.${service}`,
      input,
      ...(operationId ? { operationId } : {}),
    })
  const sessions = async () => {
    const items: SessionMeta[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await client.session.list({ limit: 100, ...(cursor ? { cursor } : {}) })
      items.push(...page.items)
      cursor = page.next
      if (cursor && seen.has(cursor)) refuse()
      if (cursor) seen.add(cursor)
    } while (cursor)
    return items.filter((item) => !item.archived)
  }
  const context = async (extension: string, sessionId: string, existingId?: string) => {
    const [providers, owned, runtime] = await Promise.all([
      catalog(),
      sessions(),
      client.session.runtime(sessionId),
    ])
    if (!providers.some((provider) => provider.extension === extension && provider.bindingAvailable)) refuse()
    const session = owned.find((item) => item.sessionId === sessionId)
    if (!session?.cwd) refuse()
    const agents = (await client.packages.list({ profile })).packages.flatMap((item) => item.agents ?? [])
    const agent = runtime.preset?.bundles.find((ref) => agents.some((item) => item.ref === ref))
    const declaration = agents.find((item) => item.ref === agent)
    return {
      sessionId,
      title: session.title || sessionId,
      workspace: session.cwd,
      agent: agent ?? 'default',
      agentTitle:
        declaration?.launch.title ??
        (runtime.loop?.id === 'agnes.default'
          ? { en: 'General assistant', 'zh-CN': '通用助手' }
          : { en: 'Current session assistant', 'zh-CN': '当前会话智能体' }),
      instanceId: existingId?.startsWith(`${prefix(extension, sessionId)}-`)
        ? existingId
        : `${prefix(extension, sessionId)}-${randomBytes(3).toString('hex')}`,
    }
  }
  const overview = async () => {
    const [providers, owned] = await Promise.all([catalog(), sessions()])
    const ownedById = new Map(owned.map((session) => [session.sessionId, session]))
    const channels = await Promise.all(
      providers.map(async (provider) => {
        try {
          const [configuration, check] = await Promise.all([
            scoped<{ output: { instances: Instance[] } }>(provider.extension, 'configuration'),
            scoped<{ output: { instances: Health[] } }>(provider.extension, 'check').catch(() => undefined),
          ])
          return {
            provider,
            configurationRevision: revision(configuration.output),
            instances: configuration.output.instances.map((instance) => {
              const health = check?.output.instances.find((row) => row.id === instance.id)
              const bindings = health?.bindings ?? []
              return {
                ...instance,
                connection: health?.connection ?? null,
                version: health?.version ?? 0,
                bindings: bindings
                  .filter((binding) => ownedById.has(binding.sessionId))
                  .map((binding) => ({
                    ...binding,
                    sessionTitle: ownedById.get(binding.sessionId)?.title || binding.sessionId,
                  })),
                unavailable: bindings.some((binding) => !ownedById.has(binding.sessionId)),
                statusUnavailable: !health,
                recovery: health?.recovery === true,
                intendedSession: owned.find((session) =>
                  instance.id.startsWith(`${prefix(provider.extension, session.sessionId)}-`),
                ),
              }
            }),
          }
        } catch {
          return { provider, instances: [], error: true }
        }
      }),
    )
    return { channels, sessions: owned }
  }
  const configure = async (params: Record<string, unknown>) => {
    const extension = String(params.extension),
      sessionId = String(params.sessionId),
      operationId = String(params.operationId)
    const identity = await context(extension, sessionId, String(params.instanceId))
    if (
      identity.instanceId !== params.instanceId ||
      !/^s-[a-f0-9]{12}-[a-f0-9]{6}$/.test(identity.instanceId)
    )
      refuse()
    // A lost response must replay the same native receipt before checking today's configuration.
    try {
      const receipt = await client.extensions.readOperation({
        extension,
        service: 'channel.configure',
        operationId,
      })
      if (receipt.state !== 'approval-required') return { receipt, instanceId: identity.instanceId }
    } catch (error) {
      if ((error as { data?: { code?: string } }).data?.code !== 'CAPABILITY_DENIED') throw error
    }
    const configuration = await scoped<{ output: { instances: Instance[] } }>(extension, 'configuration')
    if (revision(configuration.output) !== params.configurationRevision)
      throw new Error('Channel configuration changed; refresh before saving')
    const replaceId = typeof params.replaceId === 'string' ? params.replaceId : undefined
    const check = await scoped<{ output: { instances: Health[] } }>(extension, 'check')
    const old = configuration.output.instances.find((instance) => instance.id === replaceId)
    if (replaceId && !old) refuse()
    const owned = new Set((await sessions()).map((item) => item.sessionId))
    if (
      check?.output.instances
        .find((item) => item.id === replaceId)
        ?.bindings?.some((binding) => !owned.has(binding.sessionId))
    )
      refuse()
    if (!replaceId && configuration.output.instances.some((instance) => instance.id === identity.instanceId))
      refuse()
    const next: Instance = {
      id: identity.instanceId,
      workspace: identity.workspace,
      agent: identity.agent,
      credentialRefs: params.credentialRefs as Record<string, string>,
      config: (params.config ?? {}) as JsonValue,
      allowFrom: (params.allowFrom ?? []) as string[],
      requireMention: params.requireMention !== false,
    }
    const instances = configuration.output.instances.filter((instance) => instance.id !== replaceId)
    instances.push(next)
    const receipt = await scoped<ProfileServiceReceipt>(extension, 'configure', { instances }, operationId)
    return { receipt, instanceId: identity.instanceId }
  }
  const remove = async (params: Record<string, unknown>) => {
    const extension = String(params.extension),
      instanceId = String(params.instanceId),
      operationId = String(params.operationId)
    if (!(await catalog()).some((provider) => provider.extension === extension)) refuse()
    // Reconcile the original native operation even if the instance is already gone.
    try {
      const receipt = await client.extensions.readOperation({
        extension, service: 'channel.configure', operationId,
      })
      if (receipt.state !== 'approval-required') return { receipt, instanceId }
    } catch (error) {
      if ((error as { data?: { code?: string } }).data?.code !== 'CAPABILITY_DENIED') throw error
    }
    const configuration = await scoped<{ output: { instances: Instance[] } }>(extension, 'configuration')
    if (revision(configuration.output) !== params.configurationRevision)
      throw new Error('Channel configuration changed; refresh before deleting')
    if (!configuration.output.instances.some((instance) => instance.id === instanceId)) refuse()
    const check = await scoped<{ output: { instances: Health[] } }>(extension, 'check')
    const health = check.output.instances.find((instance) => instance.id === instanceId)
    const owned = new Set((await sessions()).map((session) => session.sessionId))
    if (!health || health.version !== params.expectedVersion ||
      !Array.isArray(health.bindings) || health.bindings.some((binding) => !owned.has(binding.sessionId))) refuse()
    const receipt = await scoped<ProfileServiceReceipt>(extension, 'configure', {
      instances: configuration.output.instances.filter((instance) => instance.id !== instanceId),
    }, operationId)
    return { receipt, instanceId }
  }
  return { overview, context, configure, remove }
}

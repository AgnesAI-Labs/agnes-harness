import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type WebhookTriggerProvider, webhookTriggerKind } from '@agnes/extension-api'
import { ProviderRegistry } from '@agnes/host'
import { rpcError, validateAgainst } from '@agnes/protocol'
import {
  WebhookConfig,
  type WebhookRequest,
  WebhookRequest as WebhookRequestSchema,
  type WebhookResult,
  WebhookRule,
} from '@agnes/protocol/gen/app-server'
import { matches, render, validatePaths } from './payload.js'
import { genericWebhookProvider, githubWebhookProvider, sampleHeaders } from './providers.js'
import { WebhookStore } from './store.js'

export { genericWebhookProvider, githubWebhookProvider } from './providers.js'

export type TriggerSessionInput = {
  sessionKey: string
  workspace: string
  agent: string
  bundles: string[]
  prompt: string
  trigger: { provider: string; ruleId: string; deliveryId: string }
}
export function createWebhookService(options: {
  dataDir: string
  resolveSecret(ref: string): Promise<string>
  secretRefs(): Promise<string[]>
  workspaces(): Promise<{ items: { path: string; available: boolean }[] }>
  createSession?(input: TriggerSessionInput): Promise<void>
  now?: () => number
  providers?: readonly WebhookTriggerProvider[]
}) {
  const store = new WebhookStore(join(options.dataDir, 'webhook-triggers.json'))
  const providers = new ProviderRegistry(webhookTriggerKind)
  for (const provider of options.providers ?? [githubWebhookProvider, genericWebhookProvider])
    providers.register('@agnes/daemon-admin', provider)
  const now = options.now ?? Date.now
  let serial: Promise<unknown> = Promise.resolve()
  let pending = 0
  async function deliver(
    body: Buffer,
    headers: Record<string, string>,
    onlyRule?: string,
    tooLarge = false,
  ): Promise<WebhookResult> {
    const state = store.state
    if (!state.config.enabled) return { delivery: store.log('disabled') }
    if (tooLarge || body.length > state.config.maxPayloadBytes) return { delivery: store.log('too-large') }
    if (
      (headers['content-type'] !== undefined &&
        !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(headers['content-type'])) ||
      headers['content-encoding'] !== undefined
    )
      return { delivery: store.log('invalid-payload') }
    if (!state.rules.some((rule) => rule.enabled)) return { delivery: store.log('no-rule') }
    let verified = false
    let invalid = false
    let replay = false
    for (const rule of state.rules) {
      if (!rule.enabled || (onlyRule && rule.id !== onlyRule)) continue
      let value: Awaited<ReturnType<WebhookTriggerProvider['verify']>>
      try {
        value = await providers
          .resolve(rule.provider)
          .verify({ body, headers, rule, resolveSecret: options.resolveSecret })
      } catch {
        invalid = true
        continue
      }
      if (!value) continue
      verified = true
      try {
        if (value.event !== rule.event || !matches(rule, value.payload)) continue
      } catch {
        invalid = true
        continue
      }
      const time = now()
      if (
        !Number.isSafeInteger(value.timestamp) ||
        Math.abs(time - value.timestamp) > rule.windowSeconds * 1000
      ) {
        replay = true
        continue
      }
      // GitHub's delivery/event headers are not signed. A second body digest blocks header-id replay.
      const namespace = `${rule.provider}:${rule.secretRef}`
      const keys = [
        `${namespace}:id:${value.deliveryId}`,
        ...(rule.provider === 'github'
          ? [`${namespace}:body:${createHash('sha256').update(body).digest('hex')}`]
          : []),
      ]
      state.dedup = state.dedup.filter((item) => item.expires > time)
      if (state.dedup.some((item) => keys.includes(item.key)))
        return { delivery: store.log('duplicate', rule.id) }
      const recent = (state.rates[rule.id] ?? []).filter((at) => time - at < 60000)
      if (recent.length >= rule.ratePerMinute) return { delivery: store.log('rate-limited', rule.id) }
      if (state.dedup.length + keys.length > 10000) return { delivery: store.log('capacity', rule.id) }
      const { items } = await options.workspaces()
      if (!items.some((item) => item.available && item.path === rule.workspace) || !options.createSession)
        return { delivery: store.log('failed', rule.id) }
      let prompt: string
      try {
        prompt = render(rule, value.payload)
      } catch {
        return { delivery: store.log('invalid-payload', rule.id) }
      }
      const sessionId = `agnes:webhook:${rule.id}:${randomUUID()}`
      state.dedup.push(
        ...keys.map((key) => ({
          key,
          expires: Math.max(time + 86400000, value.timestamp + rule.windowSeconds * 1000 + 1),
        })),
      )
      state.rates[rule.id] = [...recent, time]
      // Persist reservation before entering normal session/new. Uncertain work is never retried.
      const row = store.log('pending', rule.id, sessionId)
      try {
        await options.createSession({
          sessionKey: sessionId,
          workspace: rule.workspace,
          agent: rule.agent,
          bundles: rule.bundles,
          prompt,
          trigger: { provider: rule.provider, ruleId: rule.id, deliveryId: value.deliveryId },
        })
        row.status = 'accepted'
      } catch {
        row.status = 'failed'
      }
      store.save()
      return { delivery: row }
    }
    return {
      delivery: store.log(
        replay ? 'replay' : invalid ? 'invalid-payload' : verified ? 'no-rule' : 'bad-signature',
      ),
    }
  }
  async function handle(input: WebhookRequest): Promise<WebhookResult> {
    const state = store.state
    if (input.action === 'list')
      return { snapshot: { ...store.snapshot(), secretRefs: await options.secretRefs() } }
    if (input.action === 'configure') {
      if (!input.config || !validateAgainst(WebhookConfig, input.config).ok) throw rpcError('INVALID_PARAMS')
      state.config = input.config
    } else if (input.action === 'upsert') {
      if (!input.rule || !validateAgainst(WebhookRule, input.rule).ok) throw rpcError('INVALID_PARAMS')
      const rule = input.rule
      validatePaths(rule)
      const { items } = await options.workspaces()
      if (!items.some((item) => item.available && item.path === rule.workspace))
        throw rpcError('CAPABILITY_DENIED')
      if (!state.rules.some((item) => item.id === rule.id) && state.rules.length >= 128)
        throw rpcError('INVALID_PARAMS')
      state.rules = [...state.rules.filter((item) => item.id !== rule.id), rule].sort((a, b) =>
        a.id.localeCompare(b.id),
      )
    } else if (input.action === 'delete') {
      if (!input.ruleId) throw rpcError('INVALID_PARAMS')
      state.rules = state.rules.filter((rule) => rule.id !== input.ruleId)
      delete state.rates[input.ruleId ?? '']
    } else if (input.action === 'deliver') {
      // Base64 preserves the exact signed bytes across the JSON RPC transport.
      return deliver(Buffer.from(input.body ?? '', 'base64'), input.headers ?? {}, undefined, input.tooLarge)
    } else if (input.action === 'test') {
      const rule = state.rules.find((rule) => rule.id === input.ruleId)
      if (!rule) return { delivery: store.log('no-rule') }
      const body = Buffer.from(JSON.stringify(input.payload ?? null))
      try {
        const secret = await options.resolveSecret(rule.secretRef)
        return deliver(body, sampleHeaders(rule, body, secret, now(), randomUUID()), rule.id)
      } catch {
        return { delivery: store.log('bad-signature', rule.id) }
      }
    } else throw rpcError('INVALID_PARAMS')
    store.save()
    return { snapshot: { ...store.snapshot(), secretRefs: await options.secretRefs() } }
  }
  return {
    handle(input: WebhookRequest): Promise<WebhookResult> {
      if (!validateAgainst(WebhookRequestSchema, input).ok) return Promise.reject(rpcError('INVALID_PARAMS'))
      // Bound retained raw deliveries while a normal session admission waits for its worker.
      if (pending >= 64) {
        if (input.action === 'deliver' || input.action === 'test')
          return Promise.resolve({ delivery: store.log('capacity') })
        return Promise.reject(rpcError('SEMANTIC_REJECTED'))
      }
      pending++
      const copy = structuredClone(input)
      const result = serial
        .then(() => handle(copy))
        .finally(() => {
          pending--
        })
      serial = result.catch(() => undefined)
      return result
    },
  }
}

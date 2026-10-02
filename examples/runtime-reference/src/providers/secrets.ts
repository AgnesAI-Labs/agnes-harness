import { randomUUID } from 'node:crypto'
import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionContext, CallContext, Outcome, TrustedIngressContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync, hasPrivateDaclSync } from '@agnes/system-node'

type Permit = {
  readonly principalRef: string
  readonly scope: W.ScopeRef
  readonly binding: W.SecretConsumerBinding
}
type Credential = {
  readonly secretId: string
  readonly versions: readonly { readonly version: string; readonly ref: string }[]
}
type Slot = { id: string; pointer: string; version: string; sequence: number; removed: boolean }
type Ticket = { locator: W.SecretHandle; permit: string; sequence: number }
type Cabinet = { tenant: string; slots: Slot[]; tickets: Ticket[] }
export interface ReferenceSecretsOptions {
  readonly directory: string
  readonly tenantId: string
  readonly entries: readonly Credential[]
  readonly grants: readonly Permit[]
  readonly source: { resolve(ref: string): string }
  readonly identity: {
    resolve(
      request: W.IdentityResolveRequest,
      context: CallContext,
    ): Promise<Outcome<W.AuthenticatedIdentity>>
  }
  readonly maintenance: (context: CallContext) => boolean
  readonly now?: () => number
  readonly handleMs?: number
  readonly drainMs?: number
}
function fail<T = never>(detailCode: string, code: W.RuntimeError['code'] = 'denied'): Outcome<T> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      diagnosticId: 'reference-secret-broker',
      retryAdvice: { kind: 'never' },
      message: 'Secret request refused',
    },
  }
}
class Stop {
  constructor(
    readonly detail: string,
    readonly code: W.RuntimeError['code'] = 'denied',
  ) {}
}
function input<K extends keyof W.RuntimeWireTypes>(name: K, value: unknown): W.RuntimeWireTypes[K] {
  const parsed = validateRuntime(name, value)
  if (!parsed.ok) throw new Stop('secret_schema', 'invalid_input')
  return parsed.value
}

function bounded<T>(cancel: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const stopped = () => reject(new Stop('secret_cancelled', 'cancelled'))
    cancel.addEventListener('abort', stopped, { once: true })
    if (cancel.aborted) stopped()
    promise.then(resolve, reject).finally(() => cancel.removeEventListener('abort', stopped))
  })
}
export function createReferenceSecrets(settings: ReferenceSecretsOptions) {
  const catalogue = settings.entries.map((item) => ({
    ...item,
    versions: item.versions.map((value) => ({ ...value })),
  }))
  const permissions = settings.grants.map((item) => JSON.parse(JSON.stringify(item)) as Permit)
  for (const item of catalogue)
    for (const value of item.versions)
      if (!/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/u.test(value.ref))
        throw new Error('Invalid reference catalogue')
  if (!existsSync(settings.directory)) createPrivateDirectorySync(settings.directory)
  const location = join(settings.directory, 'cabinet.sqlite')
  if (!existsSync(location)) closeSync(createPrivateFileSync(location))
  if (!hasPrivateDaclSync(settings.directory) || !hasPrivateDaclSync(location))
    throw new Error('Private broker storage required')
  const disk = new DatabaseSync(location)
  disk.exec(
    'PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cabinet (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), document TEXT NOT NULL)',
  )
  disk.prepare('INSERT OR IGNORE INTO cabinet VALUES (1, ?)').run(
    JSON.stringify({
      tenant: settings.tenantId,
      slots: catalogue.map((item) => {
        const first = item.versions[0]
        if (!first) throw new Error('Empty reference catalogue')
        return { id: item.secretId, pointer: first.ref, version: first.version, sequence: 1, removed: false }
      }),
      tickets: [],
    }),
  )
  const clock = settings.now ?? Date.now
  const ending = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let closeTask: Promise<void> | null = null

  function view(): Cabinet {
    const saved = disk.prepare('SELECT document FROM cabinet WHERE singleton = 1').get()
    const state = JSON.parse(String(saved?.document)) as Cabinet
    if (state.tenant !== settings.tenantId || !Array.isArray(state.slots) || !Array.isArray(state.tickets))
      throw new Stop('secret_catalogue')
    for (const item of state.slots) {
      if (
        !Number.isSafeInteger(item.sequence) ||
        typeof item.removed !== 'boolean' ||
        !catalogue
          .find((entry) => entry.secretId === item.id)
          ?.versions.some((value) => value.ref === item.pointer && value.version === item.version)
      )
        throw new Stop('secret_catalogue')
    }
    return state
  }
  function edit<T>(operation: (state: Cabinet) => T): T {
    disk.exec('BEGIN IMMEDIATE')
    try {
      const state = view()
      const result = operation(state)
      disk.prepare('UPDATE cabinet SET document = ? WHERE singleton = 1').run(JSON.stringify(state))
      disk.exec('COMMIT')
      return result
    } catch (problem) {
      disk.exec('ROLLBACK')
      throw problem
    }
  }
  function slot(state: Cabinet, id: string): Slot {
    const found = state.slots.find((item) => item.id === id)
    if (!found) throw new Stop('secret_denied')
    if (found.removed) throw new Stop('secret_revoked')
    return found
  }
  async function actor(call: CallContext, signal: AbortSignal): Promise<void> {
    const result = await bounded(signal, settings.identity.resolve({ principalRef: call.principalRef }, call))
    if (
      !result.ok ||
      !validateRuntime('AuthenticatedIdentity', result.value).ok ||
      result.value.principalRef !== call.principalRef ||
      result.value.tenantRef !== settings.tenantId ||
      Date.parse(result.value.expiresAt) <= clock() ||
      ending.signal.aborted ||
      call.signal.aborted ||
      Date.parse(call.deadline) <= clock()
    )
      throw new Stop('secret_denied')
  }
  async function permission(
    id: string,
    audience: string,
    purpose: string,
    call: CallContext,
    signal: AbortSignal,
  ): Promise<Permit> {
    await actor(call, signal)
    for (const candidate of permissions) {
      if (
        candidate.principalRef === call.principalRef &&
        canonicalJsonDigest(candidate.scope) === canonicalJsonDigest(call.scope) &&
        candidate.binding.secretId === id &&
        candidate.binding.audience === audience &&
        candidate.binding.purpose === purpose
      ) {
        slot(view(), id)
        return candidate
      }
    }
    throw new Stop('secret_denied')
  }
  async function wrap<T>(
    call: { signal: AbortSignal; deadline: string },
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<Outcome<T>> {
    if (ending.signal.aborted) return fail('secret_closed')
    if (
      call.signal.aborted ||
      !Number.isFinite(Date.parse(call.deadline)) ||
      Date.parse(call.deadline) <= clock()
    )
      return fail('secret_cancelled', 'cancelled')
    const limit = new AbortController()
    const timer = setTimeout(
      () => limit.abort(),
      Math.min(30000, Math.max(1, Date.parse(call.deadline) - clock())),
    )
    const signal = AbortSignal.any([call.signal, ending.signal, limit.signal])
    const task = operation(signal)
    pending.add(task)
    try {
      const value = await task
      return signal.aborted ? fail('secret_cancelled', 'cancelled') : { ok: true, value }
    } catch (reason) {
      return reason instanceof Stop ? fail(reason.detail, reason.code) : fail('secret_unavailable')
    } finally {
      pending.delete(task)
      clearTimeout(timer)
    }
  }
  const binding: W.BindingRef = {
    providerId: 'agh.reference/secrets',
    logicalName: 'secrets',
    contract: 'agh.secrets',
    bindingId: 'agh.reference/secrets/binding',
  }
  return {
    binding,
    providerDigest: canonicalJsonDigest({ contract: binding.contract, recipe: 'document-cabinet' }),
    features: [
      'resolve',
      'rotate',
      'revoke',
      'scope-bound-handles',
      'durable-revocation',
    ] as readonly string[],
    resolve(request: unknown, call: CallContext) {
      return wrap(call, async (signal) => {
        const query = input('SecretsResolveRequest', request)
        const permit = await permission(query.secretId, query.audience, query.purpose, call, signal)
        return edit((state) => {
          const item = slot(state, query.secretId)
          const locator: W.SecretHandle = {
            secretId: query.secretId,
            audience: query.audience,
            version: item.version,
            expiresAt: new Date(clock() + (settings.handleMs ?? 60000)).toISOString(),
            handleId: randomUUID(),
          }
          state.tickets.push({ locator, permit: canonicalJsonDigest(permit), sequence: item.sequence })
          return locator
        })
      })
    },
    use(
      handle: unknown,
      consumer: W.SecretConsumerBinding,
      call: CallContext,
      consume: (material: string, signal: AbortSignal) => Promise<void> | void,
    ) {
      return wrap(call, async (signal) => {
        const ref = input('SecretHandle', handle)
        const permit = await permission(ref.secretId, ref.audience, consumer.purpose, call, signal)
        if (canonicalJsonDigest(permit.binding) !== canonicalJsonDigest(consumer))
          throw new Stop('secret_consumer')
        const state = view()
        const ticket = state.tickets.find((item) => item.locator.handleId === ref.handleId)
        const current = slot(state, ref.secretId)
        if (
          !ticket ||
          canonicalJsonDigest(ticket.locator) !== canonicalJsonDigest(ref) ||
          ticket.permit !== canonicalJsonDigest(permit) ||
          ticket.sequence !== current.sequence ||
          ref.version !== current.version ||
          Date.parse(ref.expiresAt) <= clock()
        )
          throw new Stop('secret_handle')
        const value = settings.source.resolve(current.pointer)
        await permission(ref.secretId, ref.audience, consumer.purpose, call, signal)
        if (slot(view(), ref.secretId).sequence !== current.sequence) throw new Stop('secret_revoked')
        signal.throwIfAborted()
        await consume(value, signal)
      })
    },
    rotate(request: unknown, call: CallContext) {
      return wrap(call, async (signal) => {
        await actor(call, signal)
        if (!settings.maintenance(call)) throw new Stop('secret_maintenance')
        const command = input('SecretsRotateRequest', request)
        return edit((state) => {
          const item = slot(state, command.secretId)
          const version = catalogue
            .find((entry) => entry.secretId === command.secretId)
            ?.versions.find((entry) => entry.ref === command.newVersionRef)
          if (!version || version.version === item.version) throw new Stop('secret_version', 'invalid_input')
          item.pointer = version.ref
          item.version = version.version
          item.sequence += 1
          return { revision: item.sequence }
        })
      })
    },
    revoke(request: unknown, call: CallContext) {
      return wrap(call, async (signal) => {
        await actor(call, signal)
        if (!settings.maintenance(call)) throw new Stop('secret_maintenance')
        const command = input('SecretsRevokeRequest', request)
        return edit((state) => {
          const item = state.slots.find((entry) => entry.id === command.secretId)
          if (!item) throw new Stop('secret_denied')
          if (!item.removed) {
            item.removed = true
            item.sequence += 1
          }
          return { revision: item.sequence }
        })
      })
    },
    refresh(_request: unknown, call: ActionContext): Promise<Outcome<W.CredentialRefreshResult>> {
      return wrap(call.call, async () => {
        throw new Stop('secret_refresh_unsupported', 'incompatible')
      })
    },
    exchange(_request: unknown, call: ActionContext): Promise<Outcome<W.CredentialRefreshResult>> {
      return wrap(call.call, async () => {
        throw new Stop('secret_exchange_unsupported', 'incompatible')
      })
    },
    acceptCallback(
      _request: unknown,
      ingress: TrustedIngressContext,
    ): Promise<Outcome<W.SecretsAcceptCallbackResult>> {
      return wrap(ingress, async () => {
        throw new Stop('secret_callback_unsupported', 'incompatible')
      })
    },
    close(): Promise<void> {
      if (!closeTask) {
        ending.abort()
        closeTask = new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error('Secret broker did not drain')),
            Math.max(1, Math.min(settings.drainMs ?? 5000, 5000)),
          )
          Promise.allSettled([...pending]).then(() => {
            clearTimeout(deadline)
            disk.close()
            resolve()
          }, reject)
        })
      }
      return closeTask
    },
  }
}

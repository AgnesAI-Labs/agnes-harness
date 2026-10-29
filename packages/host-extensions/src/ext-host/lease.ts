import {
  checkManifest,
  ExtensionError,
  type ExtensionManifest,
  extEventType,
  type LeaseView,
} from '@agnes/extension-api'
import { inspectJsonData, isDateTime, validateAgainst } from '@agnes/protocol'
import { Capabilities } from '@agnes/protocol/gen/extension-manifest'

type Options = {
  extId: string
  expiresAt: string
  scope: LeaseView['scope']
  budget: number
  clock?: () => number
}

// A row-bound lease has no expiry of its own: it ends when its row is unloaded. The lease class
// still wants a deadline, so it is set past any process lifetime.
export const ROW_BOUND_LEASE_TTL_MS = 100 * 365 * 24 * 3600_000

export class Lease {
  private remaining: number
  private readonly clock: () => number
  private readonly deadline: number
  private readonly scope: LeaseView['scope']
  private reason: string | null = null
  private readonly extId: string
  private readonly expiresAt: string

  constructor(options: Options) {
    const { extId, expiresAt, scope: inputScope, budget, clock } = options
    extEventType(extId, 'lease')
    this.extId = extId
    this.expiresAt = expiresAt
    if (!isDateTime(expiresAt)) this.fail('invalid lease configuration')
    const deadline = Date.parse(expiresAt)
    if (
      !Number.isFinite(deadline) ||
      !(budget === Infinity || (Number.isSafeInteger(budget) && budget >= 0))
    ) {
      this.fail('invalid lease configuration')
    }
    const inspected = inspectJsonData(inputScope)
    if (
      !inspected.ok ||
      !inspected.value ||
      typeof inspected.value !== 'object' ||
      Array.isArray(inspected.value)
    )
      this.fail('invalid lease scope')
    const scope = inspected.value
    if (
      Object.keys(scope).some(
        (key) => !['events', 'slots', 'toolPrefix', 'services', 'projections'].includes(key),
      ) ||
      !validateAgainst(Capabilities, {
        ...(scope.events !== undefined ? { events: scope.events } : {}),
        ...(scope.slots !== undefined ? { slots: scope.slots } : {}),
        ...(scope.toolPrefix !== undefined ? { tools: { prefix: scope.toolPrefix } } : {}),
      }).ok
    )
      this.fail('invalid lease scope')
    for (const key of ['services', 'projections'] as const) {
      const names = scope[key]
      if (
        names !== undefined &&
        (!Array.isArray(names) ||
          new Set(names).size !== names.length ||
          names.some(
            (name) =>
              typeof name !== 'string' ||
              name.length > 128 ||
              !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(name),
          ))
      )
        this.fail('invalid lease scope')
      if (Array.isArray(names)) Object.freeze(names)
    }
    this.scope = scope as LeaseView['scope']
    if (this.scope.slots) Object.freeze(this.scope.slots)
    Object.freeze(this.scope)
    this.deadline = deadline
    this.remaining = budget
    this.clock = clock ?? (() => Date.now())
  }

  private fail(message: string): never {
    throw new ExtensionError('E_LEASE_EXPIRED', message, { extId: this.extId })
  }
  get revoked(): string | null {
    return this.reason
  }

  view(): LeaseView {
    return Object.freeze({
      expiresAt: this.expiresAt,
      scope: this.scope,
      budget: Object.freeze({ remaining: this.remaining }),
    })
  }

  assertAlive(_operation: 'register' | 'execute'): void {
    this.assertInvocationAlive()
    if (this.remaining <= 0) this.fail('lease budget exhausted')
  }

  /** An admitted invocation may consume its last credit; time and revocation still apply. */
  assertInvocationAlive(): void {
    const now = this.clock()
    if (this.reason !== null) this.fail('lease revoked')
    if (!Number.isFinite(now) || now >= this.deadline) this.fail('lease expired')
  }

  consume(): void {
    this.assertAlive('execute')
    if (this.remaining !== Infinity) this.remaining--
  }

  revoke(reason: string): void {
    this.reason ??= reason
  }

  allows(kind: 'event' | 'slot' | 'toolPrefix' | 'service' | 'projection', value: string): boolean {
    if (typeof value !== 'string' || !['event', 'slot', 'toolPrefix', 'service', 'projection'].includes(kind))
      return false
    try {
      this.assertAlive('register')
    } catch {
      return false
    }
    if (kind === 'service') return this.scope.services?.includes(value) ?? false
    if (kind === 'projection') return this.scope.projections?.includes(value) ?? false
    if (kind === 'event') return this.scope.events === true
    if (kind === 'slot') return this.scope.slots?.includes(value) ?? false
    return this.scope.toolPrefix !== undefined && value.startsWith(this.scope.toolPrefix)
  }
}

export function leaseFor(
  manifest: ExtensionManifest,
  options: { ttlMs: number; now: number; clock?: () => number },
): Lease {
  const inspected = inspectJsonData(manifest)
  if (!inspected.ok) throw new ExtensionError('E_LEASE_EXPIRED', 'invalid lease manifest')
  const checkedManifest = inspected.value as ExtensionManifest
  if (
    !checkManifest(checkedManifest).ok ||
    !Number.isFinite(options.now) ||
    !Number.isSafeInteger(options.ttlMs) ||
    options.ttlMs <= 0 ||
    !Number.isFinite(options.now + options.ttlMs)
  ) {
    throw new ExtensionError('E_LEASE_EXPIRED', 'invalid lease configuration')
  }
  const deadline = new Date(options.now + options.ttlMs)
  if (!Number.isFinite(deadline.getTime()))
    throw new ExtensionError('E_LEASE_EXPIRED', 'invalid lease deadline')
  const c = checkedManifest.capabilities
  return new Lease({
    extId: checkedManifest.id,
    expiresAt: deadline.toISOString(),
    scope: {
      ...(c.services ? { services: c.services.map((item) => item.name) } : {}),
      ...(c.projections ? { projections: c.projections.map((item) => item.name) } : {}),
      ...(c.events !== undefined ? { events: c.events } : {}),
      ...(c.slots ? { slots: c.slots } : {}),
      ...(c.tools ? { toolPrefix: c.tools.prefix } : {}),
    },
    budget: checkedManifest.lease?.budget ?? Infinity,
    ...(options.clock ? { clock: options.clock } : {}),
  })
}

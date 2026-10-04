import { RuntimeError, readRuntimeIdentity } from './ownership.js'
import type {
  RuntimeDescriptor,
  RuntimeFactory,
  RuntimeIdentity,
  RuntimeLease,
  RuntimeRegistration,
  RuntimeSession,
} from './types.js'

type Entry<Context, Session extends RuntimeSession> = {
  descriptor: RuntimeDescriptor
  generation: number
  open: (context: Context) => Promise<Session>
  active: boolean
  leases: number
  drained: Promise<void>
  finish(): void
}

const identityKey = (owner: RuntimeIdentity): string => JSON.stringify([owner.id, owner.version])

/**
 * Exact-version factory registry. Static registration and future trusted plugin registration use
 * the same lifecycle; this registry does not discover, import, authorize, or sandbox plugin code.
 */
export class RuntimeRegistry<OpenContext, Session extends RuntimeSession = RuntimeSession> {
  private readonly entries = new Map<string, Entry<OpenContext, Session>>()
  private nextGeneration = 0

  register(factory: RuntimeFactory<OpenContext, Session>): RuntimeRegistration {
    const input = factory.descriptor
    const owner = readRuntimeIdentity({ id: input.id, version: input.version })
    if (input.apiVersion !== 1)
      throw new RuntimeError('E_RUNTIME_API_VERSION', `unsupported runtime API version: ${input.apiVersion}`)
    const key = identityKey(owner)
    if (this.entries.has(key))
      throw new RuntimeError(
        'E_RUNTIME_REGISTERED',
        `runtime ${owner.id}@${owner.version} is already registered`,
      )
    const descriptor: RuntimeDescriptor = Object.freeze({
      ...input,
      capabilities: Object.freeze({ ...input.capabilities }),
    })
    let finish!: () => void
    const drained = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry: Entry<OpenContext, Session> = {
      descriptor,
      generation: ++this.nextGeneration,
      open: factory.open.bind(factory),
      active: true,
      leases: 0,
      drained,
      finish,
    }
    this.entries.set(key, entry)
    return Object.freeze({
      descriptor,
      generation: entry.generation,
      retire: () => {
        if (!entry.active) return
        entry.active = false
        if (this.entries.get(key) === entry) this.entries.delete(key)
        if (entry.leases === 0) entry.finish()
      },
      whenDrained: () => entry.drained,
    })
  }

  /** Includes unavailable registrations so clients can explain an unavailable choice. */
  list(): readonly RuntimeDescriptor[] {
    return Object.freeze([...this.entries.values()].map((entry) => entry.descriptor))
  }

  /** Admit one opening. No missing owner or unsupported version falls back to Native. */
  acquire(owner: RuntimeIdentity): RuntimeLease<OpenContext, Session> {
    const entry = this.entries.get(identityKey(owner))
    if (!entry?.descriptor.available)
      throw new RuntimeError(
        'E_RUNTIME_UNAVAILABLE',
        entry?.descriptor.unavailableReason ?? `runtime ${owner.id}@${owner.version} is unavailable`,
      )
    entry.leases++
    let released = false
    let opened = false
    let pending = false
    return Object.freeze({
      descriptor: entry.descriptor,
      generation: entry.generation,
      open: async (context: OpenContext) => {
        if (released || opened)
          throw new RuntimeError(
            'E_RUNTIME_LEASE',
            'runtime lease is released or has already opened a session',
          )
        opened = true
        pending = true
        try {
          return await entry.open(context)
        } finally {
          pending = false
        }
      },
      release: () => {
        if (released) return
        if (pending) throw new RuntimeError('E_RUNTIME_LEASE', 'cannot release a pending runtime opening')
        released = true
        entry.leases--
        if (!entry.active && entry.leases === 0) entry.finish()
      },
    })
  }
}

import type { ToolContext } from '@agnes/extension-api'
import type { RejectedBeforeEffectError } from './tool-dispatch.js'

/**
 * Process-local proof, owned by one admitted tool context, that a call failed before any effect.
 * Only Core and Host-owned ports can mint it: plugins never reach the scope, so an error code a
 * plugin throws is never read as proof. Every controlled port on the context starts an effect when
 * it is used, so a refusal counts only when nothing else had started before or during it.
 */
const contexts = new WeakMap<ToolContext, ToolEffectScope>()
export class ToolEffectScope {
  private readonly refused = new WeakMap<object, { diagnostic: RejectedBeforeEffectError; safe: boolean }>()
  private started = false
  private writes = 0
  beginEffect(): void {
    this.started = true
  }
  reject(diagnostic: RejectedBeforeEffectError): never {
    const error = Object.assign(new Error(diagnostic.message), { code: diagnostic.code })
    this.refused.set(error, { diagnostic, safe: !this.started && this.writes === 1 })
    throw error
  }
  read(error: unknown): RejectedBeforeEffectError | undefined {
    const proof = error && typeof error === 'object' ? this.refused.get(error) : undefined
    return proof?.safe && !this.started && this.writes === 0 ? proof.diagnostic : undefined
  }
  async write<T>(run: () => Promise<T>): Promise<T> {
    this.writes++
    try {
      const result = await run()
      this.beginEffect()
      return result
    } catch (error) {
      if (!error || typeof error !== 'object' || !this.refused.has(error)) this.beginEffect()
      throw error
    } finally {
      this.writes--
    }
  }
  /**
   * One request through a Host-owned port. `refusedBeforeEffect` is the port's own judgement of the
   * error it received (for example a daemon's parameter refusal); it is trusted only for a request
   * that ran while nothing else had started. Anything else marks the call as having had an effect.
   */
  async port<T>(
    run: () => Promise<T>,
    refusedBeforeEffect: (error: unknown) => RejectedBeforeEffectError | undefined,
  ): Promise<T> {
    const clean = !this.started && this.writes === 0
    this.writes++
    try {
      const value = await run()
      this.beginEffect()
      return value
    } catch (error) {
      const diagnostic = clean && !this.started ? refusedBeforeEffect(error) : undefined
      if (!diagnostic) {
        this.beginEffect()
        throw error
      }
      const refusal = Object.assign(new Error(diagnostic.message), { code: diagnostic.code })
      this.refused.set(refusal, { diagnostic, safe: true })
      throw refusal
    } finally {
      this.writes--
    }
  }
  /** Other controlled operations invalidate no-effect proof before they start, including failures. */
  guard<T extends object>(port: T, keys?: readonly string[]): T {
    const guarded = { ...port }
    for (const key of Object.keys(port)) {
      const handler = port[key as keyof T]
      if (typeof handler !== 'function' || (keys && !keys.includes(key))) continue
      Object.defineProperty(guarded, key, {
        enumerable: true,
        value: (...args: unknown[]) => {
          this.beginEffect()
          return Reflect.apply(handler, port, args)
        },
      })
    }
    return guarded
  }
  bind(context: ToolContext): ToolContext {
    contexts.set(context, this)
    return context
  }
}
export function attestedRejection(
  context: ToolContext,
  error: unknown,
): RejectedBeforeEffectError | undefined {
  return contexts.get(context)?.read(error)
}

/**
 * Host-only: runs one request of a Host-owned port bound to `context`. When the port can show the
 * request was refused before anything happened, the error it rethrows lets Core settle the call as a
 * definite failure instead of asking whether it happened. Without a scope it simply runs.
 */
export function hostPortRequest<T>(
  context: ToolContext,
  run: () => Promise<T>,
  refusedBeforeEffect: (error: unknown) => RejectedBeforeEffectError | undefined,
): Promise<T> {
  const scope = contexts.get(context)
  return scope ? scope.port(run, refusedBeforeEffect) : run()
}

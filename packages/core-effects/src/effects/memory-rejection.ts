import type { ToolContext } from '@agnes/extension-api'
import type { RejectedBeforeEffectError } from './tool-dispatch.js'

/** Process-local proof owned by one admitted context, never a plugin diagnostic or error code. */
const contexts = new WeakMap<ToolContext, MemoryEffectScope>()
export class MemoryEffectScope {
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
  async write(run: () => Promise<void>): Promise<void> {
    this.writes++
    try {
      await run()
      this.beginEffect()
    } catch (error) {
      if (!error || typeof error !== 'object' || !this.refused.has(error)) this.beginEffect()
      throw error
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
export function memoryRejection(context: ToolContext, error: unknown): RejectedBeforeEffectError | undefined {
  return contexts.get(context)?.read(error)
}

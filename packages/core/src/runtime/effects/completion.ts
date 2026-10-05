import { types } from 'node:util'
import type { LeafActionProvider } from '@agnes/extension-api/runtime'
import type { ActionFrame, EffectResult, RequestIdentity } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import type { AdmittedEffectAttempt, EffectsAuthority } from './authority.js'

export interface EffectCompletionCapture {
  readonly original: AdmittedEffectAttempt
  readonly result: EffectResult
  readonly completed: EffectResult
  readonly frame: ActionFrame
  readonly requestIdentity: RequestIdentity
  readonly dynamicCheck: () => void
  readonly staticCheck: () => void
}
const completed = new WeakMap<
  object,
  WeakMap<
    AdmittedEffectAttempt,
    {
      authority: EffectsAuthority
      capture: EffectCompletionCapture
    }
  >
>()
function refused(): never {
  throw new Error('Original effect completion source changed')
}
function own(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) refused()
  const d = Object.getOwnPropertyDescriptor(value, key)
  if (!d || !('value' in d)) refused()
  return d.value
}
function fixed(value: object, deep: boolean): () => void {
  const nodes: {
    value: object
    prototype: object | null
    keys: PropertyKey[]
    values: unknown[]
    descriptors: PropertyDescriptor[]
  }[] = []
  const seen = new Set<object>()
  function visit(v: object): void {
    if (types.isProxy(v) || seen.has(v)) refused()
    seen.add(v)
    const prototype = Object.getPrototypeOf(v)
    if (deep && prototype !== Object.prototype && prototype !== null && !Array.isArray(v)) refused()
    const keys = Reflect.ownKeys(v)
    const values = keys.map((key) => own(v, key))
    const descriptors = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)
      if (!descriptor || !('value' in descriptor)) refused()
      return descriptor
    })
    nodes.push({ value: v, prototype, keys, values, descriptors })
    if (deep)
      for (const child of values) {
        if (child !== null && typeof child === 'object') visit(child)
        else if (child !== null && !['number', 'boolean', 'string'].includes(typeof child)) refused()
      }
    seen.delete(v)
  }
  visit(value)
  return () => {
    for (const node of nodes) {
      if (types.isProxy(node.value) || Object.getPrototypeOf(node.value) !== node.prototype) refused()
      const keys = Reflect.ownKeys(node.value)
      if (keys.length !== node.keys.length) refused()
      for (let i = 0; i < keys.length; i++) {
        const key = node.keys[i],
          before = node.descriptors[i]
        if (key === undefined || !before || keys[i] !== key) refused()
        const after = Object.getOwnPropertyDescriptor(node.value, key)
        if (
          !after ||
          !('value' in after) ||
          !Object.is(after.value, node.values[i]) ||
          after.writable !== before.writable ||
          after.enumerable !== before.enumerable ||
          after.configurable !== before.configurable
        )
          refused()
      }
    }
  }
}
function selected(value: object, keys: readonly string[]): () => void {
  if (types.isProxy(value)) refused()
  const prototype = Object.getPrototypeOf(value)
  const descriptors = keys.map((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d || !('value' in d)) refused()
    return d
  })
  return () => {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) refused()
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i],
        before = descriptors[i]
      if (!key || !before) refused()
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (
        !d ||
        !('value' in d) ||
        !Object.is(d.value, before.value) ||
        d.configurable !== before.configurable ||
        d.enumerable !== before.enumerable ||
        d.writable !== before.writable
      )
        refused()
    }
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue
      freeze(own(value, key))
    }
    Object.freeze(value)
  }
  return value
}
interface EffectExecutionSource {
  readonly execute: LeafActionProvider['execute']
  readonly check: (() => void) | undefined
}
const executions = new WeakSet<object>()
/** Captures the actual one-time method selection without changing ordinary leaf invocation semantics. */
export function captureEffectExecution(
  leaf: LeafActionProvider,
  authority: EffectsAuthority,
  admitted: AdmittedEffectAttempt,
): EffectExecutionSource {
  const execute = leaf.execute
  let check: (() => void) | undefined
  try {
    const chain: { value: object; prototype: object | null; descriptor: PropertyDescriptor | undefined }[] =
      []
    let current: object | null = leaf
    while (current) {
      if (types.isProxy(current)) refused()
      const descriptor = Object.getOwnPropertyDescriptor(current, 'execute')
      const prototype = Object.getPrototypeOf(current)
      chain.push({ value: current, prototype, descriptor })
      if (descriptor) {
        if (
          !('value' in descriptor) ||
          descriptor.value !== execute ||
          typeof execute !== 'function' ||
          types.isProxy(execute)
        )
          refused()
        break
      }
      current = prototype
    }
    if (!current || admitted.leaf !== leaf) refused()
    const originalRelations = [
      fixed(admitted.frame, true),
      fixed(admitted.requestIdentity, true),
      fixed(authority, false),
      selected(admitted, ['original', 'attempt', 'requestIdentity', 'frame', 'context', 'leaf']),
      fixed(admitted.attempt, true),
      fixed(admitted.original, false),
      fixed(admitted.context, false),
      fixed(admitted.context.call, false),
      fixed(admitted.context.effects, false),
    ]
    check = () => {
      for (const relation of originalRelations) relation()
      for (const original of chain) {
        if (types.isProxy(original.value) || Object.getPrototypeOf(original.value) !== original.prototype)
          refused()
        const actual = Object.getOwnPropertyDescriptor(original.value, 'execute'),
          before = original.descriptor
        if (!before) {
          if (actual) refused()
          continue
        }
        if (
          !actual ||
          !('value' in actual) ||
          !Object.is(actual.value, before.value) ||
          actual.writable !== before.writable ||
          actual.configurable !== before.configurable ||
          actual.enumerable !== before.enumerable
        )
          refused()
      }
    }
  } catch {
    check = undefined
  }
  const source = Object.freeze({ execute, check })
  executions.add(source)
  return source
}
/** Internal dispatcher issuance; deliberately absent from the package public entry. */
export function recordEffectCompletion(
  authority: EffectsAuthority,
  admitted: AdmittedEffectAttempt,
  result: EffectResult,
  execution: EffectExecutionSource,
): void {
  try {
    if (!executions.has(execution) || !execution.check) return
    const checks = [
      execution.check,
      fixed(result, true),
      fixed(admitted.frame, true),
      fixed(admitted.requestIdentity, true),
      fixed(authority, false),
      selected(admitted, ['original', 'attempt', 'requestIdentity', 'frame', 'context', 'leaf']),
      fixed(admitted.attempt, true),
      fixed(admitted.original, false),
      fixed(admitted.context, false),
      fixed(admitted.context.call, false),
      fixed(admitted.context.effects, false),
      fixed(admitted.leaf, false),
    ]
    if (!validateRuntime('EffectResult', result).ok) refused()
    const body = freeze(structuredClone(result))
    const frame = freeze(structuredClone(admitted.frame))
    const requestIdentity = freeze(structuredClone(admitted.requestIdentity))
    const check = () => {
      for (const original of checks) original()
    }
    check()
    let occurrences = completed.get(result)
    if (!occurrences) {
      occurrences = new WeakMap()
      completed.set(result, occurrences)
    }
    if (occurrences.has(admitted)) refused()
    const capture = Object.freeze({
      original: admitted,
      result,
      completed: body,
      frame,
      requestIdentity,
      dynamicCheck: check,
      staticCheck: check,
    })
    occurrences.set(admitted, { authority, capture })
  } catch {
    // Missing private eligibility must never discard an ordinary original completed effect or its facts.
    return
  }
}
/** Reads genuine dispatcher evidence; it grants no execution, accounting or State membership authority. */
export function captureEffectCompletion(
  authority: EffectsAuthority,
  admitted: AdmittedEffectAttempt,
  result: EffectResult,
): EffectCompletionCapture | undefined {
  const original = completed.get(result)?.get(admitted)
  if (!original || original.authority !== authority) return undefined
  original.capture.staticCheck()
  return original.capture
}

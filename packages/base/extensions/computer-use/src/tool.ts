import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import {
  defineTool,
  type SessionRef,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from '@agnes/extension-api'
import {
  createRecentArtifactMetadataIndex,
  type RecentArtifactMetadataIndex,
  type RecentArtifactMetadataSnapshot,
} from '../../artifacts-local/src/recent-metadata.js'
import type {
  ComputerUseBackend,
  ComputerUseBackendProvider,
  ComputerUseCaptureResult,
  ComputerUseTarget,
} from './backend.js'
import { bindStickySnapshot, exactCaptureArgs, targetMatchesApp } from './cua-backend.js'
import { parseActionResult, parseCaptureResult, parseListingResult } from './parse.js'
import { validateComputerUseRuntimePolicy } from './policy.js'
import { actionToolResult, captureToolResult, refusalToolResult } from './result.js'
import {
  classifyComputerUse,
  isInputAction,
  isStateChanging,
  normalizeComputerUseArgs,
  rejectUnsafe,
} from './safety.js'
import {
  COMPUTER_USE_ACTIONS,
  COMPUTER_USE_DESCRIPTION,
  type ComputerUseArgs,
  ComputerUseParams,
} from './schema.js'

const ACTIONS = new Set<string>(COMPUTER_USE_ACTIONS)
const MODIFIER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll'])
const SUGGESTIONS: Readonly<Record<string, string>> = {
  hotkey: 'key',
  press_key: 'key',
  keypress: 'key',
  key_combo: 'key',
  shortcut: 'key',
  type_text: 'type',
  input_text: 'type',
  screenshot: 'capture',
  get_window_state: 'capture',
  left_click: 'click',
  mouse_click: 'click',
}

class CallLock {
  private tail: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>, signal: AbortSignal, cancelled: () => T): Promise<T> {
    let release: () => void = () => undefined
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = next
    return new Promise<T>((resolve, reject) => {
      let waiting = true
      let callerSettled = false
      const settleCancelled = (): void => {
        if (!waiting || callerSettled) return
        callerSettled = true
        resolve(cancelled())
      }
      signal.addEventListener('abort', settleCancelled, { once: true })
      if (signal.aborted) settleCancelled()
      void previous.then(async () => {
        waiting = false
        signal.removeEventListener('abort', settleCancelled)
        if (callerSettled || signal.aborted) {
          if (!callerSettled) resolve(cancelled())
          release()
          return
        }
        try {
          resolve(await fn())
        } catch (error) {
          reject(error)
        } finally {
          release()
        }
      })
    })
  }
}

type DedupState = { digest: string; target: string; streak: number }
type LifecycleToken = Readonly<{
  globalGeneration: number
  metadataSessionKey: string
  sessionGeneration: number
}>
type RuntimeState = {
  metadataSessionKey: string
  generation: number
  runtimePolicyIdentity: string
  target: ComputerUseTarget | undefined
  /** Exact pid/window pairs from the latest successful list_windows in this runtime generation. */
  discoveredWindows: Set<string> | undefined
  elementIndexes: Set<number>
  tokens: Map<number, string>
  safety: ComputerUseCaptureResult['safety'] | undefined
  dedup: DedupState | undefined
  dedupEpoch: number
  lock: CallLock
}

export type ComputerUseToolOptions = Readonly<{
  captureAfterMode?: 'som' | 'vision' | 'ax'
  /** Host production policy: close every successful mutation/targeted wait with an observation. */
  autoCaptureAfterActions?: boolean
  maxImageDimension?: number
  maxBytesPerImage?: number
  maxCapturesPerHour?: number
  maxRecentPerSession?: number
  clock?: () => number
}>

function stateKey(session: SessionRef, profileHash: string): string {
  return `${session.key.length}:${session.key}${session.lane.length}:${session.lane}${profileHash.length}:${profileHash}`
}

function sessionStatePrefix(session: SessionRef): string {
  return `${session.key.length}:${session.key}${session.lane.length}:${session.lane}`
}

function metadataSessionKey(session: SessionRef): string {
  // The metadata index intentionally bounds its opaque key. Hash the length-delimited canonical
  // tuple so a maximum-size session key and a distinct lane stay isolated without exceeding it.
  return `computer-use:${createHash('sha256').update(sessionStatePrefix(session)).digest('hex')}`
}

function targetIdentity(target: ComputerUseTarget): string {
  return JSON.stringify([target.app ?? null, target.pid ?? null, target.windowId ?? null])
}

function windowIdentity(pid: number, windowId: number): string {
  return `${pid}:${windowId}`
}

function discoveredWindowIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return undefined
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const pid = descriptors.pid
  const windowId = descriptors.window_id ?? descriptors.windowId
  if (
    !pid?.enumerable ||
    !Object.hasOwn(pid, 'value') ||
    !Number.isSafeInteger(pid.value) ||
    pid.value <= 0 ||
    !windowId?.enumerable ||
    !Object.hasOwn(windowId, 'value') ||
    !Number.isSafeInteger(windowId.value) ||
    windowId.value <= 0
  )
    return undefined
  return windowIdentity(pid.value as number, windowId.value as number)
}

function secureSurface(state: RuntimeState): string | undefined {
  if (state.safety?.reliable !== true) return undefined
  return [
    ['secureInput', 'secure input or password surface'],
    ['payment', 'payment surface'],
    ['twoFactor', 'two-factor authentication surface'],
    ['systemPermission', 'system permission surface'],
  ].find(([field]) => state.safety?.[field as keyof typeof state.safety])?.[1]
}

function modifierRefusal(
  args: Readonly<ComputerUseArgs>,
  modifierActions: ComputerUseBackend['modifierActions'],
): ToolResult | undefined {
  if (!args.modifiers?.length) return undefined
  if (!modifierActions.includes(args.action as ComputerUseBackend['modifierActions'][number]))
    return refusalToolResult(
      'modifiers_unsupported',
      `This driver cannot preserve modifiers for ${args.action}; the action was not sent.`,
    )
  return undefined
}

function resetObservation(state: RuntimeState, target?: ComputerUseTarget): void {
  state.target = target
  state.discoveredWindows = undefined
  state.elementIndexes.clear()
  state.tokens.clear()
  state.safety = undefined
  state.dedup = undefined
  state.dedupEpoch += 1
}

/** A replacement capture makes every prior snapshot capability stale even if that capture fails. */
function invalidateSnapshot(state: RuntimeState): void {
  state.target = undefined
  state.elementIndexes.clear()
  state.tokens.clear()
  state.safety = undefined
}

function staleElementRefusal(args: Readonly<ComputerUseArgs>, state: RuntimeState): ToolResult | undefined {
  const indexes = [args.element, args.from_element, args.to_element].filter(
    (index): index is number => index !== undefined,
  )
  const stale = indexes.find((index) => !state.elementIndexes.has(index))
  return stale === undefined
    ? undefined
    : refusalToolResult(
        'stale_element',
        `element ${stale} is not present in the latest successful capture; capture again before input`,
      )
}

function staleWindowRefusal(args: Readonly<ComputerUseArgs>, state: RuntimeState): ToolResult | undefined {
  if (args.action !== 'capture' || args.pid === undefined || args.window_id === undefined) return undefined
  const identity = windowIdentity(args.pid, args.window_id)
  if (state.discoveredWindows !== undefined) {
    if (state.discoveredWindows.has(identity)) return undefined
    return refusalToolResult(
      'stale_window_reference',
      'The requested pid/window_id is absent from the latest list_windows result. Do not reuse a window from earlier conversation history; list windows again or ask the user to open the application.',
    )
  }
  if (state.target?.pid === args.pid && state.target.windowId === args.window_id) return undefined
  return refusalToolResult(
    'window_discovery_required',
    'Exact pid/window_id capture requires a current list_windows result from this runtime generation.',
  )
}

function validateActionArgs(args: Readonly<ComputerUseArgs>): ToolResult | undefined {
  if (args.action === 'capture' && args.window_id !== undefined && args.pid === undefined)
    return refusalToolResult(
      'invalid_window_target',
      'capture window_id requires pid from the same window discovery result',
    )
  if (['click', 'double_click', 'right_click', 'middle_click'].includes(args.action)) {
    const targets = Number(args.element !== undefined) + Number(args.coordinate !== undefined)
    if (targets !== 1)
      return refusalToolResult(
        'invalid_point_target',
        `${args.action} requires exactly one of element or coordinate`,
      )
  }
  if (args.action === 'drag') {
    const elementFields = Number(args.from_element !== undefined) + Number(args.to_element !== undefined)
    const coordinateFields =
      Number(args.from_coordinate !== undefined) + Number(args.to_coordinate !== undefined)
    if (!((elementFields === 2 && coordinateFields === 0) || (elementFields === 0 && coordinateFields === 2)))
      return refusalToolResult(
        'invalid_drag_target',
        'drag requires exactly one complete from_element/to_element or from_coordinate/to_coordinate pair',
      )
  }
  if (args.action === 'scroll' && args.element !== undefined && args.coordinate !== undefined)
    return refusalToolResult('invalid_scroll_target', 'scroll accepts at most one of element or coordinate')
  if (
    (args.action === 'type' || args.action === 'key') &&
    args.element !== undefined &&
    args.coordinate !== undefined
  )
    return refusalToolResult(
      'invalid_input_target',
      `${args.action} accepts at most one of element or coordinate`,
    )
  if (args.action === 'type' && args.text === undefined)
    return refusalToolResult('missing_text', 'type requires text')
  if (args.action === 'key' && !args.keys?.trim())
    return refusalToolResult('missing_keys', 'key requires a non-empty key or key combination')
  if (args.action === 'set_value' && args.element === undefined)
    return refusalToolResult('missing_element', 'set_value requires an element from the latest capture')
  if (args.action === 'set_value' && args.value === undefined)
    return refusalToolResult('missing_value', 'set_value requires value')
  if ((args.action === 'focus_app' || args.action === 'launch_app') && !args.app?.trim())
    return refusalToolResult('missing_app', `${args.action} requires app`)
  return undefined
}

function updateCaptureState(state: RuntimeState, capture: ComputerUseCaptureResult): void {
  state.target = capture.target
  state.safety = capture.safety
  state.elementIndexes = new Set(capture.elements.map((element) => element.index))
  state.tokens = new Map(
    capture.elements.flatMap((element) =>
      element.elementToken ? ([[element.index, element.elementToken]] as const) : [],
    ),
  )
}

function nextDedupState(
  state: RuntimeState,
  capture: ComputerUseCaptureResult,
): { omitImage: boolean; next: DedupState | undefined } {
  if (!capture.image) {
    return { omitImage: false, next: undefined }
  }
  const identity = targetIdentity(capture.target)
  const prior = state.dedup
  if (prior?.digest === capture.image.digest && prior.target === identity && prior.streak < 2) {
    return { omitImage: true, next: { ...prior, streak: prior.streak + 1 } }
  }
  return {
    omitImage: false,
    next: { digest: capture.image.digest, target: identity, streak: 0 },
  }
}

async function presentCapture(
  state: RuntimeState,
  capture: ComputerUseCaptureResult,
  ctx: ToolContext,
  recentArtifacts: RecentArtifactMetadataIndex,
  operationEpoch: number,
  lifecycleCurrent: () => boolean,
): Promise<ToolResult | undefined> {
  if (!lifecycleCurrent()) return undefined
  // Artifact spill/media preflight can fail. Commit target/token/dedup only after the exact result
  // the model will receive has been built, otherwise a retry could omit pixels never delivered.
  const dedup = nextDedupState(state, capture)
  const result = await captureToolResult(capture, ctx, { omitImage: dedup.omitImage })
  if (!lifecycleCurrent()) return undefined
  // Metadata identity collisions fail the presentation before target/token state is committed.
  // Compaction/session teardown that won the await race must not be repopulated by this capture.
  if (state.dedupEpoch === operationEpoch && capture.image)
    recentArtifacts.record(state.metadataSessionKey, capture.image.ref)
  updateCaptureState(state, capture)
  // Compaction can run while artifact spill is awaiting I/O. Its reset wins over this older
  // capture, so the first capture started after compaction must carry pixels again.
  if (state.dedupEpoch === operationEpoch) {
    // The recent window is advisory only: neither it nor dedup retains or deletes artifact bytes.
    state.dedup = dedup.next
  }
  return result
}

function listingResult(action: 'list_apps' | 'list_windows', items: readonly unknown[]): ToolResult {
  const key = action === 'list_apps' ? 'apps' : 'windows'
  const structured = { ok: true, action, [key]: items, count: items.length }
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
}

function unknownAction(action: string): ToolResult {
  const suggestion = SUGGESTIONS[action]
  return refusalToolResult(
    'unknown_action',
    suggestion
      ? `Unknown action ${JSON.stringify(action)}; did you mean ${JSON.stringify(suggestion)}? See the action enum.`
      : `Unknown action ${JSON.stringify(action)}; see the action enum.`,
  )
}

function cancelledBeforeDispatch(): ToolResult {
  return refusalToolResult(
    'request_cancelled',
    'Computer Use request was cancelled before dispatch; the action was not sent.',
  )
}

function snapshotModifierActions(value: unknown): ComputerUseBackend['modifierActions'] | undefined {
  if (!Array.isArray(value) || isProxy(value)) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return undefined
  const snapshot: ComputerUseBackend['modifierActions'][number][] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      !MODIFIER_ACTIONS.has(descriptor.value)
    )
      return undefined
    snapshot.push(descriptor.value as ComputerUseBackend['modifierActions'][number])
  }
  return Object.freeze(snapshot)
}

export class ComputerUseToolRuntime {
  private readonly states = new Map<string, RuntimeState>()
  private readonly sessionGenerations = new Map<string, number>()
  private globalGeneration = 0
  private readonly captureHistory = new Map<string, { lastNow: number; timestamps: number[] }>()
  private readonly maxCapturesPerHour: number
  private readonly maxImageDimension: number
  private readonly maxBytesPerImage: number
  private readonly recentArtifacts: RecentArtifactMetadataIndex
  private readonly clock: () => number
  readonly tool: ToolDef<typeof ComputerUseParams>

  constructor(
    private readonly provider: ComputerUseBackendProvider,
    private readonly options: ComputerUseToolOptions = {},
    recentArtifacts?: RecentArtifactMetadataIndex,
  ) {
    const maxImageDimension = options.maxImageDimension ?? 1456
    const maxBytesPerImage = options.maxBytesPerImage ?? 4 * 1024 * 1024
    const maxCapturesPerHour = options.maxCapturesPerHour ?? 120
    const maxRecentPerSession = options.maxRecentPerSession ?? 100
    if (options.autoCaptureAfterActions !== undefined && typeof options.autoCaptureAfterActions !== 'boolean')
      throw new TypeError('Computer Use autoCaptureAfterActions must be boolean')
    if (!Number.isSafeInteger(maxImageDimension) || maxImageDimension < 8 || maxImageDimension > 1456)
      throw new TypeError('Computer Use maxImageDimension must be an integer from 8 to 1456')
    if (
      !Number.isSafeInteger(maxBytesPerImage) ||
      maxBytesPerImage < 1024 ||
      maxBytesPerImage > 4 * 1024 * 1024
    )
      throw new TypeError('Computer Use maxBytesPerImage must be an integer from 1024 to 4194304')
    if (!Number.isSafeInteger(maxCapturesPerHour) || maxCapturesPerHour < 1 || maxCapturesPerHour > 120)
      throw new TypeError('Computer Use maxCapturesPerHour must be an integer from 1 to 120')
    if (!Number.isSafeInteger(maxRecentPerSession) || maxRecentPerSession < 1 || maxRecentPerSession > 100)
      throw new TypeError('Computer Use maxRecentPerSession must be an integer from 1 to 100')
    if (options.clock !== undefined && typeof options.clock !== 'function')
      throw new TypeError('Computer Use clock must be a function')
    this.maxImageDimension = maxImageDimension
    this.maxBytesPerImage = maxBytesPerImage
    this.maxCapturesPerHour = maxCapturesPerHour
    this.recentArtifacts = recentArtifacts ?? createRecentArtifactMetadataIndex(maxRecentPerSession)
    this.clock = options.clock ?? Date.now
    this.tool = defineTool({
      name: 'computer_use',
      description: COMPUTER_USE_DESCRIPTION,
      parameters: ComputerUseParams,
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: true,
        replay: 'never',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: 'destructive',
      },
      policyVersion: 'computer-use-v1',
      classify: classifyComputerUse,
      execute: (args, ctx) => this.execute(args, ctx),
    })
  }

  clear(): void {
    this.globalGeneration += 1
    this.sessionGenerations.clear()
    this.captureHistory.clear()
    const metadataKeys = new Set<string>()
    for (const state of this.states.values()) {
      state.dedupEpoch += 1
      metadataKeys.add(state.metadataSessionKey)
    }
    for (const key of metadataKeys) this.recentArtifacts.resetSession(key)
    this.states.clear()
  }

  resetScreenshotDedup(session: SessionRef): void {
    const prefix = sessionStatePrefix(session)
    this.recentArtifacts.resetForCompaction(metadataSessionKey(session))
    for (const [key, state] of this.states)
      if (key.startsWith(prefix)) {
        state.dedup = undefined
        state.dedupEpoch += 1
      }
  }

  resetSession(session: SessionRef): void {
    const prefix = sessionStatePrefix(session)
    const metadataKey = metadataSessionKey(session)
    this.sessionGenerations.set(metadataKey, (this.sessionGenerations.get(metadataKey) ?? 0) + 1)
    this.recentArtifacts.resetSession(metadataKey)
    this.captureHistory.delete(metadataKey)
    for (const [key, state] of this.states)
      if (key.startsWith(prefix)) {
        state.dedupEpoch += 1
        this.states.delete(key)
      }
  }

  recentArtifactMetadata(session: SessionRef): RecentArtifactMetadataSnapshot {
    return this.recentArtifacts.snapshot(metadataSessionKey(session))
  }

  private lifecycleToken(session: SessionRef): LifecycleToken {
    const metadataKey = metadataSessionKey(session)
    return Object.freeze({
      globalGeneration: this.globalGeneration,
      metadataSessionKey: metadataKey,
      sessionGeneration: this.sessionGenerations.get(metadataKey) ?? 0,
    })
  }

  private isLifecycleCurrent(token: LifecycleToken): boolean {
    return (
      token.globalGeneration === this.globalGeneration &&
      token.sessionGeneration === (this.sessionGenerations.get(token.metadataSessionKey) ?? 0)
    )
  }

  private reserveCapture(session: SessionRef): boolean {
    const key = metadataSessionKey(session)
    const now = this.clock()
    if (!Number.isSafeInteger(now) || now < 0) return false
    const prior = this.captureHistory.get(key)
    if (prior && now < prior.lastNow) return false
    const timestamps = (prior?.timestamps ?? []).filter((at) => at > now - 60 * 60_000)
    if (timestamps.length >= this.maxCapturesPerHour) {
      this.captureHistory.set(key, { lastNow: now, timestamps })
      return false
    }
    timestamps.push(now)
    this.captureHistory.set(key, { lastNow: now, timestamps })
    return true
  }

  private state(
    session: SessionRef,
    profileHash: string,
    generation: number,
    runtimePolicyIdentity: string,
  ): RuntimeState {
    const key = stateKey(session, profileHash)
    let state = this.states.get(key)
    if (!state) {
      state = {
        metadataSessionKey: metadataSessionKey(session),
        generation,
        runtimePolicyIdentity,
        target: undefined,
        discoveredWindows: undefined,
        elementIndexes: new Set(),
        tokens: new Map(),
        safety: undefined,
        dedup: undefined,
        dedupEpoch: 0,
        lock: new CallLock(),
      }
      this.states.set(key, state)
    }
    return state
  }

  private async execute(args: ComputerUseArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!ACTIONS.has(args.action)) return unknownAction(args.action)
    const unsafe = rejectUnsafe(args)
    if (unsafe) return refusalToolResult(unsafe.code, unsafe.message)
    const invalid = validateActionArgs(args)
    if (invalid) return invalid

    const lifecycle = this.lifecycleToken(ctx.session)
    let backend: ComputerUseBackend
    try {
      backend = await this.provider.acquire(ctx.session, ctx.signal)
    } catch (error) {
      if (ctx.signal.aborted) return cancelledBeforeDispatch()
      if (!this.isLifecycleCurrent(lifecycle))
        return refusalToolResult(
          'session_lifecycle_changed',
          'Computer Use session lifecycle changed before dispatch; the action was not sent.',
        )
      throw error
    }
    if (ctx.signal.aborted) return cancelledBeforeDispatch()
    if (!this.isLifecycleCurrent(lifecycle))
      return refusalToolResult(
        'session_lifecycle_changed',
        'Computer Use session lifecycle changed before dispatch; the action was not sent.',
      )
    // Backend objects cross a Host-private trust boundary. Snapshot identity once so accessors or
    // later mutation cannot make validation, generation reconciliation and state lookup disagree.
    let profileHash: unknown
    let generation: unknown
    let runtimePolicyValue: unknown
    let requiresReliableSafety: unknown
    let modifierActionsValue: unknown
    let backendCall: ComputerUseBackend['call']
    try {
      profileHash = backend.profileHash
      generation = backend.generation
      runtimePolicyValue = backend.runtimePolicy
      requiresReliableSafety = backend.requiresReliableSafety
      modifierActionsValue = backend.modifierActions
      backendCall = backend.call
    } catch (error) {
      if (ctx.signal.aborted) return cancelledBeforeDispatch()
      throw error
    }
    if (ctx.signal.aborted) return cancelledBeforeDispatch()
    const modifierActions = snapshotModifierActions(modifierActionsValue)
    if (
      typeof profileHash !== 'string' ||
      !profileHash ||
      !Number.isSafeInteger(generation) ||
      (generation as number) < 0 ||
      (requiresReliableSafety !== undefined && requiresReliableSafety !== true) ||
      !modifierActions ||
      typeof backendCall !== 'function' ||
      isProxy(backendCall)
    )
      throw new TypeError('computer_use backend identity is invalid')
    const dispatchBackend = (...callArgs: Parameters<ComputerUseBackend['call']>) =>
      Reflect.apply(backendCall, backend, callArgs) as ReturnType<ComputerUseBackend['call']>
    const runtimePolicy = validateComputerUseRuntimePolicy(runtimePolicyValue, ctx.session)
    if ('code' in runtimePolicy) return refusalToolResult(runtimePolicy.code, runtimePolicy.message)
    const backendGeneration = generation as number
    const state = this.state(ctx.session, profileHash, backendGeneration, runtimePolicy.identity)
    const runWithCancellation = (fn: () => Promise<ToolResult>): Promise<ToolResult> =>
      state.lock.run<ToolResult>(fn, ctx.signal, cancelledBeforeDispatch)
    return runWithCancellation(async () => {
      // Acquisition happens before the per-session lock. A queued request may be cancelled while an
      // earlier action is still running; never rely on a backend to reject an already-aborted signal.
      if (ctx.signal.aborted) return cancelledBeforeDispatch()
      if (!this.isLifecycleCurrent(lifecycle))
        return refusalToolResult(
          'session_lifecycle_changed',
          'Computer Use session lifecycle changed before dispatch; the action was not sent.',
        )
      // Generation reconciliation belongs under the call lock. Resetting before an older call exits could let
      // that call repopulate the new generation with stale target/token state.
      if (backendGeneration < state.generation) {
        return refusalToolResult(
          'stale_runtime_generation',
          'Computer Use returned an older runtime generation; the action was not sent.',
        )
      }
      if (state.generation !== backendGeneration) {
        state.generation = backendGeneration
        state.runtimePolicyIdentity = runtimePolicy.identity
        resetObservation(state)
      } else if (state.runtimePolicyIdentity !== runtimePolicy.identity) {
        return refusalToolResult(
          'runtime_policy_drift',
          'Computer Use runtime policy changed without a new transport generation; the action was not sent.',
        )
      }
      const staleElement = staleElementRefusal(args, state)
      if (staleElement) return staleElement
      const staleWindow = staleWindowRefusal(args, state)
      if (staleWindow) return staleWindow
      const unsupported = modifierRefusal(args, modifierActions)
      if (unsupported) return unsupported
      if (isInputAction(args.action) && args.app && !targetMatchesApp(state.target, args.app))
        return refusalToolResult(
          'input_target_mismatch',
          `${args.action} would target ${JSON.stringify(state.target?.app)}, not ${JSON.stringify(args.app)}; capture or focus the requested app first.`,
        )
      if (isInputAction(args.action) && requiresReliableSafety === true && state.safety === undefined)
        return refusalToolResult(
          'safety_signal_missing',
          'Computer input is blocked until a fresh capture reliably classifies secure, payment, two-factor, and system-permission surfaces.',
        )
      if (isStateChanging(args.action)) {
        if (state.safety?.reliable === false)
          return refusalToolResult(
            'safety_signal_unreliable',
            'Computer input is blocked because the latest capture could not reliably classify secure, payment, two-factor, or system-permission surfaces. Capture again with accessibility data before input.',
          )
        const surface = secureSurface(state)
        if (surface)
          return refusalToolResult(
            'secure_surface_blocked',
            `Computer input is blocked because the reliable accessibility signal identifies a ${surface}.`,
          )
      }

      const normalized = normalizeComputerUseArgs(args)
      const call = bindStickySnapshot(normalized, state.target, state.tokens)
      const captureEpoch = state.dedupEpoch
      if (ctx.signal.aborted) return cancelledBeforeDispatch()
      if (args.action === 'capture' && !this.reserveCapture(ctx.session))
        return refusalToolResult(
          'capture_rate_limited',
          'Computer Use capture limit reached for this session; wait before capturing again.',
        )
      if (args.action === 'capture') invalidateSnapshot(state)
      let raw: unknown
      try {
        raw = await dispatchBackend(call, { session: ctx.session, signal: ctx.signal })
      } catch (error) {
        if (args.action === 'capture' && !this.isLifecycleCurrent(lifecycle))
          return refusalToolResult(
            'session_lifecycle_changed',
            'Computer Use session lifecycle changed while capturing; stale output was discarded.',
          )
        throw error
      }
      if (args.action === 'capture') {
        if (!this.isLifecycleCurrent(lifecycle))
          return refusalToolResult(
            'session_lifecycle_changed',
            'Computer Use session lifecycle changed while capturing; stale output was discarded.',
          )
        let capture: ToolResult | undefined
        try {
          const parsed = parseCaptureResult(raw)
          if (
            parsed.image &&
            (parsed.image.width > this.maxImageDimension ||
              parsed.image.height > this.maxImageDimension ||
              parsed.image.ref.size > this.maxBytesPerImage)
          )
            throw new TypeError('computer_use capture image exceeds the configured media limits')
          capture = await presentCapture(state, parsed, ctx, this.recentArtifacts, captureEpoch, () =>
            this.isLifecycleCurrent(lifecycle),
          )
        } catch (error) {
          if (!this.isLifecycleCurrent(lifecycle))
            return refusalToolResult(
              'session_lifecycle_changed',
              'Computer Use session lifecycle changed while capturing; stale output was discarded.',
            )
          throw error
        }
        return (
          capture ??
          refusalToolResult(
            'session_lifecycle_changed',
            'Computer Use session lifecycle changed while capturing; stale output was discarded.',
          )
        )
      }
      if (args.action === 'list_apps' || args.action === 'list_windows') {
        const items = parseListingResult(raw, args.action === 'list_apps' ? 'apps' : 'windows')
        if (args.action === 'list_windows')
          state.discoveredWindows = new Set(
            items.flatMap((item) => {
              const identity = discoveredWindowIdentity(item)
              return identity ? [identity] : []
            }),
          )
        return listingResult(args.action, items)
      }

      const action = parseActionResult(raw, args.action)
      if ((args.action === 'focus_app' || args.action === 'launch_app') && action.ok) {
        // A focus or launch operation creates a new target snapshot boundary. Old element
        // capabilities and safety observations belong to the previous app/window.
        resetObservation(state, action.target ?? (args.app?.trim() ? { app: args.app.trim() } : undefined))
      }
      const presented = actionToolResult(action)
      const observationEligible =
        isStateChanging(args.action) || (args.action === 'wait' && state.target !== undefined)
      const automaticObservation = this.options.autoCaptureAfterActions === true && observationEligible
      const captureAfterRequested =
        automaticObservation ||
        (observationEligible && args.capture_after === true) ||
        (args.action === 'drag' && args.from_coordinate !== undefined)
      if (!captureAfterRequested || !action.ok) return presented
      if (ctx.signal.aborted)
        return actionToolResult(action, 'capture_after skipped because the request was cancelled')
      if (!this.isLifecycleCurrent(lifecycle))
        return actionToolResult(action, 'capture_after skipped because the session lifecycle changed')
      if (!this.reserveCapture(ctx.session))
        return actionToolResult(action, 'capture_after skipped because the session capture limit was reached')
      try {
        const captureArgs = exactCaptureArgs(state.target, this.options.captureAfterMode ?? 'som')
        const captureAfterEpoch = state.dedupEpoch
        invalidateSnapshot(state)
        const followRaw = await dispatchBackend(captureArgs, {
          session: ctx.session,
          signal: ctx.signal,
        })
        if (!this.isLifecycleCurrent(lifecycle))
          return actionToolResult(action, 'capture_after skipped because the session lifecycle changed')
        const parsedFollow = parseCaptureResult(followRaw)
        if (
          parsedFollow.image &&
          (parsedFollow.image.width > this.maxImageDimension ||
            parsedFollow.image.height > this.maxImageDimension ||
            parsedFollow.image.ref.size > this.maxBytesPerImage)
        )
          throw new TypeError('computer_use capture image exceeds the configured media limits')
        const follow = await presentCapture(
          state,
          parsedFollow,
          ctx,
          this.recentArtifacts,
          captureAfterEpoch,
          () => this.isLifecycleCurrent(lifecycle),
        )
        if (!follow)
          return actionToolResult(action, 'capture_after skipped because the session lifecycle changed')
        const unchangedDrag =
          args.action === 'drag' &&
          action.effect === 'unverifiable' &&
          (follow.structured as Record<string, unknown>).screen_unchanged === true
        const verifiedAction = unchangedDrag
          ? {
              ...action,
              effect: 'suspected_noop' as const,
              ...(args.delivery_mode === 'foreground'
                ? {}
                : {
                    escalation: {
                      recommended: 'foreground' as const,
                      reason: 'The fresh exact-target capture is pixel-identical after the background drag.',
                    },
                  }),
            }
          : action
        const finalPresented = unchangedDrag ? actionToolResult(verifiedAction) : presented
        return {
          content: [...finalPresented.content, ...follow.content],
          structured: {
            ...(finalPresented.structured as Record<string, unknown>),
            capture_after: follow.structured,
          },
          ...(finalPresented.isError === undefined ? {} : { isError: finalPresented.isError }),
        }
      } catch {
        if (!this.isLifecycleCurrent(lifecycle))
          return actionToolResult(action, 'capture_after skipped because the session lifecycle changed')
        ctx.log.warn('computer_use capture_after failed', {
          action: args.action,
          code: 'capture_after_failed',
        })
        return actionToolResult(action, 'capture_after failed')
      }
    })
  }
}

export function createComputerUseTool(
  provider: ComputerUseBackendProvider,
  options?: ComputerUseToolOptions,
): ToolDef<typeof ComputerUseParams> {
  return new ComputerUseToolRuntime(provider, options).tool
}

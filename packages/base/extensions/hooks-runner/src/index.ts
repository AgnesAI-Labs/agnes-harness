import {
  HOOK_UNHANDLED,
  type SandboxSeam,
  WORKSPACE_HOOK_SANDBOX,
  type WorkspaceHookSandbox,
} from '@agnes/core'
import {
  type Disposer,
  defineExtension,
  type ExtensionFactory,
  HOOK_TABLE,
  type HookContext,
  type HookEvent,
  type HookHandler,
  type HookPayloadMap,
  type HookReturnMap,
  type ToolResult,
} from '@agnes/extension-api'
import { AGH_DIR } from '@agnes/protocol'
import type { SeamInitContext } from '../../../src/seam-init.js'
import { type CcHookGroup, hookGroupsFromSnapshot, readHooksSnapshot } from './config.js'
import { createNodeHookHttpClient, type HookHttpClient, runHttp } from './http.js'
import { type CcHookMap, type HookProcessResult, mapEvent, translateReturn } from './map.js'
import { runSubprocess } from './subprocess.js'

export * from './config.js'
export * from './http.js'
export * from './map.js'
export * from './subprocess.js'

export const [MATCHED, MAX_CONTEXT_BYTES] = [new Set<HookEvent>(['tool_call', 'tool_result']), 8192] as const

type ConfigIdentity = Readonly<{ source: 'data' | 'workspace'; configDigest: string }>
type BoundGroup = CcHookGroup & {
  matcherTest?: (name: string) => boolean
  configuration: ConfigIdentity | undefined
}

export type HooksRunnerExtensionDeps = {
  map: CcHookMap
  sandbox?: SandboxSeam
  http?: HookHttpClient
  /** Workspace groups are supplied by the Host on each hook invocation, not read at factory time. */
  workspaceSnapshots?: boolean
  /** The isolated runner's sandbox is a per-invocation IPC proxy resolved by the Host. */
  workspaceSandboxProxy?: boolean
} & { runHttp?: typeof runHttp }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function safeMatcher(source: string): ((name: string) => boolean) | undefined {
  const alternatives = source.split('|')
  if (alternatives.some((part) => part.length === 0)) return undefined
  const patterns: string[] = []
  for (const alternative of alternatives) {
    const tokens = alternative.split('.*')
    if (tokens.some((token) => !/^[A-Za-z0-9_./:-]*$/.test(token))) return undefined
    patterns.push(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
  }
  const expression = new RegExp(`^(?:${patterns.join('|')})$`)
  return (name) => expression.test(name)
}

function presetString(init: SeamInitContext, key: string, fallback: string): string {
  const value = init.profile.preset[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function networkAllow(init: SeamInitContext): string[] {
  const sandbox = init.profile.preset.sandbox
  if (!isRecord(sandbox) || !Array.isArray(sandbox.network_allow)) return []
  return sandbox.network_allow.filter((entry): entry is string => typeof entry === 'string')
}

function principal(payload: Record<string, unknown>): string {
  const request = isRecord(payload.request) ? payload.request : undefined
  const actor = isRecord(payload.actor) ? payload.actor : isRecord(request?.actor) ? request.actor : undefined
  return typeof actor?.id === 'string' && actor.id.length > 0 ? actor.id : 'unknown'
}

function invocationSandbox(context: HookContext): WorkspaceHookSandbox | undefined {
  return (context as HookContext & { [WORKSPACE_HOOK_SANDBOX]?: WorkspaceHookSandbox })[
    WORKSPACE_HOOK_SANDBOX
  ]
}

function defaultReturn<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): HookReturnMap[E] {
  const current = event === 'tool_result' ? (payload as HookPayloadMap['tool_result']).result : undefined
  return translateReturn(event, { exitCode: 0, stdout: '', stderr: '' }, current)
}

function isDirectiveStop(event: HookEvent, result: unknown): boolean {
  if (!isRecord(result)) return false
  return (
    (event === 'tool_call' && result.allow === false) ||
    (event === 'before_step' && result.block === true) ||
    (event === 'turn_stopping' && result.action === 'continue')
  )
}

function warnedFields(map: CcHookMap, group: CcHookGroup, raw: HookProcessResult): string[] {
  const output = raw.output ?? {}
  const nested = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : output
  return (map.events[group.event]?.unsupportedFields ?? []).filter(
    (field) => field in output || field in nested,
  )
}

function mergeReturn<E extends HookEvent>(
  event: E,
  previous: HookReturnMap[E],
  next: HookReturnMap[E],
): HookReturnMap[E] {
  if (event === 'context') {
    const left = previous as HookReturnMap['context']
    const right = next as HookReturnMap['context']
    if (right.additionalContext === undefined) return previous
    const additionalContext = [left.additionalContext, right.additionalContext].filter(Boolean).join('\n')
    if (Buffer.byteLength(additionalContext) > MAX_CONTEXT_BYTES)
      throw new Error(`hook additionalContext exceeds ${MAX_CONTEXT_BYTES} bytes in aggregate`)
    return {
      ...left,
      ...right,
      additionalContext,
    } as HookReturnMap[E]
  }
  if (event === 'tool_result' && (next as HookReturnMap['tool_result']).result === undefined) return previous
  return next
}

function currentToolResult<E extends HookEvent>(
  event: E,
  payload: HookPayloadMap[E],
  previous: HookReturnMap[E],
): ToolResult | undefined {
  if (event !== 'tool_result') return undefined
  return (
    (previous as HookReturnMap['tool_result']).result ?? (payload as HookPayloadMap['tool_result']).result
  )
}

/** Build the hook callbacks from configuration already read and validated by the trusted host. */
export function preparedHooksRunnerExtension(
  init: SeamInitContext,
  deps: HooksRunnerExtensionDeps,
  groups: readonly CcHookGroup[],
  configurations?: ReadonlyMap<CcHookGroup, ConfigIdentity>,
  loadConfigured?: () => Promise<
    Readonly<{
      groups: readonly CcHookGroup[]
      configurations: ReadonlyMap<CcHookGroup, ConfigIdentity>
    }>
  >,
): ExtensionFactory {
  const prepare = (source: readonly CcHookGroup[], identities?: ReadonlyMap<CcHookGroup, ConfigIdentity>) =>
    source.map((original) => {
      const group = structuredClone(original)
      for (const hook of group.hooks) Object.freeze(hook)
      Object.freeze(group.hooks)
      Object.freeze(group)
      const identity = identities?.get(original)
      return { group, ...(identity ? { configuration: Object.freeze({ ...identity }) } : {}) }
    })
  const prepared = prepare(groups, configurations)
  return defineExtension(async (agnes) => {
    const warned = new Set<string>()
    const pendingWarnings = new Map<string, Record<string, string>>()
    const recordWarning = async (key: string): Promise<void> => {
      const data = pendingWarnings.get(key)
      if (!data) return
      try {
        await agnes.events.append('unsupported', data)
        pendingWarnings.delete(key)
      } catch {
        // Factory initialization has no active session. The first session hook retries below.
      }
    }
    const warnOnce = (key: string, message: string, data: Record<string, string>): void => {
      if (warned.has(key)) return
      warned.add(key)
      agnes.ctx.log.warn(message, data)
      pendingWarnings.set(key, data)
    }
    const flushWarnings = async (): Promise<void> => {
      for (const key of [...pendingWarnings.keys()]) await recordWarning(key)
    }

    const bindGroups = (
      groups: readonly Readonly<{ group: CcHookGroup; configuration?: ConfigIdentity }>[],
    ): Map<HookEvent, BoundGroup[]> => {
      const result = new Map<HookEvent, BoundGroup[]>()
      for (const { group, configuration } of groups) {
        const mapped = mapEvent(deps.map, group.event)
        if ('unsupported' in mapped) {
          warnOnce(`event:${group.event}`, `hooks.json event ${group.event} is unsupported`, {
            event: group.event,
            reason: mapped.unsupported,
          })
          continue
        }
        const matcherTest = group.matcher === undefined ? undefined : safeMatcher(group.matcher)
        if (group.matcher !== undefined && matcherTest === undefined) {
          warnOnce(`matcher:${group.event}:${group.matcher}`, 'hooks-runner ignored an unsafe matcher', {
            event: group.event,
            reason: 'unsafe-matcher',
          })
          continue
        }
        for (const event of mapped.to) {
          const list = result.get(event) ?? []
          list.push({ ...group, configuration, ...(matcherTest === undefined ? {} : { matcherTest }) })
          result.set(event, list)
        }
      }
      return result
    }
    // Registration APIs are factory-phase only. Binding is deliberately synchronous so no await
    // can move registerHook calls outside that window; durable warning events flush in handlers.
    let bindings = bindGroups(prepared)
    const dynamicEvents = new Set<HookEvent>()
    if (deps.workspaceSnapshots || loadConfigured)
      for (const event of Object.keys(deps.map.events)) {
        const mapped = mapEvent(deps.map, event)
        if (!('unsupported' in mapped)) for (const target of mapped.to) dynamicEvents.add(target)
      }

    const sandbox = deps.sandbox ?? init.sandbox
    const unconfinedNotices = new Set<string>()
    const requireCommandPermission = (
      group: BoundGroup,
      commandSandbox: WorkspaceHookSandbox | undefined,
    ): void => {
      const enforcement = commandSandbox?.enforcement()
      if (commandSandbox && enforcement?.level !== 'none' && enforcement?.scope.includes('process')) return
      const policy = init.profile.preset.sandbox
      const identity = group.configuration
      if (
        init.adapters.platform.fs().pathSep === '\\' &&
        init.adapters.platform.shell() === 'powershell' &&
        commandSandbox &&
        enforcement?.level !== 'none' &&
        enforcement?.scope.includes('file') &&
        isRecord(policy) &&
        (policy.required === undefined || policy.required === false) &&
        policy.on_unavailable === 'allow' &&
        identity &&
        init.trustedHookCommands?.allowsUnconfined(identity.source, identity.configDigest)
      ) {
        const key = `${identity.source}:${identity.configDigest}`
        if (!unconfinedNotices.has(key)) {
          unconfinedNotices.add(key)
          agnes.ctx.log.warn('trusted Hook commands run without process isolation', { ...identity })
        }
        return
      }
      throw new Error(
        'E_SANDBOX_UNAVAILABLE: hooks-runner commands require process enforcement or explicit trusted permission',
      )
    }
    if (!deps.workspaceSnapshots)
      for (const items of bindings.values())
        for (const group of items)
          if (group.hooks.some((hook) => hook.type === 'command')) requireCommandPermission(group, sandbox)

    const http = deps.http ?? createNodeHookHttpClient()
    const rh = deps.runHttp ?? runHttp
    const allowHosts = networkAllow(init)
    const handler =
      <E extends HookEvent>(event: E): HookHandler<E> =>
      async (payload: HookPayloadMap[E], hctx: HookContext): Promise<HookReturnMap[E]> => {
        await flushWarnings()
        const payloadRecord = payload as unknown as Record<string, unknown>
        let result = defaultReturn(event, payload)
        const workspaceHooks = hctx.workspaceHooks
        const workspaceGroups = deps.workspaceSnapshots
          ? hookGroupsFromSnapshot(workspaceHooks).map((group) => ({
              group,
              ...(workspaceHooks
                ? {
                    configuration: {
                      source: 'workspace' as const,
                      configDigest: workspaceHooks.workspaceDigest,
                    },
                  }
                : {}),
            }))
          : []
        const workspaceBindings = bindGroups(workspaceGroups)
        await flushWarnings()
        const commandSandbox = deps.workspaceSnapshots
          ? (invocationSandbox(hctx) ?? (deps.workspaceSandboxProxy ? sandbox : undefined))
          : sandbox
        const eventGroups = [...(bindings.get(event) ?? []), ...(workspaceBindings.get(event) ?? [])]
        if (event === 'before_compact' && eventGroups.length === 0) return HOOK_UNHANDLED as never
        for (const group of eventGroups) {
          if (
            MATCHED.has(event) &&
            group.matcherTest !== undefined &&
            !group.matcherTest(String(payloadRecord.name ?? ''))
          )
            continue
          const body = {
            ...payloadRecord,
            hook_event_name: group.event,
            session_id: hctx.session.key,
            cwd: hctx.session.workspaceRoot,
          }
          const env = {
            AGNES_SESSION_ID: hctx.session.key,
            AGNES_STEP_ID: `${hctx.session.turn ?? 0}/${hctx.session.step ?? 0}`,
            AGNES_SURFACE: presetString(init, 'surface', 'unknown'),
            AGNES_LOCALE: presetString(init, 'locale', 'en'),
            AGNES_PRINCIPAL: principal(payloadRecord),
            AGNES_PLUGIN_ROOT: init.profile.dataDir,
          }
          for (const hook of group.hooks) {
            if (hook.type === 'command') requireCommandPermission(group, commandSandbox)
            const timeoutMs = Math.min(HOOK_TABLE[event].timeoutMs, (hook.timeout ?? 60) * 1000)
            const raw =
              hook.type === 'http'
                ? await rh(http, { url: hook.url, timeoutMs, allowHosts, signal: hctx.signal }, body)
                : await runSubprocess(
                    // Authorization still uses the policy-bound seam, never a raw spawn port.
                    (commandSandbox as WorkspaceHookSandbox).exec.bind(commandSandbox),
                    {
                      command: hook.command,
                      timeoutMs,
                      cwd: hctx.session.workspaceRoot,
                      env,
                      signal: hctx.signal,
                    },
                    body,
                  )
            for (const field of warnedFields(deps.map, group, raw))
              warnOnce(
                `field:${group.event}:${field}`,
                `hooks.json output field ${group.event}.${field} is unsupported`,
                { event: group.event, field },
              )
            await flushWarnings()
            const translated = translateReturn(event, raw, currentToolResult(event, payload, result))
            result = mergeReturn(event, result, translated)
            if (isDirectiveStop(event, result)) return result
          }
        }
        return result
      }

    const disposers: Disposer[] = []
    if (bindings.has('session_start') || dynamicEvents.has('session_start'))
      disposers.push(agnes.registerHook('session_start', handler('session_start')))
    else if (pendingWarnings.size > 0)
      disposers.push(
        agnes.registerHook('session_start', async () => {
          await flushWarnings()
        }),
      )
    if (bindings.has('shutdown') || dynamicEvents.has('shutdown'))
      disposers.push(agnes.registerHook('shutdown', handler('shutdown')))
    if (bindings.has('before_step') || dynamicEvents.has('before_step'))
      disposers.push(agnes.registerHook('before_step', handler('before_step')))
    if (bindings.has('context') || dynamicEvents.has('context'))
      disposers.push(agnes.registerHook('context', handler('context')))
    if (bindings.has('tool_call') || dynamicEvents.has('tool_call'))
      disposers.push(agnes.registerHook('tool_call', handler('tool_call')))
    if (bindings.has('tool_result') || dynamicEvents.has('tool_result'))
      disposers.push(agnes.registerHook('tool_result', handler('tool_result')))
    if (bindings.has('turn_stopping') || dynamicEvents.has('turn_stopping'))
      disposers.push(agnes.registerHook('turn_stopping', handler('turn_stopping')))
    if (bindings.has('subagent_start') || dynamicEvents.has('subagent_start'))
      disposers.push(agnes.registerHook('subagent_start', handler('subagent_start')))
    if (bindings.has('subagent_end') || dynamicEvents.has('subagent_end'))
      disposers.push(agnes.registerHook('subagent_end', handler('subagent_end')))
    if (bindings.has('before_compact') || dynamicEvents.has('before_compact'))
      disposers.push(agnes.registerHook('before_compact', handler('before_compact')))
    if (bindings.has('compact') || dynamicEvents.has('compact'))
      disposers.push(agnes.registerHook('compact', handler('compact')))
    if (bindings.has('approval_request') || dynamicEvents.has('approval_request'))
      disposers.push(agnes.registerHook('approval_request', handler('approval_request')))

    // The registration batch closes as soon as the factory first yields. All possible handlers are
    // therefore registered above, while trusted config I/O and validation may finish afterwards.
    if (loadConfigured) {
      try {
        const loaded = await loadConfigured()
        bindings = bindGroups(prepare(loaded.groups, loaded.configurations))
        if (!deps.workspaceSnapshots)
          for (const items of bindings.values())
            for (const group of items)
              if (group.hooks.some((hook) => hook.type === 'command'))
                requireCommandPermission(group, sandbox)
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
    }

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}

/** Build the trusted in-process extension around an already assembled, enforcing sandbox seam. */
export function hooksRunnerExtension(
  init: SeamInitContext,
  deps: HooksRunnerExtensionDeps,
): ExtensionFactory {
  const configured = async () => {
    const groups: CcHookGroup[] = []
    const configurations = new Map<CcHookGroup, ConfigIdentity>()
    const inputs: ReadonlyArray<readonly [ConfigIdentity['source'], typeof init.adapters.fs, string]> = [
      ['data', init.adapters.dataFs, `${init.profile.dataDir}/hooks.json`],
      ...(deps.workspaceSnapshots ? [] : [['workspace', init.adapters.fs, `${AGH_DIR}/hooks.json`] as const]),
    ]
    for (const [source, fs, path] of inputs) {
      const snapshot = await readHooksSnapshot(fs, path)
      if (!snapshot) continue
      for (const group of snapshot.groups) {
        groups.push(group)
        configurations.set(group, { source, configDigest: snapshot.configDigest })
      }
    }
    return Object.freeze({ groups, configurations })
  }
  return preparedHooksRunnerExtension(init, deps, [], undefined, configured)
}

export default defineExtension(() => {
  throw new Error('E_SANDBOX_UNAVAILABLE: hooks-runner requires trusted ecosystem assembly')
})

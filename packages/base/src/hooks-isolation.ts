import { readFileSync } from 'node:fs'
import type { WorkspaceHookSandbox } from '@agnes/core'
import type { ExtensionAPI, HookEvent, HookInvocationSnapshot } from '@agnes/extension-api'
import {
  type CcHookGroup,
  hookGroupsFromSnapshot,
  readHooksConfig,
} from '../extensions/hooks-runner/src/config.js'
import { createNodeHookHttpClient, type HttpHookSpec, runHttp } from '../extensions/hooks-runner/src/http.js'
import { MATCHED, safeMatcher } from '../extensions/hooks-runner/src/index.js'
import { type CcHookMap, mapEvent } from '../extensions/hooks-runner/src/map.js'
import { SHELL_SENTINEL } from '../extensions/tools-core/src/tools/shell.js'
import type { SeamInitContext } from './seam-init.js'

/** Replaced with the reviewed generated asset by the CLI SEA build. */
declare const AGNES_CC_HOOK_MAP_TEXT: string | undefined

const map = JSON.parse(
  typeof AGNES_CC_HOOK_MAP_TEXT === 'undefined'
    ? readFileSync(new URL('../extensions/hooks-runner/generated/cc-hook-map.json', import.meta.url), 'utf8')
    : AGNES_CC_HOOK_MAP_TEXT,
) as CcHookMap
const MAX_CAPABILITY_INPUT = 1024 * 1024

type Preparation = {
  data: Record<string, unknown>
  capability(
    api: ExtensionAPI,
    method: string,
    input: unknown,
    signal: AbortSignal,
    invocation: Invocation,
  ): Promise<unknown>
}
type Invocation = {
  event: string
  payload: unknown
  session: { key: string; workspaceRoot: string; turn?: number; step?: number }
  workspaceHooks?: HookInvocationSnapshot
  sandbox?: WorkspaceHookSandbox
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const toolName = (payload: unknown): string => String((record(payload) ? payload.name : undefined) ?? '')

/** Same matcher gate as the in-process handler (MATCHED set + safeMatcher), so the Host re-check cannot drift. */
function matcherAllows(hookEvent: string, matcher: string | undefined, name: string): boolean {
  const test = matcher === undefined ? undefined : safeMatcher(matcher)
  return matcher === undefined || (test !== undefined && (!MATCHED.has(hookEvent as HookEvent) || test(name)))
}

function invocationBody(invocation: Invocation, hookEvent: string): Record<string, unknown> | undefined {
  return record(invocation.payload)
    ? {
        ...invocation.payload,
        hook_event_name: hookEvent,
        session_id: invocation.session.key,
        cwd: invocation.session.workspaceRoot,
      }
    : undefined
}

function execInput(
  input: unknown,
  init: SeamInitContext,
  groups: readonly CcHookGroup[],
  invocation: Invocation,
  signal: AbortSignal,
): Parameters<NonNullable<SeamInitContext['sandbox']>['exec']> {
  if (!record(input) || !Array.isArray(input.argv) || !record(input.options))
    throw new Error('invalid isolated exec capability')
  const argv = input.argv
  const options = input.options
  const body = typeof options.stdin === 'string' ? parseBody(options.stdin) : undefined
  const hookEvent = typeof body?.hook_event_name === 'string' ? body.hook_event_name : ''
  const configured = groups.some(
    (group) =>
      group.event === hookEvent &&
      !('unsupported' in mapEvent(map, group.event)) &&
      (mapEvent(map, group.event) as { to: string[] }).to.includes(invocation.event) &&
      matcherAllows(invocation.event, group.matcher, toolName(invocation.payload)) &&
      group.hooks.some((hook) => hook.type === 'command' && hook.command === argv[1]),
  )
  const expectedBody = invocationBody(invocation, hookEvent)
  const expectedEnv = {
    AGNES_SESSION_ID: invocation.session.key,
    AGNES_STEP_ID: `${invocation.session.turn ?? 0}/${invocation.session.step ?? 0}`,
    AGNES_SURFACE: presetString(init, 'surface', 'unknown'),
    AGNES_LOCALE: presetString(init, 'locale', 'en'),
    AGNES_PRINCIPAL: principal(invocation.payload),
    AGNES_PLUGIN_ROOT: init.profile.dataDir,
  }
  if (
    argv.length !== 2 ||
    argv[0] !== SHELL_SENTINEL ||
    typeof argv[1] !== 'string' ||
    argv[1].length > 65_536 ||
    !configured ||
    typeof options.cwd !== 'string' ||
    options.cwd !== invocation.session.workspaceRoot ||
    typeof options.stdin !== 'string' ||
    Buffer.byteLength(options.stdin) > MAX_CAPABILITY_INPUT ||
    typeof options.timeoutMs !== 'number' ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 2_147_483_647 ||
    options.maxOutputBytes !== 64 * 1024 ||
    !record(options.env) ||
    Object.entries(options.env).some(
      ([key, value]) =>
        key.length === 0 || key.includes('\0') || typeof value !== 'string' || value.includes('\0'),
    ) ||
    JSON.stringify(body) !== JSON.stringify(expectedBody) ||
    JSON.stringify(options.env) !== JSON.stringify(expectedEnv)
  )
    throw new Error('invalid isolated exec capability')
  return [
    argv as string[],
    {
      cwd: invocation.session.workspaceRoot,
      env: expectedEnv,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 64 * 1024,
      signal,
    },
  ]
}

function httpInput(
  input: unknown,
  init: SeamInitContext,
  groups: readonly CcHookGroup[],
  invocation: Invocation,
  signal: AbortSignal,
): { spec: HttpHookSpec; payload: unknown } {
  if (!record(input) || !record(input.spec)) throw new Error('invalid isolated HTTP capability')
  const spec = input.spec
  const body = record(input.payload) ? input.payload : undefined
  const hookEvent = typeof body?.hook_event_name === 'string' ? body.hook_event_name : ''
  const configured = groups.some(
    (group) =>
      group.event === hookEvent &&
      !('unsupported' in mapEvent(map, group.event)) &&
      (mapEvent(map, group.event) as { to: string[] }).to.includes(invocation.event) &&
      matcherAllows(invocation.event, group.matcher, toolName(invocation.payload)) &&
      group.hooks.some((hook) => hook.type === 'http' && hook.url === spec.url),
  )
  if (
    !configured ||
    typeof spec.url !== 'string' ||
    typeof spec.timeoutMs !== 'number' ||
    !Array.isArray(spec.allowHosts) ||
    spec.allowHosts.some((host) => typeof host !== 'string') ||
    JSON.stringify(body) !== JSON.stringify(invocationBody(invocation, hookEvent))
  )
    throw new Error('invalid isolated HTTP capability')
  return {
    spec: {
      url: spec.url,
      timeoutMs: spec.timeoutMs,
      allowHosts: networkAllow(init),
      signal,
    },
    payload: input.payload,
  }
}

function parseBody(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return record(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function presetString(init: SeamInitContext, key: string, fallback: string): string {
  const value = init.profile.preset[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function networkAllow(init: SeamInitContext): string[] {
  const sandbox = init.profile.preset.sandbox
  if (!record(sandbox) || !Array.isArray(sandbox.network_allow)) return []
  return sandbox.network_allow.filter((entry): entry is string => typeof entry === 'string')
}

function principal(payload: unknown): string {
  if (!record(payload)) return 'unknown'
  const request = record(payload.request) ? payload.request : undefined
  const actor = record(payload.actor) ? payload.actor : record(request?.actor) ? request.actor : undefined
  return typeof actor?.id === 'string' && actor.id.length > 0 ? actor.id : 'unknown'
}

/** Host-side half of the fixed hooks-runner adapter used by T6.3. */
async function prepareHooksRunner(init: SeamInitContext): Promise<Preparation> {
  const groups: CcHookGroup[] = [
    ...(await readHooksConfig(init.adapters.dataFs, [`${init.profile.dataDir}/hooks.json`])),
  ]
  const http = createNodeHookHttpClient()
  const profile = {
    name: init.profile.name,
    resolvedProfileHash: init.profile.resolvedProfileHash,
    dataDir: init.profile.dataDir,
    workspaceRoot: init.profile.workspaceRoot,
    homeDir: '',
    limits: {},
    preset: {
      surface: presetString(init, 'surface', 'unknown'),
      locale: presetString(init, 'locale', 'en'),
      sandbox: { network_allow: networkAllow(init) },
    },
  } satisfies SeamInitContext['profile']
  return {
    data: { groups, map, profile, workspaceSnapshots: true },
    async capability(api, method, input, signal, invocation) {
      const invocationGroups = [...groups, ...hookGroupsFromSnapshot(invocation.workspaceHooks)]
      if (method === 'exec') {
        if (!invocation.sandbox) throw new Error('isolated workspace exec capability is unavailable')
        const [argv, options] = execInput(input, init, invocationGroups, invocation, signal)
        return invocation.sandbox.exec(argv, options)
      }
      if (method === 'http.run') {
        const request = httpInput(input, init, invocationGroups, invocation, signal)
        return runHttp(http, request.spec, request.payload)
      }
      if (method === 'events.append') {
        if (!record(input) || input.name !== 'unsupported')
          throw new Error('invalid isolated event capability')
        return api.events.append(input.name, input.data as never)
      }
      throw new Error('unknown isolated hooks-runner capability')
    },
  }
}

/** Only this reviewed extension has an adapter; unknown ids never become generic remote code. */
export const isolatedEcosystem = {
  'agnes/hooks-runner': prepareHooksRunner,
} as const

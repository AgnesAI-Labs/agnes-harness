import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  contextTokens,
  type HookEngine,
  type RegisteredResource,
  SessionHookPort,
  type SessionImpl,
  type WorkspaceHookSandbox,
} from '@agnes/core'
import type { HookInvocationSnapshot, SessionRef, TelemetryConsent } from '@agnes/extension-api'
import { parse as parseYaml } from 'yaml'
import { HostError } from './errors.js'
import type { PresetDoc } from './presets/types.js'
import type { PublicationDispatch } from './publication-dispatch.js'

const TELEMETRY_CONSENTS: readonly TelemetryConsent[] = ['DISABLED', 'LOCAL', 'ANON', 'FULL']

/** Reads the already-merged preset document. Missing consent stays fail-closed for old presets. */
export function readTelemetryConsent(preset: Record<string, unknown>): TelemetryConsent {
  const telemetry = preset.telemetry
  if (telemetry === undefined) return 'DISABLED'
  if (typeof telemetry !== 'object' || telemetry === null || Array.isArray(telemetry))
    throw new Error('invalid telemetry.consent')
  const consent = (telemetry as Record<string, unknown>).consent
  if (consent === undefined) return 'DISABLED'
  if (!TELEMETRY_CONSENTS.includes(consent as TelemetryConsent)) throw new Error('invalid telemetry.consent')
  return consent as TelemetryConsent
}

/** Reads the profile-local overlay written by `agnes consent`; absence leaves presets unchanged. */
export function readProfileTelemetryConsent(profileDir: string): TelemetryConsent | undefined {
  const file = join(profileDir, 'consent.yaml')
  if (!existsSync(file)) return undefined
  let value: unknown
  try {
    value = parseYaml(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new HostError('E_PRESET_UNSUPPORTED', 'consent.yaml is not valid yaml', {
      detail: { file, cause: error instanceof Error ? error.message : String(error) },
    })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HostError('E_PRESET_UNSUPPORTED', 'consent.yaml must be a mapping', { detail: { file } })
  const root = value as Record<string, unknown>
  if (Object.keys(root).some((key) => key !== 'telemetry'))
    throw new HostError('E_PRESET_UNSUPPORTED', 'consent.yaml contains unsupported settings', {
      detail: { file },
    })
  const telemetry = root.telemetry
  if (
    typeof telemetry !== 'object' ||
    telemetry === null ||
    Array.isArray(telemetry) ||
    Object.keys(telemetry).length !== 1 ||
    !Object.hasOwn(telemetry, 'consent')
  )
    throw new HostError('E_PRESET_UNSUPPORTED', 'consent.yaml must contain only telemetry.consent', {
      detail: { file },
    })
  try {
    return readTelemetryConsent(root)
  } catch (error) {
    throw new HostError('E_PRESET_UNSUPPORTED', 'consent.yaml has invalid telemetry.consent', {
      detail: { file, cause: error instanceof Error ? error.message : String(error) },
    })
  }
}

/** Applies the profile-local value after inheritance while preserving the source preset document. */
export function applyTelemetryConsent(doc: PresetDoc, consent?: TelemetryConsent): PresetDoc {
  if (consent === undefined) return doc
  try {
    readTelemetryConsent(doc)
  } catch (error) {
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${doc.name} has invalid telemetry.consent`, {
      detail: { preset: doc.name, cause: error instanceof Error ? error.message : String(error) },
    })
  }
  const telemetry =
    typeof doc.telemetry === 'object' && doc.telemetry !== null && !Array.isArray(doc.telemetry)
      ? (doc.telemetry as Record<string, unknown>)
      : {}
  return { ...doc, telemetry: { ...telemetry, consent } }
}

/** Fit the shared extension registry to one session's live state. */
export function createSessionHookPort(
  session: SessionImpl,
  engine: HookEngine,
  registered: () => readonly RegisteredResource[],
  telemetryConsent: TelemetryConsent = 'DISABLED',
  hostSessionRef?: SessionRef,
  publication?: PublicationDispatch,
): SessionHookPort {
  const invocationContexts = new AsyncLocalStorage<
    Readonly<{ snapshot: HookInvocationSnapshot; sandbox: WorkspaceHookSandbox }>
  >()
  const sessionRef =
    hostSessionRef ??
    Object.freeze({ key: session.key, lane: session.lane, workspaceRoot: session.d.cwd, telemetryConsent })
  const port = new SessionHookPort(engine, {
    discovery: {
      registered,
      actor: () => session.d.actor,
      cwd: () => session.d.cwd,
      principals: session.d.runtime,
    },
    context: () => {
      const workspace = invocationContexts.getStore()
      return {
        session: sessionRef,
        signal: session.ac.signal,
        replayed: false,
        log: session.d.logger,
        ...(workspace ? { workspaceHooks: workspace.snapshot, workspaceSandbox: workspace.sandbox } : {}),
      }
    },
    budget: () => {
      const cap = session.preset.budget.perRequestCap
      return {
        cap,
        remaining: cap === null ? Number.MAX_SAFE_INTEGER : Math.max(0, cap - session.state.creditsUsed),
      }
    },
    surface: () =>
      session.surface().map((node) => ({
        seq: node.seq,
        type:
          node.kind === 'user'
            ? 'user/message'
            : node.kind === 'assistant'
              ? 'assistant/message'
              : node.kind === 'tool_result'
                ? 'tool/result'
                : 'summary',
        pinned: node.pinned,
      })),
    surfaceDigest: () => ({ nodes: session.surface().length, tokensEstimate: contextTokens(session) }),
    verifierTier: () => session.preset.verifier.defaultTier,
    contextOverflow: (data) => session.diag('hook-context-overflow', data),
    compactPlanIgnored: (data) => session.diag('hook-compact-plan-ignored', data),
  })
  const invocation = session.d.workspaceInvocation
  if (!invocation) return port

  // `resources` and `resetTurn` do not dispatch handlers. Every method below creates a hook
  // context and therefore owns one complete workspace invocation, including isolated handlers.
  const dispatched = new Set<PropertyKey>([
    'sessionStart',
    'shutdown',
    'shutdownExtension',
    'beforeStep',
    'toolCall',
    'turnStopping',
    'context',
    'toolResult',
    'approvalRequest',
    'requestError',
    'formatDeviation',
    'subagentStart',
    'subagentEnd',
    'beforeCompact',
    'compact',
    'beforeRequest',
  ])
  return new Proxy(port, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof value !== 'function') return value
      if (!dispatched.has(key)) return value.bind(target)
      return (...args: unknown[]) => {
        const handler = async (view: import('@agnes/core').WorkspaceInvocationView) => {
          const snapshot = await view.hookSnapshot()
          const sandbox = view.hookSandbox()
          return invocationContexts.run({ snapshot, sandbox }, () => Reflect.apply(value, target, args))
        }
        return publication
          ? publication.workspace(() => ({ port: invocation, handler }))
          : invocation.run(handler)
      }
    },
  })
}

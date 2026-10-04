import {
  CoreError,
  canonicalJson,
  type FsPolicy,
  type SandboxSeam,
  type SessionImpl,
  sha256Hex,
} from '@agnes/core'
import type {
  ComparisonPreparedConfiguration,
  ComparisonPreparedReceipt,
  EventEnvelope,
} from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import {
  ComparisonPreparedConfiguration as ConfigurationSchema,
  ComparisonPreparedReceipt as ReceiptSchema,
} from '@agnes/protocol/gen/agnes-v1'
import { readMountedConfiguration } from '../mounted-attestation.js'
import { assertComparisonIsolation, type ComparisonIsolation } from './comparison-isolation.js'

export const SESSION_PREPARED_EVENT = 'x/host/session-prepared'
const ROUND_PREPARED_EVENT = 'x/host/comparison-round-prepared'
type RuntimeConfiguration = NonNullable<ComparisonPreparedConfiguration['runtimeConfig']>
const runtimes = new WeakMap<SessionImpl, () => RuntimeConfiguration>()
const sandboxes = new WeakMap<SessionImpl, { sandbox: SandboxSeam; policy: FsPolicy }>()
const isolations = new WeakMap<SessionImpl, ComparisonIsolation>()

/** Host-only producer inputs; no environment, transport or profile objects cross this boundary. */
export function bindPreparedSandbox(
  session: SessionImpl,
  sandbox: SandboxSeam | undefined,
  policy: FsPolicy | undefined,
): void {
  if (sandbox && policy) sandboxes.set(session, { sandbox, policy: structuredClone(policy) })
}
export function bindPreparedRuntime(
  session: SessionImpl,
  value: RuntimeConfiguration | (() => RuntimeConfiguration),
): void {
  const read =
    typeof value === 'function'
      ? value
      : (() => {
          const copied = structuredClone(value)
          return () => copied
        })()
  const checked = () => validatePreparedRuntime(read())
  checked()
  runtimes.set(session, checked)
}
function validatePreparedRuntime(value: RuntimeConfiguration): RuntimeConfiguration {
  const endpoint = new URL(value.decision.endpoint)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new CoreError('E_RELATION', 'Runtime configuration is not safe to publish')
  const copied = structuredClone(value)
  // Only explicitly selected decision coordinates and finite scalar runtime knobs are accepted.
  if (
    !validateAgainst(
      ConfigurationSchema.$defs.ComparisonPreparedConfiguration.properties.runtimeConfig,
      copied,
    ).ok
  )
    throw new CoreError('E_RELATION', 'Runtime configuration is not safe to publish')
  return copied
}
const digest = (value: unknown) => sha256Hex(canonicalJson(value))

export function captureSessionConfiguration(
  session: SessionImpl,
  executing = false,
): ComparisonPreparedConfiguration {
  const state = session.runtimeState()
  if (session.closingOrClosed || (!executing && state.phase !== 'idle'))
    throw new CoreError('E_LANE_BUSY', 'Configuration preparation requires an idle session')
  const preset = structuredClone(session.preset)
  const models = Object.keys(preset.model.route)
    .sort()
    .map((slot) => ({
      slot,
      route: preset.model.route[slot] === 'default' ? null : (preset.model.route[slot] ?? null),
      model: preset.model.id[slot] ?? null,
      thinking: preset.model.thinking[slot] ?? null,
      contextWindow: preset.model.contextWindow?.[slot] ?? null,
    }))
  // Keep the existing model fingerprint stable across this display-only schema addition.
  // The full preset fingerprint already binds the primary output cap and rejects its drift.
  const modelDigest = digest(models)
  const preparedModels = models.map((model) => ({
    ...model,
    maxTokens: model.slot === 'primary' ? (preset.model.maxTokens ?? null) : null,
  }))
  const definitions = session
    .currentTools()
    .list()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      meta: tool.meta,
    }))
  const toolDigest = digest(JSON.parse(JSON.stringify(definitions)))
  const presetDigest = digest(JSON.parse(JSON.stringify(preset)))
  const mounted = readMountedConfiguration(session.d.currentRuntime?.current(session.key))
  const fitted = sandboxes.get(session)
  const isolation = isolations.get(session)
  if (isolation)
    assertComparisonIsolation(fitted?.policy, fitted?.sandbox.enforcement(), session.yolo, isolation)
  let policyDigest: string | null = null
  let permissionDigest: string | null = null
  let enforcement: ComparisonPreparedConfiguration['effective']['permission']['enforcement'] = null
  if (fitted) {
    const { sandbox, policy } = fitted
    if (canonicalJson(sandbox.fsPolicy()) !== canonicalJson(policy))
      throw new CoreError('E_RELATION', 'Fitted permission policy no longer matches its bound workspace')
    // The fitted seam has already been bound and fenced by Host. Preserve all non-workspace paths
    // in the hash; only the independently materialized root is normalized, on segment boundaries.
    const root = policy.workspaceRoot.replace(/[\\/]+$/, '')
    const normalize = (path: string) =>
      path === root
        ? '$workspace'
        : path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
          ? `$workspace${path.slice(root.length)}`
          : path
    policyDigest = policy.digest
    enforcement = structuredClone(sandbox.enforcement())
    permissionDigest = digest({
      approvalMode: session.d.approvalMode ?? null,
      yolo: session.yolo,
      approval: preset.approval,
      sandbox: preset.sandbox,
      enforcement,
      policy: {
        rules: policy.rules
          .map((rule) => ({ ...rule, path: normalize(rule.path) }))
          .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        networkAllow: [...policy.networkAllow].sort(),
      },
    })
  }
  const configuration: ComparisonPreparedConfiguration = {
    runtime: structuredClone(state.runtime),
    effective: {
      mounted,
      preset: { name: preset.name, definitionDigest: presetDigest, scope: 'resolved-preset-view' },
      models: preparedModels,
      tools: { count: definitions.length, digest: toolDigest, scope: 'registered-tool-definitions' },
      permission: {
        approvalMode: session.d.approvalMode ?? null,
        yolo: session.yolo,
        enforcement,
        policyDigest,
        digest: permissionDigest,
      },
    },
    runtimeConfig:
      state.runtime.id === 'jevloop' ? (structuredClone(runtimes.get(session)?.()) ?? null) : null,
    fingerprints: {
      mounted: mounted?.digest ?? null,
      tools: toolDigest,
      model: modelDigest,
      preset: presetDigest,
      permission: permissionDigest,
    },
  }
  if (!validateAgainst(ConfigurationSchema, configuration).ok)
    throw new CoreError('E_RELATION', 'Actual session configuration cannot be attested')
  return configuration
}

/** Freeze actual state after authorized switches. The source append precedes comparison publication. */
export async function prepareSessionConfiguration(
  session: SessionImpl,
  isolation?: ComparisonIsolation,
): Promise<ComparisonPreparedReceipt> {
  return session.locked(async () => {
    if (isolation) isolations.set(session, structuredClone(isolation))
    const generation = session.d.currentRuntime?.current(session.key)
    const writer = session.writerRunId
    const configuration = captureSessionConfiguration(session)
    const unchanged = () =>
      !session.closingOrClosed &&
      writer === session.writerRunId &&
      generation === session.d.currentRuntime?.current(session.key) &&
      canonicalJson(captureSessionConfiguration(session)) === canonicalJson(configuration)
    const prior = await session.d.log.scan({ type: SESSION_PREPARED_EVENT, order: 'asc', limit: 2 })
    if (!unchanged()) throw new CoreError('E_RELATION', 'Configuration changed during preparation')
    if (prior.length) {
      const event = prior[0]
      if (prior.length !== 1 || !event) throw new CoreError('E_RELATION', 'Conflicting preparation evidence')
      const data = event.data
      if (
        data === null ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        data.version !== 1 ||
        event.origin !== 'system' ||
        event.trust !== 'trusted' ||
        event.ignorable !== true ||
        event.lane !== session.lane ||
        data.sessionId !== session.key ||
        !matchesHistoricalConfiguration(data.configuration, configuration)
      )
        throw new CoreError('E_RELATION', 'Prepared configuration no longer matches this session', {
          reason: 'configuration-changed',
        })
      return receipt(session.key, event, data.configuration as ComparisonPreparedConfiguration)
    }
    const appended = await session.d.log.append([
      session.ev(
        SESSION_PREPARED_EVENT,
        { version: 1, sessionId: session.key, configuration },
        { ignorable: true },
      ),
    ])
    const rows = await session.d.log.scan({ fromSeq: appended.firstSeq, toSeq: appended.firstSeq, limit: 1 })
    const event = rows[0]
    if (!unchanged() || rows.length !== 1 || !event)
      throw new CoreError('E_RELATION', 'Configuration changed during preparation')
    return receipt(session.key, event, configuration)
  })
}

function matchesHistoricalConfiguration(
  historical: unknown,
  current: ComparisonPreparedConfiguration,
): boolean {
  if (!validateAgainst(ConfigurationSchema, historical).ok) return false
  const recorded = historical as ComparisonPreparedConfiguration
  const compatible = structuredClone(current)
  // Legacy omission preserves its unknown scope. Do not upgrade its immutable source on resume.
  if (!Object.hasOwn(recorded.effective, 'mounted')) delete compatible.effective.mounted
  if (!Object.hasOwn(recorded.fingerprints, 'mounted')) delete compatible.fingerprints.mounted
  for (const model of compatible.effective.models) {
    const prior = recorded.effective.models.find((entry) => entry.slot === model.slot)
    if (prior && !Object.hasOwn(prior, 'maxTokens')) delete model.maxTokens
  }
  return canonicalJson(recorded) === canonicalJson(compatible)
}
/** Caller holds the configuration lease and writer lock. This never changes the creation baseline. */
export async function prepareRoundConfiguration(
  session: SessionImpl,
  inputId: string,
  permissionMode: 'view' | 'workspace' | 'full',
  configuration: ComparisonPreparedConfiguration,
): Promise<ComparisonPreparedReceipt> {
  const appended = await session.d.log.append([
    session.ev(
      ROUND_PREPARED_EVENT,
      { version: 1, sessionId: session.key, inputId, permissionMode, configuration },
      { ignorable: true },
    ),
  ])
  const [event] = await session.scan({ fromSeq: appended.firstSeq, toSeq: appended.firstSeq, limit: 1 })
  if (!event) throw new CoreError('E_RELATION', 'Round preparation source is missing')
  return receipt(session.key, event, configuration)
}

function receipt(
  sessionId: string,
  event: EventEnvelope,
  configuration: ComparisonPreparedConfiguration,
): ComparisonPreparedReceipt {
  const data = event.data
  if (
    ![SESSION_PREPARED_EVENT, ROUND_PREPARED_EVENT].includes(event.type) ||
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.ignorable !== true ||
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.version !== 1 ||
    data.sessionId !== sessionId ||
    canonicalJson(data.configuration) !== canonicalJson(configuration)
  )
    throw new CoreError('E_RELATION', 'Preparation source is invalid')
  const value = {
    sessionId,
    sourceSeq: event.seq,
    sourceDigest: digest(JSON.parse(JSON.stringify(event))),
    configuration: structuredClone(configuration),
  }
  if (!validateAgainst(ReceiptSchema, value).ok)
    throw new CoreError('E_RELATION', 'Preparation source is invalid')
  return value
}

/** A fixed prefix must contain the exact trusted source row; a receipt alone is not source proof. */
export function verifyPreparedReceipt(
  receipt: ComparisonPreparedReceipt,
  events: readonly EventEnvelope[],
): boolean {
  if (!validateAgainst(ReceiptSchema, receipt).ok) return false
  const start = events.find((event) => event.type === 'session/start')
  const event = events.find((event) => event.seq === receipt.sourceSeq)
  if (!start || start.data === null || typeof start.data !== 'object' || Array.isArray(start.data))
    return false
  if (
    !start ||
    !event ||
    start.origin !== 'system' ||
    start.trust !== 'trusted' ||
    start.data.key !== receipt.sessionId ||
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.ignorable !== true ||
    event.lane !== start.lane ||
    ![SESSION_PREPARED_EVENT, ROUND_PREPARED_EVENT].includes(event.type)
  )
    return false
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const root = start.data
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return false
  try {
    return (
      data.version === 1 &&
      data.sessionId === receipt.sessionId &&
      canonicalJson(root.runtime) === canonicalJson(receipt.configuration.runtime) &&
      digest(JSON.parse(JSON.stringify(event))) === receipt.sourceDigest &&
      canonicalJson(data.configuration) === canonicalJson(receipt.configuration)
    )
  } catch {
    return false
  }
}

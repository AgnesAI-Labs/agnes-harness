import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommitGuard, canonicalJsonDigest, type PreparedAction } from '@agnes/protocol/runtime'
import { expect } from 'vitest'
import { admissionFixtureInput } from '../../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import type { WriteCommitInput } from '../../../src/runtime/state/control.js'
import { stableId } from '../../../src/runtime/state/records.js'
import { openJointAdmission } from './assembly-admission-joint.js'
import { fixtureHash, fixtureRef } from './assembly-maintenance-wire.js'

export type Joint = Awaited<ReturnType<typeof openJointAdmission>>
export type Owner = {
  tx<T>(method: string, id: string, body: () => T | Promise<T>): Promise<T>
  requireSession(sessionId: string): Promise<unknown>
  writeCommit(input: WriteCommitInput): unknown
}

const directories: string[] = []
export const joints: Joint[] = []
export async function cleanup(): Promise<void> {
  for (const joint of joints.splice(0)) await joint.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}

export const CODEC = { namespace: 'agh.default/model-infer', codecVersion: '1' }

type AdmissionInput = ReturnType<typeof admissionFixtureInput>

function adjustProviders(input: AdmissionInput) {
  const release = input.fixture.previousRelease
  if (!release) throw Error('locked release missing')
  const parentProvider = release.bindings.find((row) => row.binding.contract === 'agh.model')
  const leafProvider = release.bindings.find((row) => row.binding.contract === 'agh.model-adapter')
  const toolProvider = release.bindings.find((row) => row.binding.contract === 'agh.tools')
  const infer = parentProvider?.descriptor.operations.find((row) => row.method === 'infer')
  const invoke = leafProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  const toolInvoke = toolProvider?.descriptor.operations.find((row) => row.method === 'invoke')
  if (!parentProvider || !leafProvider || !toolProvider || !infer || !invoke || !toolInvoke)
    throw Error('fixture providers missing')
  // Only the composite parent declares a state codec; the adapter and the tools stay leaf.
  parentProvider.descriptor.stateCodecs = [{ ...CODEC, schema: parentProvider.descriptor.configSchema }]
  parentProvider.codecRefs = parentProvider.descriptor.stateCodecs
  // A non-action operation and a duplicated action operation, neither of which may start a composite.
  const queryOp = parentProvider.descriptor.operations.find((row) => row.kind !== 'action')
  const twice = parentProvider.descriptor.operations.find((row) => row.method === 'prepareRequest')
  if (!queryOp || !twice) throw Error('fixture operations missing')
  parentProvider.descriptor.operations.push({ ...twice } as never)
  const { releaseSetId: _before, ...resealed } = release
  release.releaseSetId = fixtureHash(resealed)
  return { parentProvider, leafProvider, toolProvider, infer, invoke, toolInvoke, queryOp, twice }
}
const preparedProviders = new WeakMap<object, ReturnType<typeof adjustProviders>>()

/** Adjusts the admission fixture so the parent is a composite and the adapter and tools stay leaves. Idempotent. */
export function prepareProviders(input: AdmissionInput) {
  const known = preparedProviders.get(input)
  if (known) return known
  const adjusted = adjustProviders(input)
  preparedProviders.set(input, adjusted)
  return adjusted
}

/**
 * With `native` the run lives in that fixture's joint State, which the caller built from
 * `prepareProviders` and closes itself; otherwise the fixture opens and cleans up its own.
 */
export async function setup(
  options: { native?: { directory: string; input: AdmissionInput; fixture: Joint } } = {},
) {
  const directory = options.native?.directory ?? mkdtempSync(join(tmpdir(), 'agnes-advance-provider-'))
  if (!options.native) directories.push(directory)
  const input = options.native?.input ?? admissionFixtureInput()
  const { parentProvider, leafProvider, toolProvider, infer, invoke, toolInvoke, queryOp, twice } =
    prepareProviders(input)
  let failBeforeCommit = false
  const joint =
    options.native?.fixture ??
    (await openJointAdmission(directory, input, (point) => {
      if (failBeforeCommit && point.endsWith(':before')) throw Error('injected failure before commit')
    }))
  if (!options.native) joints.push(joint)
  const created = await joint.coordinator.coordinate(joint.draft(), joint.context())
  if (!(created.ok && created.value.state === 'created'))
    throw Error(`run was not created ${JSON.stringify(created)}`)
  const admission = joint.draft().admission
  const authority = joint.binding.stateAuthorityAtCreation
  const opened = await joint.state.open({
    requestId: 'writer',
    authority,
    sessionId: admission.sessionId,
    mode: 'write',
    writerId: 'writer',
    ttlMs: 600000,
  })
  if (!opened.claim) throw Error('writer was not opened')
  const writerEpoch = opened.claim.writerEpoch
  const runId = admission.runId
  const deadline = '2027-01-01T00:00:00Z'
  const action = (key: string, provider: typeof parentProvider, method: string, schemas: typeof infer) => {
    const intent = {
      key,
      target: provider.binding,
      method,
      input: { ...fixtureRef({ key }), schema: schemas.inputSchema },
      dependencies: [],
      retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
      obligation: 'mandatory' as const,
      deadline,
      resultSchema: schemas.outputSchema,
      references: [],
    }
    return { ...intent, intentFingerprint: fixtureHash(intent) } satisfies PreparedAction
  }
  const parentIntent = action('parent', parentProvider, 'infer', infer)
  const leafParentIntent = action('leaf-parent', toolProvider, 'invoke', toolInvoke)
  const queryParentIntent = action('query-parent', parentProvider, queryOp.method, queryOp)
  const duplicateParentIntent = action('duplicate-parent', parentProvider, 'prepareRequest', twice)
  const child = (key: string, laterDeadline = false) => {
    const intent = action(key, leafProvider, 'invoke', invoke)
    if (!laterDeadline) return intent
    const { intentFingerprint: _, ...body } = { ...intent, deadline: '2027-06-01T00:00:00Z' }
    return { ...body, intentFingerprint: fixtureHash(body) } satisfies PreparedAction
  }
  const continuation = (marker: string, namespace = CODEC.namespace) => ({
    namespace,
    codecVersion: CODEC.codecVersion,
    data: fixtureRef({ marker }),
    provenance: { sourceRefs: [], producer: parentProvider.binding, trustLabels: [] },
    createdAt: admission.admittedAt,
    references: [],
  })
  let counter = 0
  const guardFor = (invocationId: string, runRevision: number): CommitGuard => ({
    authority,
    sessionId: admission.sessionId,
    runId,
    writerId: 'writer',
    writerEpoch,
    expectedRunRevision: runRevision,
    bindingId: joint.binding.bindingId,
    invocationId,
    readGuards: [],
    queryUsage: null,
  })
  /** An invocation that is prepared for a commit and not yet used by one. */
  async function prepared(targetActionId: string | null, runRevision: number) {
    const invocationId = `invocation-${++counter}`
    await joint.state.admitInvocation({
      requestId: `admit-${counter}`,
      runId,
      targetActionId,
      baseRevision: runRevision,
      bindingId: joint.binding.bindingId,
      writerEpoch,
      invocationId,
      deadline,
      queryAllowance: 0,
    })
    await joint.state.closeInvocation({
      requestId: `close-${counter}`,
      invocationId,
      state: 'prepared',
      readGuards: [],
      domainReads: [],
      unresolvedInflightIds: [],
      observedQueryCount: 0,
    })
    return invocationId
  }
  // The Loop step creates the composite parent and one leaf-targeted action; run revision 0 -> 1.
  await joint.state.advanceRun({
    commitId: 'loop-step',
    guard: guardFor(await prepared(null, 0), 0),
    transition: {
      expectedRevision: 0,
      continuation: continuation('loop'),
      consumeSignals: [],
      actions: [parentIntent, leafParentIntent, queryParentIntent, duplicateParentIntent],
      next: { kind: 'continue' },
    },
  })
  const parentId = stableId('act', `${runId}\0parent`)
  const leafParentId = stableId('act', `${runId}\0leaf-parent`)
  const queryParentId = stableId('act', `${runId}\0query-parent`)
  const duplicateParentId = stableId('act', `${runId}\0duplicate-parent`)
  const owner = joint.state as unknown as Owner
  const head = (recordId: string) => {
    const row = joint.db
      .prepare(
        'SELECT h.record_revision,b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
      )
      .get(recordId)
    if (!row || typeof row.value_json !== 'string') return undefined
    // biome-ignore lint/suspicious/noExplicitAny: record bodies are probed by path in assertions
    return { revision: Number(row.record_revision), value: JSON.parse(row.value_json) as Record<string, any> }
  }
  const writes = () => Number(joint.db.prepare('SELECT total_changes() AS n').get()?.n)
  const events = () => Number(joint.db.prepare('SELECT count(*) AS n FROM events').get()?.n)
  const start = (id: string, actionId: string, commitId: string, attemptId: string, revision = 1) =>
    joint.state.commitControl({
      commitId,
      guard: guardFor(id, 1),
      command: { kind: 'start_composite', actionId, expectedActionRevision: revision, attemptId },
    })
  const advanceRequest = (
    id: string,
    commitId: string,
    transition: {
      revision?: number
      children?: PreparedAction[]
      consume?: string[]
      next?: unknown
      continuation?: ReturnType<typeof continuation>
    },
    actionId = parentId,
  ) => ({
    commitId,
    guard: guardFor(id, 1),
    actionId,
    expectedProviderRevision: transition.revision ?? 0,
    transition: {
      expectedProviderRevision: transition.revision ?? 0,
      continuation: transition.continuation ?? continuation(commitId),
      consumeSignals: transition.consume ?? [],
      children: transition.children ?? [],
      next: (transition.next ?? { kind: 'continue' }) as never,
    },
  })
  const advance = (...args: Parameters<typeof advanceRequest>) =>
    joint.state.advanceProvider(advanceRequest(...args))
  const stateBinding = {
    bindingId: joint.binding.bindingId,
    contract: 'agh.state',
    logicalName: 'default',
    providerId: 'fixture-state',
  }
  /** Asks for the dispatch of an action and returns the admission decision. */
  function dispatch(actionId: string, intent: PreparedAction, invocationId: string, tag: string) {
    return joint.state.dispatchAdmission({
      admissionId: `admit-${tag}`,
      commitId: `dispatch-${tag}`,
      guard: guardFor(invocationId, 1),
      atomicDomain: {
        domainId: 'fixture-domain',
        revision: 1,
        stateAuthority: authority,
        budgetAuthority: authority,
        stateBinding,
        budgetBinding: stateBinding,
      },
      actionId,
      expectedActionRevision: 1,
      decisionRef: fixtureRef({}),
      attemptId: `attempt-${tag}`,
      requestIdentity: {
        system: 'fixture-peer',
        aghRequestId: `request-${tag}`,
        idempotencyKey: null,
        requestDigest: canonicalJsonDigest(intent.input),
      },
      budget: { reservation: null, quota: [] },
      deadline,
    })
  }
  /** Dispatches an action and settles it with a real receipt, which publishes the signal for its parent. */
  async function complete(actionId: string, intent: PreparedAction, invocationId: string, tag: string) {
    const admitted = await dispatch(actionId, intent, invocationId, tag)
    if (admitted.state !== 'admitted') throw Error('child dispatch was refused')
    await joint.state.intakeReceipt({
      intakeId: `intake-${tag}`,
      receipt: {
        receiptId: `receipt-${tag}`,
        actionId,
        attemptId: `attempt-${tag}`,
        bindingId: joint.binding.bindingId,
        inputDigest: canonicalJsonDigest(intent.input),
        outcome: 'succeeded',
        result: { ...fixtureRef({ tag }), schema: intent.resultSchema },
        externalRequests: [],
        usageRefs: [],
        references: [],
        provenance: { sourceRefs: [], producer: stateBinding, trustLabels: [] },
        completedAt: admission.admittedAt,
      },
      usage: [],
      evidence: [],
      sourceAuthorizationRef: admitted.authorizationId,
      queryUsage: null,
      resultHandling: { kind: 'no-hook' },
    })
  }
  /** Ids of the signals published for one target action (null is the run itself). */
  function signalsFor(targetActionId: string | null) {
    return joint.db
      .prepare(
        "SELECT json_extract(b.value_json,'$.signal.signalId') AS id FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id LIKE 'signal:%' AND json_extract(b.value_json,'$.signal.targetActionId') IS ?",
      )
      .all(targetActionId)
      .map((row) => String(row.id))
  }
  return {
    directory,
    input,
    joint,
    parentId,
    leafParentId,
    queryParentId,
    duplicateParentId,
    leafParentIntent,
    prepared,
    start,
    advance,
    advanceRequest,
    head,
    writes,
    events,
    child,
    continuation,
    complete,
    dispatch,
    signalsFor,
    owner,
    guardFor,
    admission,
    authority,
    setFailBeforeCommit(value: boolean) {
      failBeforeCommit = value
    },
  }
}

export async function reopened(f: Awaited<ReturnType<typeof setup>>) {
  await f.joint.close()
  joints.splice(joints.indexOf(f.joint), 1)
  const again = await openJointAdmission(f.directory, f.input)
  joints.push(again)
  await expect((again.state as unknown as Owner).requireSession(f.admission.sessionId)).resolves.toBeDefined()
  return again
}

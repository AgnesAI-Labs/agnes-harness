/** Jev-specific requests, scoped prose and chronological evidence from committed runtime records. */

import { isCandidateDiagnostic } from './candidate-evidence.js'
import { compileDecisionTools, DECISION_GUIDANCE } from './decision.js'
import { jsonBytes as bytes, decisionEvidence } from './decision-evidence.js'
import {
  decisionToolPhases,
  InvalidDecisionToolSnapshot,
  readDecisionToolSnapshot,
} from './decision-tools.js'
import type { ReplayState } from './ledger.js'
import { readFeedback } from './progress.js'
import type {
  Content,
  DecisionContextPort,
  DecisionInputPolicy,
  DecisionToolProfile,
  InputFact,
  JsonValue,
  RecordId,
  RuntimeRecord,
  ToolDescriptor,
  TurnId,
} from './types.js'

type Admitted = Extract<RuntimeRecord, { kind: 'input.admitted' }>
type Settled = Extract<RuntimeRecord, { kind: 'action.settled' }>
type ObjectValue = { [key: string]: JsonValue }
type Presentation = NonNullable<DecisionInputPolicy['presentation']>
type ActiveInput = { record: Admitted; policy: DecisionInputPolicy; toolResult: boolean }
interface HistoryEntry {
  recordIds: RecordId[]
  value: ObjectValue
  required: boolean
}
interface ResourceItem {
  ref: string
  data: ObjectValue
  pending?: string
}

function object(value: JsonValue | undefined): ObjectValue | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}
function text(blocks: readonly Content[]): string {
  return blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : [])).join('\n\n')
}
function prose(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}
function presentation(item: ActiveInput): Presentation {
  if (item.policy.presentation !== undefined) return item.policy.presentation
  if (item.policy.content !== undefined) return [{ value: item.policy.content }]
  return item.record.input.content.flatMap((block) => (block.kind === 'text' ? [{ value: block.text }] : []))
}
function scope(entry: Presentation[number], source: string): string {
  return entry.scope ?? (source === 'system-prompt' ? 'session' : 'as declared in the source text')
}

function treeLiteral(value: JsonValue): string {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

/** Render only recorded children; quoted names cannot introduce additional tree lines. */
function workspaceTree(entries: readonly JsonValue[]): string {
  return entries
    .map((value, index) => {
      const entry = object(value)
      const kind = entry?.kind ?? 'unknown'
      const labels =
        kind === 'directory' ? ['unexpanded'] : kind === 'file' ? ['file'] : [`kind=${treeLiteral(kind)}`]
      if (entry?.size !== undefined)
        labels.push(typeof entry.size === 'number' ? `${entry.size} B` : `size=${treeLiteral(entry.size)}`)
      return `${index === entries.length - 1 ? '`--' : '|--'} ${treeLiteral(entry?.path ?? '')}${kind === 'directory' ? '/' : ''} [${labels.join(', ')}]`
    })
    .join('\n')
}

function textPath(value: JsonValue, output: string): readonly string[] | undefined {
  if (value === output) return []
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const path = textPath(child, output)
    if (path !== undefined) return [key, ...path]
  }
  return undefined
}

function replaceAt(value: JsonValue, path: readonly string[], replacement: JsonValue): JsonValue | undefined {
  const [key, ...rest] = path
  if (key === undefined) return replacement
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    const child = value[Number(key)]
    if (child === undefined) return
    const next = replaceAt(child, rest, replacement)
    return next === undefined ? undefined : value.map((item, index) => (String(index) === key ? next : item))
  }
  const child = value[key]
  if (child === undefined) return
  const next = replaceAt(child, rest, replacement)
  return next === undefined ? undefined : { ...value, [key]: next }
}

/** Share the two original excerpts between one repeated body and its metadata. */
function combinedEvidence(
  value: JsonValue,
  output: string,
  excerptBytes: number,
): ReturnType<typeof decisionEvidence> | undefined {
  const path = textPath(value, output)
  if (path === undefined) return
  const metadata = replaceAt(value, path, '')
  if (metadata === undefined) return
  const metadataView = decisionEvidence(metadata, excerptBytes)
  const bodyBytes = excerptBytes + excerptBytes - bytes(metadataView.value) + bytes('')
  if (bodyBytes < bytes('')) return
  const bodyView = decisionEvidence(output, bodyBytes)
  const combined = replaceAt(metadataView.value, path, bodyView.value)
  if (combined === undefined) return
  const pointer = path.map((key) => `/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')
  return {
    value: combined,
    projection: {
      truncated: metadataView.projection.truncated || bodyView.projection.truncated,
      truncatedPaths: [
        ...metadataView.projection.truncatedPaths,
        ...bodyView.projection.truncatedPaths.map((item) => `${pointer}${item}`),
      ],
      originalBytes: bytes(value),
    },
  }
}

/** Required requests, effective rules and unresolved effects cannot be silently clipped. */
export class DecisionContextOverflow extends Error {}

/** Incremental source replacement with a pure model view independent of language history. */
export class DecisionContextProjection {
  private readonly inputs = new Map<string, ActiveInput>()
  private readonly pendingToolInputs = new Map<string, number>()
  private readonly loadedInstructions = new Map<
    string,
    {
      record: Settled
      source: string
      scope: string
      content: JsonValue
      data: JsonValue
    }
  >()
  private toolSnapshot: { profiles: readonly DecisionToolProfile[]; sourceRecordId: RecordId } | undefined
  private readonly observedResources = new Map<
    string,
    {
      items: Map<string, ResourceItem>
      coverage: JsonValue
      complete: boolean
    }
  >()
  private nextResourceRef = 1
  private supersededInputs = 0

  /** @param port - host interpretation, declared instruction priorities and resolved display limits. */
  constructor(private readonly port: DecisionContextPort) {
    if (!port.instructionOrder.trim())
      throw new DecisionContextOverflow('Decision context requires a declared instruction order')
    for (const [key, value] of Object.entries(port.config)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new DecisionContextOverflow(`Invalid decision context ${key}`)
    }
  }

  /**
   * Retain effective instructions and resource facts from a committed record.
   * @param record - validated committed fact, supplied in ledger order on live operation and replay.
   */
  append(record: RuntimeRecord): void {
    switch (record.kind) {
      case 'input.admitted': {
        const pending = this.pendingToolInputs.get(record.input.id) ?? 0
        if (pending > 1) this.pendingToolInputs.set(record.input.id, pending - 1)
        else this.pendingToolInputs.delete(record.input.id)
        const policy: DecisionInputPolicy = pending ? { kind: 'context' } : this.port.classify(record.input)
        if (policy.resetGroup && policy.group !== undefined) {
          for (const [key, prior] of this.inputs) {
            if (prior.policy.group === policy.group && this.inputs.delete(key)) this.supersededInputs++
          }
        }
        const key =
          policy.replaceKey === undefined
            ? `record:${record.id}`
            : `snapshot:${policy.kind}:${policy.replaceKey}`
        if (this.inputs.delete(key)) this.supersededInputs++
        this.inputs.set(key, { record, policy, toolResult: pending > 0 })
        break
      }
      case 'action.settled':
        for (const observation of record.observations) {
          const described = this.port.describeObservation?.({ ...observation, sourceRecordId: record.id })
          for (const update of described?.resources ?? []) {
            const previous = this.observedResources.get(update.name)
            const collection = {
              items: update.complete
                ? new Map<string, ResourceItem>()
                : (previous?.items ?? new Map<string, ResourceItem>()),
              coverage: update.coverage,
              complete: update.complete,
            }
            for (const item of update.items) {
              const prior = previous?.items.get(item.key)
              const pending = item.pending === undefined ? prior?.pending : (item.pending ?? undefined)
              collection.items.set(item.key, {
                ref: prior?.ref ?? `resource:${this.nextResourceRef++}`,
                data: { ...(update.complete ? {} : prior?.data), ...item.data },
                ...(pending === undefined ? {} : { pending }),
              })
            }
            this.observedResources.set(update.name, collection)
          }
          const instruction = described?.instruction
          if (instruction !== undefined) {
            this.loadedInstructions.delete(instruction.replaceKey)
            this.loadedInstructions.set(instruction.replaceKey, {
              record,
              source: instruction.source ?? observation.source,
              scope: instruction.scope ?? 'as declared in the loaded instructions',
              content: instruction.content,
              data: described === undefined ? observation.data : described.data,
            })
          }
        }
        for (const addition of record.outcome.directive.additions) {
          this.pendingToolInputs.set(addition.id, (this.pendingToolInputs.get(addition.id) ?? 0) + 1)
        }
        break
      case 'resource.observed': {
        const profiles = readDecisionToolSnapshot(record.resource)
        if (profiles !== undefined) this.toolSnapshot = { profiles, sourceRecordId: record.id }
        break
      }
      default:
        // Execution and model settlements remain owned by the causal ledger reducer.
        break
    }
  }

  /**
   * Identify the committed inputs represented by the current projection.
   * @returns source IDs still effective after producer replacement and group reset.
   */
  activeInputSourceIds(): readonly RecordId[] {
    return [...this.inputs.values()].map((item) => item.record.id)
  }

  /**
   * Expose the recorded operation guidance for catalog matching.
   * @returns the latest recorded operation profiles, including a deliberately empty catalog.
   */
  toolProfiles(): readonly DecisionToolProfile[] | undefined {
    return this.toolSnapshot?.profiles
  }

  /**
   * Match recorded guidance to executable tool revisions.
   * @param tools - current scoped executable catalog.
   * @returns profiles applicable to this exact catalog.
   */
  profilesFor(tools: readonly ToolDescriptor[]): readonly DecisionToolProfile[] {
    return tools.flatMap((tool) => {
      const profile = this.toolSnapshot?.profiles.find(
        (item) => item.operation === tool.name && item.toolRevision === tool.revision,
      )
      if (profile === undefined) return []
      if (decisionToolPhases(tool, profile).length === 0) throw new InvalidDecisionToolSnapshot()
      return [profile]
    })
  }

  /**
   * Render the Jev state without modifying language input or persisted facts.
   * @param turn - active runtime turn.
   * @param execution - replay at the same committed prefix.
   * @param environment - current recorded environment.
   * @param tools - current executable catalog.
   * @param history - independently reconstructed language history for accepted answers.
   * @returns detached decision facts; required data exceeding the budget throws.
   */
  view(
    turn: TurnId,
    execution: ReplayState,
    environment: JsonValue,
    tools: readonly ToolDescriptor[],
    history: readonly InputFact[],
  ): JsonValue {
    return this.project(turn, execution, environment, tools, history).state
  }

  /**
   * Render model facts and retain precise source references outside the model state.
   * @param turn - active runtime turn.
   * @param execution - committed causal ledger.
   * @param environment - recorded execution facts.
   * @param tools - current executable catalog.
   * @param languageHistory - independent language history; never shortened by this projection.
   * @returns model state and source IDs whose complete evidence is displayed.
   */
  project(
    turn: TurnId,
    execution: ReplayState,
    environment: JsonValue,
    tools: readonly ToolDescriptor[],
    languageHistory: readonly InputFact[],
  ): { state: JsonValue; sourceRecordIds: readonly RecordId[] } {
    const limits = this.port.config
    const profiles = this.profilesFor(tools)
    const active = [...this.inputs.values()]
    const activeById = new Map(active.map((item) => [item.record.id, item]))
    const environmentView = object(this.port.describeEnvironment?.(environment) ?? environment)
    if (environmentView === undefined)
      throw new DecisionContextOverflow('Decision environment must contain named facts')
    const namedEnvironment = { ...environmentView }
    const requests: string[] = []
    const requestRefs = new Map<RecordId, string>()
    const resources: ObjectValue = {}
    const rules: JsonValue[] = [
      { source: 'runtime:instruction-order', scope: 'session', text: this.port.instructionOrder },
      {
        source: 'runtime:decision-guidance',
        scope: 'all questions in this request',
        text: DECISION_GUIDANCE,
      },
    ]
    const sourceIds = new Set<RecordId>()
    const coverage: ObjectValue = {}
    const entries: HistoryEntry[] = []
    const pending: JsonValue[] = []
    for (const [name, collection] of this.observedResources) {
      resources[name] = {
        items: [...collection.items.values()].map((item) => ({ ...item.data, ref: item.ref })),
        coverage: {
          latestObservation: collection.coverage,
          complete: collection.complete,
          freshness: 'last observed state',
        },
      }
      for (const item of collection.items.values())
        if (item.pending !== undefined) {
          pending.push({ kind: 'resource', ref: item.ref, status: item.pending })
        }
    }
    const bounded = (
      value: JsonValue,
      name: string,
      limit = limits.excerptBytes,
      repeatedText?: string,
    ): {
      value: JsonValue
      complete: boolean
      combined: boolean
    } => {
      const combined = repeatedText === undefined ? undefined : combinedEvidence(value, repeatedText, limit)
      const result = combined ?? decisionEvidence(value, limit)
      if (result.projection.truncated)
        coverage[name] = {
          retained: 'displayed excerpt',
          omitted: 'unknown',
          reason: 'decision display limit',
        }
      return { value: result.value, complete: !result.projection.truncated, combined: combined !== undefined }
    }
    const mergeResource = (name: string, value: JsonValue): void => {
      if (name === 'loadedSkills') {
        const prior = object(resources[name])
        const next = object(value)
        const items = [
          ...(Array.isArray(prior?.items) ? prior.items : []),
          ...(Array.isArray(next?.items) ? next.items : []),
        ]
        resources[name] = {
          items: [...new Map(items.map((item) => [JSON.stringify(item), item])).values()],
          coverage: { scope: 'loaded skills in this session', complete: true },
        }
      } else resources[name] = value
    }
    for (const item of active) {
      if (item.policy.kind === 'task' && item.record.turn === turn) {
        const body = text(item.record.input.content)
        if (body.length) {
          requestRefs.set(item.record.id, `request:${requests.length}`)
          requests.push(body)
        }
      }
      let complete = item.policy.content === undefined && item.policy.presentation === undefined
      for (const entry of presentation(item)) {
        if (item.policy.kind === 'task') continue
        const role = entry.role ?? (item.policy.kind === 'instructions' ? 'constraint' : 'context')
        if (role === 'constraint') {
          if (
            entry.operation !== undefined &&
            profiles.some((profile) => profile.operation === entry.operation)
          )
            continue
          const body = prose(entry.value)
          if (body)
            rules.push({
              source: entry.source ?? item.record.input.source,
              scope: scope(entry, item.record.input.source),
              text: body,
            })
        } else if (role === 'environment') Object.assign(namedEnvironment, object(entry.value))
        else if (role === 'resource' || role === 'capability') {
          mergeResource(
            entry.label ?? item.record.input.source,
            role === 'capability'
              ? {
                  items: Array.isArray(entry.value) ? entry.value : [entry.value],
                  coverage: { scope: item.record.input.source, complete: true },
                }
              : entry.value,
          )
        }
      }
      if (item.record.input.content.length === 1 && item.record.input.content[0]?.kind === 'text') {
        complete ||=
          presentation(item)
            .map((entry) => (typeof entry.value === 'string' ? entry.value : ''))
            .join('\n\n') === item.record.input.content[0].text
      }
      if (complete) sourceIds.add(item.record.id)
    }
    Object.assign(namedEnvironment, environmentView)
    for (const instruction of this.loadedInstructions.values()) {
      rules.push({ source: instruction.source, scope: instruction.scope, text: prose(instruction.content) })
      mergeResource('loadedSkills', {
        items: [instruction.data],
        coverage: { scope: 'loaded skills', complete: true },
      })
    }

    const actionRecords = execution.records.filter((record) => record.kind === 'action.intended')
    const stepRefs = new Map(actionRecords.map((record, index) => [record.intent.id, `step:${index + 1}`]))
    const lastActions = new Set(actionRecords.slice(-limits.recentActions).map((record) => record.intent.id))
    const visibleObservations = new Set(execution.observations.slice(-limits.observationCount))
    const answers = new Map(
      languageHistory.filter((input) => input.source === 'assistant').map((input) => [input.id, input]),
    )
    const latestFeedback = execution.records.findLast(
      (record) =>
        record.turn === turn &&
        record.kind === 'resource.observed' &&
        readFeedback(record.resource) !== undefined,
    )
    const latestWorkspace = execution.records.findLast(
      (record) =>
        record.kind === 'resource.observed' && object(record.resource)?.kind === 'jev.workspace-directory.v1',
    )
    const workspaceRoot =
      latestWorkspace?.kind === 'resource.observed' ? object(latestWorkspace.resource)?.root : undefined
    const latestSkillCatalog = execution.records.findLast(
      (record) =>
        record.kind === 'resource.observed' && object(record.resource)?.kind === 'jev.skill-catalog.v1',
    )
    let workspace: JsonValue | undefined
    let observationNumber = 0
    let answerNumber = 0
    let oldActions = 0
    let oldObservations = 0
    const attachmentItems: JsonValue[] = []
    const admittedAttachments = execution.records.flatMap((record) => {
      if (record.kind !== 'resource.observed') return []
      const value = object(record.resource)
      return value?.kind === 'jev.attachment.v1' ? [value] : []
    })
    for (const record of execution.records) {
      if (record.kind === 'input.admitted') {
        const item = activeById.get(record.id)
        if (item === undefined) continue
        const ref = requestRefs.get(record.id)
        if (item.policy.kind === 'task') {
          const inputRef = ref ?? `user:${entries.filter((entry) => entry.value.kind === 'user').length + 1}`
          entries.push({
            recordIds: [record.id],
            required: true,
            value:
              ref === undefined
                ? { kind: 'user', ref: inputRef, text: text(record.input.content) }
                : { kind: 'request', ref },
          })
          for (const block of record.input.content)
            if (block.kind === 'artifact') {
              const admitted = admittedAttachments.find(
                (value) => value.attachmentId === block.artifact.digest,
              )
              const reference: ObjectValue =
                admitted === undefined
                  ? { id: block.artifact.id, mediaType: block.artifact.mediaType, size: block.artifact.size }
                  : {
                      id: admitted.attachmentId ?? '',
                      size: admitted.bytes ?? block.artifact.size,
                      ...(admitted.mediaType === undefined ? {} : { mediaType: admitted.mediaType }),
                      ...(admitted.width === undefined
                        ? {}
                        : { width: admitted.width, height: admitted.height ?? null }),
                    }
              attachmentItems.push({
                ref: `attachment:${attachmentItems.length + 1}`,
                inputRef,
                reference,
                visibility: 'metadata only',
                contentObserved: false,
                ...(block.label === undefined ? {} : { name: block.label }),
              })
            }
        } else {
          const displayed = presentation(item).filter(
            (entry) =>
              (entry.role ?? (item.policy.kind === 'instructions' ? 'constraint' : 'context')) === 'context',
          )
          for (const entry of displayed)
            entries.push({
              recordIds: [record.id],
              required: false,
              value: {
                kind: 'observation',
                name: entry.label ?? record.input.source,
                data: entry.value,
                scope: scope(entry, record.input.source),
                coverage: { complete: true, authority: 'evidence' },
              },
            })
        }
      }
      if (record.kind === 'action.intended') {
        const settled = execution.actions.get(record.intent.id)
        const unresolved = execution.unresolved.includes(record.intent.id)
        const step = stepRefs.get(record.intent.id)
        if (step === undefined) throw new Error('Missing action reference')
        if (settled === undefined)
          pending.push({
            kind: 'action',
            ref: step,
            status: execution.dispatching.has(record.intent.id) ? 'dispatched' : 'not dispatched',
          })
        if (unresolved)
          pending.push({
            kind: 'unknown_effect',
            ref: step,
            status: 'unresolved',
            reason: 'The effect has not been confirmed.',
          })
        if (settled === undefined)
          entries.push({
            recordIds: [record.id],
            required: true,
            value: {
              kind: 'action',
              step,
              operation: record.intent.tool,
              arguments: { ...record.intent.arguments },
              status: 'pending',
              effect: 'unknown',
            },
          })
      }
      if (record.kind === 'action.settled') {
        const intent = execution.intents.get(record.intentId)
        const step = stepRefs.get(record.intentId)
        if (intent === undefined || step === undefined)
          throw new Error('Decision action has no recorded intent')
        const unresolved = execution.unresolved.includes(record.intentId)
        if (!lastActions.has(record.intentId) && !unresolved) {
          oldActions++
          continue
        }
        const argumentsView = bounded({ ...intent.arguments }, `${step}.arguments`)
        const result: ObjectValue = {}
        const observations = execution.observations.filter((item) => item.sourceRecordId === record.id)
        const shown = observations.filter((item) => visibleObservations.has(item))
        oldObservations += observations.length - shown.length
        const data: JsonValue[] = []
        const output = text(record.outcome.content)
        let outputIncluded = false
        let complete = shown.length === observations.length
        for (const [index, observation] of shown.entries()) {
          const semantic = this.port.describeObservation?.(observation) ?? observation
          const value = bounded(
            semantic.data,
            `${step}.result.${index}`,
            limits.excerptBytes,
            output && !outputIncluded ? output : undefined,
          )
          outputIncluded ||= value.combined
          const sourceCoverage = bounded(
            semantic.coverage === undefined ? (observation.coverage ?? {}) : semantic.coverage,
            `${step}.coverage.${index}`,
          )
          complete &&= value.complete && sourceCoverage.complete
          const laterChange = execution.records
            .slice(execution.records.indexOf(record) + 1)
            .some(
              (later) =>
                later.kind === 'action.settled' &&
                execution.intents.get(later.intentId)?.effectClass !== 'read_only' &&
                later.effect !== 'none' &&
                later.effect !== 'not_applied' &&
                execution.resolutions.get(later.intentId)?.resolution !== 'confirmed_not_applied',
            )
          data.push({
            ...(value.value !== null && typeof value.value === 'object' && !Array.isArray(value.value)
              ? value.value
              : { value: value.value }),
            coverage: sourceCoverage.value,
            laterChanges: laterChange ? 'changed' : 'unknown',
            ...(observation.references?.length
              ? { references: observation.references.map((reference) => ({ ...reference })) }
              : {}),
          })
        }
        if (data.length) result.data = data.length === 1 ? (data[0] ?? null) : data
        else if (record.outcome.value !== undefined) {
          const value = bounded(
            record.outcome.value,
            `${step}.result`,
            limits.excerptBytes,
            output || undefined,
          )
          outputIncluded = value.combined
          result.data = value.value
          complete &&= value.complete
        }
        if (output && !outputIncluded) {
          const value = bounded(output, `${step}.text`)
          result.text = value.value
          complete &&= value.complete
        }
        if (record.outcome.error !== undefined) {
          const value = bounded(record.outcome.error.message, `${step}.error`)
          const details =
            record.outcome.error.data === undefined
              ? undefined
              : bounded(record.outcome.error.data, `${step}.error.details`)
          result.error = {
            code: record.outcome.error.code,
            message: value.value,
            ...(details === undefined ? {} : { details: details.value }),
          }
          complete &&= value.complete && (details?.complete ?? true)
        }
        const resultArtifacts = record.outcome.content.flatMap((block) =>
          block.kind === 'artifact'
            ? [{ reference: { ...block.artifact }, visibility: 'metadata only', contentObserved: false }]
            : [],
        )
        if (resultArtifacts.length) result.attachments = resultArtifacts
        result.coverage = {
          authority: 'tool evidence',
          observations: { retained: shown.length, omitted: observations.length - shown.length },
        }
        const resultView = bounded(result, `${step}.result`, limits.maxEvidenceBytes)
        complete &&= resultView.complete
        const resolution = execution.resolutions.get(record.intentId)
        const effect =
          resolution?.resolution === 'confirmed_applied'
            ? 'applied'
            : resolution?.resolution === 'confirmed_not_applied'
              ? 'not_applied'
              : record.effect === 'acknowledged'
                ? 'unknown'
                : record.effect
        entries.push({
          recordIds: complete ? [record.id] : [],
          required: unresolved,
          value: {
            kind: 'action',
            step,
            operation: intent.tool,
            arguments: object(argumentsView.value) ?? {},
            status:
              record.effect === 'acknowledged' && record.outcome.kind === 'success'
                ? 'accepted'
                : record.outcome.kind === 'success'
                  ? 'succeeded'
                  : record.outcome.kind === 'error'
                    ? 'failed'
                    : 'cancelled',
            effect,
            result: resultView.value,
            ...(resolution === undefined
              ? {}
              : {
                  resolution: {
                    status: resolution.resolution,
                    actor: resolution.actor,
                    reason: resolution.explanation,
                  },
                }),
          },
        })
      }
      if (record.kind === 'model.settled') {
        const answer = answers.get(`answer:${record.id}`)
        if (answer !== undefined) {
          const ref = `answer:${++answerNumber}`
          const body = bounded(text(answer.content), `${ref}.text`)
          entries.push({
            recordIds: [],
            required: false,
            value: {
              kind: 'answer',
              ref,
              text: typeof body.value === 'string' ? body.value : '',
              status: 'complete',
            },
          })
        }
      }
      if (
        record.kind !== 'resource.observed' ||
        readDecisionToolSnapshot(record.resource) !== undefined ||
        isCandidateDiagnostic(record.resource)
      )
        continue
      observationNumber++
      const resource = object(record.resource)
      if (resource?.kind === 'jev.workspace-directory.v1') {
        if (record === latestWorkspace) {
          const changed = execution.records
            .slice(execution.records.indexOf(record) + 1)
            .some(
              (later) =>
                later.kind === 'action.settled' &&
                execution.intents.get(later.intentId)?.effectClass !== 'read_only' &&
                later.effect !== 'none' &&
                later.effect !== 'not_applied',
            )
          const root =
            typeof resource.root === 'string' &&
            typeof namedEnvironment.cwd === 'string' &&
            resource.root === namedEnvironment.cwd
              ? { ref: 'environment.cwd' }
              : (resource.root ?? '')
          workspace = {
            root,
            tree: workspaceTree(Array.isArray(resource.entries) ? resource.entries : []),
            coverage: {
              depth: 1,
              complete: resource.complete ?? false,
              contentRead: false,
              observedAt: `observation:${observationNumber}`,
              laterChanges: changed ? 'changed' : 'unknown',
              omitted: resource.omitted ?? 'unknown',
              ...(resource.status === 'unavailable' ? { reason: 'workspace observation unavailable' } : {}),
            },
          }
          sourceIds.add(record.id)
        }
        entries.push({
          recordIds: [],
          required: record === latestWorkspace,
          value: {
            kind: 'observation',
            ref: `observation:${observationNumber}`,
            name: 'workspace directory',
            data:
              record === latestWorkspace
                ? { ref: 'workspace' }
                : {
                    ...(typeof resource.root === 'string' ? {} : { root: resource.root ?? '' }),
                    superseded: true,
                  },
            scope:
              typeof resource.root === 'string'
                ? resource.root === workspaceRoot
                  ? { ref: 'workspace.root' }
                  : resource.root
                : 'workspace',
            coverage: { complete: resource.complete ?? false },
          },
        })
        continue
      }
      if (resource?.kind === 'jev.skill-catalog.v1') {
        if (record !== latestSkillCatalog) continue
        mergeResource('skills', {
          items: resource.entries ?? [],
          coverage: {
            scope: 'available skills',
            complete: true,
            instructionsLoaded: false,
            ...(typeof resource.retrieval === 'string' && resource.retrieval.trim() !== ''
              ? { retrieval: resource.retrieval }
              : {}),
          },
        })
        sourceIds.add(record.id)
        continue
      }
      if (resource?.kind === 'jev.skill-loaded.v1') continue
      if (resource?.kind === 'jev.attachment.v1') continue
      const feedback = readFeedback(record.resource)
      const value: JsonValue =
        feedback === undefined
          ? record.resource
          : {
              code: feedback.code,
              stage: feedback.stage,
              ...(feedback.operation === null ? {} : { operation: feedback.operation }),
              message: feedback.message,
            }
      const displayed = bounded(value, `observation:${observationNumber}`)
      entries.push({
        recordIds: displayed.complete ? [record.id] : [],
        required: record === latestFeedback,
        value: {
          kind: 'observation',
          name:
            feedback === undefined
              ? typeof resource?.kind === 'string'
                ? resource.kind
                : 'recorded resource'
              : 'runtime feedback',
          data: displayed.value,
          scope: 'session',
          coverage: {
            complete: displayed.complete,
            authority: feedback === undefined ? 'evidence' : 'runtime status',
          },
        },
      })
    }
    const bodies = entries.flatMap((entry) => {
      const value =
        entry.value.kind === 'answer'
          ? entry.value.text
          : entry.value.kind === 'action'
            ? entry.value.result
            : undefined
      return value === undefined ? [] : [{ entry, size: bytes(value) }]
    })
    const latestResult = bodies.findLast((item) => item.entry.value.kind === 'action')?.entry
    let evidenceBytes = bodies.reduce((total, item) => total + item.size, 0)
    for (const { entry: removable, size } of bodies) {
      if (evidenceBytes <= limits.maxEvidenceBytes) break
      if (removable === latestResult || removable.required) continue
      evidenceBytes -= size
      removable.recordIds.length = 0
      if (removable.value.kind === 'answer') {
        delete removable.value.text
        removable.value.coverage = { text: 'omitted', reason: 'evidence byte limit' }
        if (typeof removable.value.ref === 'string') delete coverage[`${removable.value.ref}.text`]
      } else {
        delete removable.value.result
        coverage[`${typeof removable.value.step === 'string' ? removable.value.step : 'action'}.result`] = {
          retained: 'action status and arguments',
          omitted: 'unknown',
          reason: 'evidence byte limit',
        }
      }
    }
    if (evidenceBytes > limits.maxEvidenceBytes)
      throw new DecisionContextOverflow('Required action evidence exceeds its byte budget')
    if (attachmentItems.length)
      resources.attachments = {
        items: attachmentItems,
        coverage: { scope: 'retained admitted inputs', complete: true },
      }
    if (oldActions)
      coverage.history = {
        retained: 'recent actions and all unresolved actions',
        omitted: oldActions,
        reason: 'action display limit',
      }
    if (oldObservations)
      coverage.observations = {
        retained: 'recent action observations',
        omitted: oldObservations,
        reason: 'evidence display limit',
      }
    if (this.supersededInputs)
      coverage.rules = {
        retained: 'current effective sources',
        omitted: this.supersededInputs,
        reason: 'explicit source replacement',
      }
    // Keep older context before the current request; moving the whole sections changes decision behavior.
    // Segment retained records only: this view must not add a new history-compaction policy.
    const segmentedHistory = (): ObjectValue => {
      const boundary = entries.findIndex((entry) => entry.value.kind === 'request')
      const index = boundary < 0 ? entries.length : boundary
      return {
        before_current_request: entries.slice(0, index).map((entry) => entry.value),
        since_current_request: entries.slice(index).map((entry) => entry.value),
      }
    }
    const state: ObjectValue = {
      rules,
      environment: namedEnvironment,
      ...(workspace === undefined ? {} : { workspace }),
      ...(Object.keys(resources).length ? { resources } : {}),
      history: segmentedHistory(),
      pending,
      ...(Object.keys(coverage).length ? { coverage } : {}),
      task: { requests },
      operations: compileDecisionTools(tools, profiles),
    }
    while (bytes(state) > limits.maxStateBytes) {
      const index = entries.findIndex((entry) => !entry.required)
      if (index < 0)
        throw new DecisionContextOverflow(
          'Decision context exceeds its byte budget; requests, effective rules and pending references were retained',
        )
      entries.splice(index, 1)
      state.history = segmentedHistory()
      const removed = object(coverage.history)?.omitted
      coverage.history = {
        retained: 'displayed history and all required references',
        omitted: typeof removed === 'number' ? removed + 1 : 1,
        reason: 'decision state byte limit',
      }
      state.coverage = coverage
    }
    for (const entry of entries) for (const id of entry.recordIds) sourceIds.add(id)
    return { state: structuredClone(state), sourceRecordIds: [...sourceIds] }
  }
}

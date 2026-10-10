import { resolve } from 'node:path'
import { canonicalJson, type RegisteredTool, type SessionImpl, sha256Hex } from '@agnes/core'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type {
  Candidate,
  CandidateEvidence,
  CandidateId,
  DecisionToolProfile,
  FrozenIntent,
  JsonValue,
  RuntimeLedger,
  RuntimePorts,
  ToolDescriptor,
  ToolSemantics,
} from '@agnes/jev-runtime'
import { validateAgainst } from '@agnes/protocol'
import { createToolSemantics } from '@agnes/runtime-jev'
import { verifiedChildControlTool } from './jev-child-tools.js'
import { operationCandidates } from './jev-operation-candidates.js'
import { verifiedOperationProfile } from './jev-operation-profiles.js'
import { observeBuiltinProcess } from './jev-process-observation.js'
import { bundledToolProfile } from './jev-tool-profiles.js'
import { workspaceCandidates } from './jev-workspace-candidates.js'

// Pinned reviewed builtin contract (description + full metadata + parameter schema).
// Host must not import the package it loads. The companion test checks this pin against
// the actual tools-core export; replacement definitions receive no privileged semantics.
const ASK_USER_NAME = 'ask_user_question'
const ASK_USER_CONTRACT = '52c33bff5ec9dda6aea2445bf704ddb5832a6242300c5fc436c3ac7b0c9d14c4'
const FACT_CODEC = 'agnes-host-tool-fact-v1'
const VERSION_CODEC = 'agnes-read-version-v1'
const PRECONDITION_CODEC = 'agnes-read-continuation-v1'
const MAX_READ_BYTES = 4 * 1024 * 1024
const WRITE_ATTEMPT_CODEC = 'agnes-host-builtin-file-write-attempt-v1'
const READ_CONTRACT = '4b1f0de2319f7b4f87a954bbcdd3590752e56f05d761d116d157c69fd122aa52'
const SHELL_CONTRACT = 'a89f61012c7ca463d66b4da6c96877374bf8a37c442966c8cc06af32099a496b'
const MUTATION_CONTRACTS: Record<string, string> = {
  write: 'a711ee1330011c7c80e44448cc002cf3e0a27ec3b0897e937cf53e3fd3f94814',
  edit: '8d9d9d323c8a34a71f2629b7a002d47b4d47e16f9968acbc4e96a46d030e4aea',
}
const observedWriteMetadata = new WeakSet<object>()
const observedWriteFailures = new WeakMap<object, JsonValue>()

/** Only metadata minted by this Host observer can prove that the filesystem write was not entered. */
export function observedBuiltinWriteNotEntered(intent: FrozenIntent, meta: JsonValue | undefined): boolean {
  if (!meta || typeof meta !== 'object' || !observedWriteMetadata.has(meta)) return false
  const attempt = object(object(meta)?.fileWriteAttempt)
  return (
    attempt?.codec === WRITE_ATTEMPT_CODEC &&
    attempt.intentId === intent.id &&
    attempt.tool === intent.tool &&
    attempt.toolRevision === intent.toolRevision &&
    attempt.intentDigest === sha256Hex(canonicalJson(intent)) &&
    attempt.completed === true &&
    attempt.writeCalls === 0
  )
}

export function observedBuiltinWriteFailure(error: unknown): JsonValue | undefined {
  return error !== null && typeof error === 'object' ? observedWriteFailures.get(error) : undefined
}

export function observedBuiltinWriteVersionRefusal(
  intent: FrozenIntent,
  meta: JsonValue | undefined,
): boolean {
  return (
    observedBuiltinWriteNotEntered(intent, meta) &&
    object(object(meta)?.fileWriteAttempt)?.versionRefusal === true
  )
}

class ObservedWriteFailure extends Error {
  constructor(error: unknown, meta: JsonValue) {
    super(error instanceof Error ? error.message : 'Builtin file mutation failed', { cause: error })
    this.name = 'ObservedWriteFailure'
    observedWriteFailures.set(this, meta)
  }
}
const pathSchema = { minLength: 1, maxLength: 4096, type: 'string' }
const positive = { minimum: 1, type: 'integer' }
const schema = (properties: Record<string, JsonValue>, required: string[] = []) => ({
  additionalProperties: false,
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})
const SCHEMAS: Record<string, JsonValue> = {
  read: schema({ path: pathSchema, offset: positive, limit: positive }, ['path']),
  write: schema({ path: pathSchema, content: { type: 'string' } }, ['path', 'content']),
  edit: schema(
    {
      path: pathSchema,
      edits: {
        type: 'array',
        minItems: 1,
        items: schema({ oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, [
          'oldText',
          'newText',
        ]),
      },
    },
    ['path', 'edits'],
  ),
  find: schema(
    {
      pattern: { minLength: 1, type: 'string' },
      path: pathSchema,
      limit: { minimum: 1, maximum: 10000, type: 'integer' },
    },
    ['pattern'],
  ),
  grep: schema(
    {
      pattern: { minLength: 1, type: 'string' },
      path: pathSchema,
      glob: { type: 'string' },
      ignoreCase: { type: 'boolean' },
      literal: { type: 'boolean' },
      context: { minimum: 0, maximum: 10, type: 'integer' },
      limit: { minimum: 1, maximum: 1000, type: 'integer' },
    },
    ['pattern'],
  ),
  ls: schema({ path: pathSchema, limit: { minimum: 1, maximum: 5000, type: 'integer' } }),
}
const object = (value: unknown): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

export interface JevToolSemanticsOptions {
  session: SessionImpl
  ledger: RuntimeLedger<number>
  readPageLines?: number
}

export interface JevToolCompanions {
  semantics: ToolSemantics
  effectClass(tool: { name: string; revision: string }): 'external_write' | undefined
  isQuestionTool(tool: { name: string; revision: string }): boolean
  describeTool(tool: ToolDescriptor): DecisionToolProfile | undefined
  validatePreconditions(preconditions: JsonValue, tool: ToolDescriptor, args: JsonValue): Promise<boolean>
  observeExecution(
    intent: FrozenIntent,
    context: ToolContext,
    invoke: (context: ToolContext) => Promise<ToolResult>,
  ): Promise<{ result: ToolResult; meta?: JsonValue }>
  reconcileEffect: NonNullable<RuntimePorts<number>['effectRecovery']>['reconcile']
}

/**
 * Opt-in companions for verified bundled registrations. The portable runtime never infers tool
 * behavior from a name. Complete schemas and captured definition fingerprints bind this table;
 * replacement or otherwise unknown definitions remain in the ordinary executable catalog.
 */
export function createJevToolSemantics(options: JevToolSemanticsOptions): JevToolCompanions {
  const { session, ledger } = options
  const pageLines = options.readPageLines ?? 200
  if (!positiveInteger(pageLines)) throw new Error('readPageLines must be a positive integer')
  const registered = new Map<string, string>()
  const mutations = new Map<string, string>()
  let foregroundShellRevision: string | undefined
  const mutationAttempts = new Map<string, JsonValue>()
  const reads = new Map<string, JsonValue>()
  let recoveryReadRevision: string | undefined
  const recoveryVersions = new Map<string, JsonValue>()
  const recoveryProofs = new Map<string, string>()
  const parameterSchemas = new Map<string, RegisteredTool['parameters']>()
  const operationProfiles = new Map<string, DecisionToolProfile>()
  for (const definition of session.currentTools().snapshot(session.lastSeq).byName.values()) {
    if (
      definition.name === 'shell' &&
      definition.source.source === 'agnes/tools-core' &&
      definition.source.trust === 'builtin' &&
      definition.executionDomain === 'workspace' &&
      definition.classify === undefined &&
      definition.policyVersion === undefined &&
      sha256Hex(
        canonicalJson(
          JSON.parse(
            JSON.stringify({
              description: definition.description,
              meta: definition.meta,
              parameters: definition.parameters,
            }),
          ),
        ),
      ) === SHELL_CONTRACT
    )
      foregroundShellRevision = definition.definitionFingerprint
    if (
      definition.name === 'read' &&
      definition.source.source === 'agnes/tools-core' &&
      definition.source.trust === 'builtin' &&
      definition.executionDomain === 'workspace' &&
      definition.classify === undefined &&
      definition.policyVersion === undefined &&
      sha256Hex(
        canonicalJson(
          JSON.parse(
            JSON.stringify({
              description: definition.description,
              meta: definition.meta,
              parameters: definition.parameters,
            }),
          ),
        ),
      ) === READ_CONTRACT
    ) {
      recoveryReadRevision = definition.definitionFingerprint
      registered.set('read', definition.definitionFingerprint)
      parameterSchemas.set('read', definition.parameters)
    }
    if (
      MUTATION_CONTRACTS[definition.name] &&
      definition.source.source === 'agnes/tools-core' &&
      definition.source.trust === 'builtin' &&
      definition.executionDomain === 'workspace' &&
      definition.classify === undefined &&
      definition.policyVersion === undefined &&
      sha256Hex(
        canonicalJson(
          JSON.parse(
            JSON.stringify({
              description: definition.description,
              meta: definition.meta,
              parameters: definition.parameters,
            }),
          ),
        ),
      ) === MUTATION_CONTRACTS[definition.name]
    )
      mutations.set(definition.name, definition.definitionFingerprint)
    const profile = verifiedOperationProfile(definition, {
      name: definition.name,
      revision: definition.definitionFingerprint,
      description: definition.description,
      parameters: JSON.parse(JSON.stringify(definition.parameters)),
      output: {},
      effectClass: definition.meta.isReadOnly ? 'read_only' : 'workspace_mutation',
    })
    if (profile) {
      registered.set(definition.name, definition.definitionFingerprint)
      parameterSchemas.set(definition.name, definition.parameters)
      operationProfiles.set(definition.name, profile)
      continue
    }
    if (verifiedChildControlTool(definition)) {
      registered.set(definition.name, definition.definitionFingerprint)
      parameterSchemas.set(definition.name, definition.parameters)
      continue
    }
    if (
      definition.name === ASK_USER_NAME &&
      definition.source.source === 'agnes/tools-core' &&
      definition.source.trust === 'builtin' &&
      definition.executionDomain === 'workspace' &&
      definition.classify === undefined &&
      definition.policyVersion === undefined &&
      sha256Hex(
        canonicalJson(
          JSON.parse(
            JSON.stringify({
              description: definition.description,
              meta: definition.meta,
              parameters: definition.parameters,
            }),
          ),
        ),
      ) === ASK_USER_CONTRACT
    ) {
      registered.set(definition.name, definition.definitionFingerprint)
      parameterSchemas.set(definition.name, definition.parameters)
      continue
    }
    const expected = SCHEMAS[definition.name]
    const mutation = definition.name === 'write' || definition.name === 'edit'
    const source = definition.name === 'read' || mutation ? 'agnes/tools-core' : 'agnes/tools-search'
    if (
      expected &&
      definition.source.source === source &&
      definition.source.trust === 'builtin' &&
      definition.executionDomain === 'workspace' &&
      definition.meta.isReadOnly === !mutation &&
      canonicalJson(JSON.parse(JSON.stringify(definition.parameters))) === canonicalJson(expected)
    ) {
      registered.set(definition.name, definition.definitionFingerprint)
      parameterSchemas.set(definition.name, definition.parameters)
    }
  }
  const matching = (tool: { name: string; revision: string }) => registered.get(tool.name) === tool.revision
  const facts = (tool: ToolDescriptor, value: unknown) => {
    const fact = object(value)
    return matching(tool) && fact?.codec === FACT_CODEC && fact.tool === tool.name ? fact : undefined
  }
  const semantics: ToolSemantics = {
    *candidates(tool, _observations, epoch, context) {
      if (!matching(tool) || !context) return
      if (tool.name !== 'read' && tool.name !== 'ls') {
        for (const candidate of operationCandidates(tool, epoch, context, matching)) {
          if (
            validateAgainst(
              parameterSchemas.get(tool.name) as RegisteredTool['parameters'],
              candidate.arguments,
            ).ok
          )
            yield candidate
        }
        return
      }
      let emitted = 0
      const seen = new Set<string>()
      // A dispatched mutation invalidates prior discovery recipes. A later result must supply new evidence.
      const lastMutation = context.records.findLastIndex(
        (record) =>
          record.kind === 'candidate.invalidation' ||
          (record.kind === 'action.intended' && record.intent.effectClass !== 'read_only'),
      )
      for (const record of context.records.slice(lastMutation + 1).toReversed()) {
        if (
          record.kind !== 'action.settled' ||
          record.outcome.kind !== 'success' ||
          record.effect === 'unknown'
        )
          continue
        const intended = context.records.find(
          (item) => item.kind === 'action.intended' && item.intent.id === record.intentId,
        )
        if (
          intended?.kind !== 'action.intended' ||
          registered.get(intended.intent.tool) !== intended.intent.toolRevision
        )
          continue
        const source = facts(
          { ...tool, name: intended.intent.tool, revision: intended.intent.toolRevision },
          record.outcome.value,
        )
        if (!source) continue
        const offer = (
          args: Record<string, JsonValue>,
          fields: CandidateEvidence[],
          preconditions?: JsonValue,
        ): Candidate | undefined => {
          if (
            emitted >= context.limit ||
            !validateAgainst(parameterSchemas.get(tool.name) as RegisteredTool['parameters'], args).ok
          )
            return undefined
          const key = canonicalJson(args)
          if (seen.has(key)) return undefined
          seen.add(key)
          emitted++
          return {
            id: `agnes-${sha256Hex(canonicalJson({ tool: tool.name, revision: tool.revision, epoch, record: record.id, args }))}` as CandidateId,
            tool: tool.name,
            label: `${tool.name} ${String(args.path)}${args.offset ? ` from line ${args.offset}` : ''}`,
            arguments: args,
            sourceRecordIds: [record.id],
            toolRevision: tool.revision,
            environmentEpoch: epoch,
            evidence: fields,
            ...(preconditions ? { preconditions } : {}),
          }
        }
        const evidence = (pointer: string, value: JsonValue): CandidateEvidence => ({
          sourceRecordId: record.id,
          pointer,
          value,
        })
        if (tool.name === 'read' && (source.tool === 'write' || source.tool === 'edit')) {
          const target = object(source.target),
            write = object(source.write)
          if (
            target?.kind !== 'file' ||
            typeof target.path !== 'string' ||
            write?.acknowledged !== true ||
            write.versionSource !== 'submitted-utf8-bytes-sha256' ||
            typeof write.size !== 'number' ||
            !Number.isSafeInteger(write.size) ||
            write.size < 0 ||
            typeof write.digest !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(write.digest)
          )
            continue
          const candidate = offer({ path: target.path, offset: 1, limit: pageLines }, [
            evidence('/outcome/value/target/path', target.path),
            evidence('/outcome/value/write/acknowledged', true),
            evidence('/outcome/value/write/size', write.size),
            evidence('/outcome/value/write/digest', write.digest),
          ])
          if (candidate) yield candidate
        } else if (tool.name === 'read' && source.tool === 'read') {
          const target = object(source.target),
            page = object(source.page),
            coverage = object(source.coverage)
          const version = object(object(record.outcome.meta)?.readVersion)
          if (
            target?.kind !== 'file' ||
            typeof target.path !== 'string' ||
            coverage?.continuationSafe !== true ||
            coverage.sourceTruncated !== false ||
            coverage.lineContentTruncated !== false ||
            !positiveInteger(page?.nextOffset) ||
            !positiveInteger(page.lastLine) ||
            page.nextOffset !== page.lastLine + 1 ||
            !positiveInteger(page.totalLines) ||
            page.nextOffset > page.totalLines ||
            version?.codec !== VERSION_CODEC ||
            version.path !== target.path ||
            version.complete !== true ||
            typeof version.digest !== 'string' ||
            !Number.isSafeInteger(version.size)
          )
            continue
          const preconditions = {
            codec: PRECONDITION_CODEC,
            sourceRecordId: record.id,
            path: target.path,
            digest: version.digest,
            size: version.size as number,
          }
          const candidate = offer(
            { path: target.path, offset: page.nextOffset, limit: pageLines },
            [
              evidence('/outcome/value/target/path', target.path),
              evidence('/outcome/value/page/nextOffset', page.nextOffset),
              evidence('/outcome/meta/readVersion/digest', version.digest),
            ],
            preconditions,
          )
          if (candidate) yield candidate
        } else if (tool.name === 'read' && source.tool === 'find' && Array.isArray(source.paths)) {
          for (const [index, path] of source.paths.entries()) {
            if (typeof path !== 'string') continue
            // Discovery establishes a path, not current text MIME; use native format detection.
            const candidate = offer({ path }, [evidence(`/outcome/value/paths/${index}`, path)])
            if (candidate) yield candidate
          }
        } else if (tool.name === 'read' && source.tool === 'grep' && Array.isArray(source.matches)) {
          for (const [index, value] of source.matches.entries()) {
            const match = object(value)
            if (typeof match?.path !== 'string' || !positiveInteger(match.lineNumber)) continue
            // Historical matches do not bind current file bytes to text MIME.
            const candidate = offer({ path: match.path }, [
              evidence(`/outcome/value/matches/${index}/path`, match.path),
              evidence(`/outcome/value/matches/${index}/lineNumber`, match.lineNumber),
            ])
            if (candidate) yield candidate
          }
        } else if (source.tool === 'ls' && Array.isArray(source.entries)) {
          for (const [index, value] of source.entries.entries()) {
            const entry = object(value)
            if (typeof entry?.path !== 'string' || entry.kind !== (tool.name === 'read' ? 'file' : 'dir'))
              continue
            const args = { path: entry.path }
            const candidate = offer(args, [evidence(`/outcome/value/entries/${index}/path`, entry.path)])
            if (candidate) yield candidate
          }
        }
        if (emitted >= context.limit) return
      }
      for (const candidate of workspaceCandidates(
        tool,
        epoch,
        { ...context, limit: context.limit - emitted },
        session.d.cwd,
      )) {
        const key = canonicalJson(candidate.arguments)
        if (
          !seen.has(key) &&
          validateAgainst(
            parameterSchemas.get(tool.name) as RegisteredTool['parameters'],
            candidate.arguments,
          ).ok
        ) {
          seen.add(key)
          emitted++
          yield candidate
        }
      }
    },
    observations(tool, outcome) {
      const fact = facts(tool, outcome.value)
      if (!fact || outcome.kind !== 'success') return []
      return [
        {
          kind: 'agnes.filesystem',
          source: tool.name,
          data: fact,
          ...(fact.coverage ? { coverage: fact.coverage } : {}),
        },
      ]
    },
    // Host dispatch provenance always owns effect classification.
    effectDisposition() {
      return undefined
    },
  }
  const restoreRecoveryVersion = async (path: string): Promise<void> => {
    const records = (await ledger.read()).map((entry) => entry.record)
    for (let index = records.length - 1; index >= 0; index--) {
      const resolution = records[index]
      if (
        resolution?.kind !== 'action.resolved' ||
        resolution.actor !== 'host:effect-recovery' ||
        resolution.resolution !== 'reconciled_state'
      )
        continue
      const source = records
        .slice(0, index)
        .find(
          (record) =>
            record.kind === 'resource.observed' &&
            resolution.evidence.includes(record.id) &&
            object(record.resource)?.kind === 'jev.effect-recovery.proof.v1' &&
            object(record.resource)?.intentId === resolution.intentId &&
            object(record.resource)?.resolution === 'reconciled_state',
        )
      if (source?.kind !== 'resource.observed') continue
      const resource = object(source.resource)
      const proof = object(resource?.proof)
      const target = object(proof?.target)
      const version = object(proof?.currentVersion)
      if (target?.path !== path) continue
      const original = records.find(
        (record) => record.kind === 'action.intended' && record.intent.id === resolution.intentId,
      )
      const settlement = records.find((record) => record.id === resource?.settlementRecordId)
      const evidence = resource?.evidence
      const nested =
        settlement?.kind === 'action.settled'
          ? object(settlement.outcome.effectEvidence)?.nestedTools
          : undefined
      if (
        proof?.codec !== 'agnes-host-builtin-file-reconciliation-v1' ||
        proof.complete !== true ||
        proof.historyDisposition !== 'unknown-retained' ||
        typeof target.tool !== 'string' ||
        mutations.get(target.tool) !== target.toolRevision ||
        original?.kind !== 'action.intended' ||
        original.intent.tool !== target.tool ||
        original.intent.toolRevision !== target.toolRevision ||
        typeof original.intent.arguments.path !== 'string' ||
        resolve(session.d.cwd, original.intent.arguments.path) !== path ||
        settlement?.kind !== 'action.settled' ||
        settlement.intentId !== resolution.intentId ||
        settlement.effect !== 'unknown' ||
        !Array.isArray(nested) ||
        nested.some((item) => !['none', 'not_applied'].includes(String(object(item)?.effect))) ||
        !resolution.evidence.includes(settlement.id) ||
        !Array.isArray(evidence) ||
        !evidence.every((id) => typeof id === 'string' && resolution.evidence.includes(id)) ||
        !records
          .slice(records.indexOf(settlement) + 1, records.indexOf(source))
          .some(
            (record) =>
              record.kind === 'action.settled' &&
              evidence.includes(record.id) &&
              record.outcome.kind === 'success' &&
              record.effect === 'none' &&
              canonicalJson(object(record.outcome.meta)?.readVersion ?? null) ===
                canonicalJson(version ?? null) &&
              records.some(
                (read) =>
                  read.kind === 'action.intended' &&
                  read.intent.id === record.intentId &&
                  read.intent.effectClass === 'read_only' &&
                  read.intent.tool === 'read' &&
                  read.intent.toolRevision === recoveryReadRevision &&
                  typeof read.intent.arguments.path === 'string' &&
                  resolve(session.d.cwd, read.intent.arguments.path) === path,
              ),
          ) ||
        version?.codec !== VERSION_CODEC ||
        version.path !== path ||
        version.complete !== true ||
        typeof version.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(version.digest) ||
        !Number.isSafeInteger(version.size) ||
        (version.size as number) < 0 ||
        (version.size as number) > MAX_READ_BYTES
      )
        continue
      const consumed = records
        .slice(index + 1)
        .some(
          (record) =>
            record.kind === 'action.settled' &&
            record.outcome.kind === 'success' &&
            record.effect === 'acknowledged' &&
            records.some(
              (mutation) =>
                mutation.kind === 'action.intended' &&
                mutation.intent.id === record.intentId &&
                mutations.get(mutation.intent.tool) === mutation.intent.toolRevision &&
                typeof mutation.intent.arguments.path === 'string' &&
                resolve(session.d.cwd, mutation.intent.arguments.path) === path,
            ),
        )
      if (consumed) {
        recoveryVersions.delete(path)
        recoveryProofs.delete(path)
      } else if (recoveryProofs.get(path) !== source.id || !recoveryVersions.has(path)) {
        recoveryVersions.set(path, structuredClone(version))
        recoveryProofs.set(path, source.id)
      }
      return
    }
  }
  return {
    isQuestionTool: (tool) => matching(tool) && tool.name === ASK_USER_NAME,
    effectClass: (tool) =>
      matching(tool) &&
      (tool.name === ASK_USER_NAME ||
        tool.name === 'subagent_send_message' ||
        tool.name === 'subagent_interrupt')
        ? 'external_write'
        : undefined,
    describeTool: (tool) => {
      if (!matching(tool)) return undefined
      const operationProfile = operationProfiles.get(tool.name)
      if (operationProfile) return operationProfile
      if (tool.name === 'subagent_send_message' || tool.name === 'subagent_interrupt')
        return {
          operation: tool.name,
          toolRevision: tool.revision,
          phases: ['ACT'],
          selection:
            tool.name === 'subagent_send_message'
              ? 'Deliver a new message to a direct continuable child or your live direct parent.'
              : 'Interrupt the current turn of a direct continuable child.',
          inputs: tool.name === 'subagent_send_message' ? 'childKey and message' : 'childKey',
          result: 'Admission confirmation; collect the child to observe its resulting state or answer.',
          constraints: [
            'One-shot forks cannot continue.',
            'Delivery or interruption does not establish completion.',
            'Permanent subtree cancellation uses subagent_cancel.',
          ],
        }
      if (tool.name !== ASK_USER_NAME) return bundledToolProfile(tool)
      return {
        operation: tool.name,
        toolRevision: tool.revision,
        selection: 'Ask the user for a choice or missing information before proceeding.',
        phases: ['INSPECT', 'ACT', 'VERIFY'],
        inputs: 'questions with id, question, optional header, options and multi_select',
        result: 'Structured human answers with selected labels and optional custom text.',
        constraints: [
          'Answers do not authorize another operation.',
          'Do not automatically repeat or replay a question.',
        ],
      }
    },
    semantics: createToolSemantics(
      [...registered].map(([operation, revision]) => ({ operation, revision, semantics })),
    ),
    async observeExecution(intent, context, invoke) {
      if (
        intent.tool === 'shell' &&
        intent.arguments.background !== true &&
        foregroundShellRevision === intent.toolRevision &&
        session.currentTools().snapshot(session.lastSeq).byName.get('shell')?.definitionFingerprint ===
          intent.toolRevision
      )
        return observeBuiltinProcess(intent, context, invoke)
      if (mutations.get(intent.tool) === intent.toolRevision && typeof intent.arguments.path === 'string') {
        const path = resolve(context.cwd, intent.arguments.path)
        await restoreRecoveryVersion(path)
        const attempt: Record<string, JsonValue> = {
          codec: WRITE_ATTEMPT_CODEC,
          intentId: intent.id,
          tool: intent.tool,
          toolRevision: intent.toolRevision,
          intentDigest: sha256Hex(canonicalJson(intent)),
          path,
          completed: false,
          writeCalls: 0,
        }
        const version = (bytes: Uint8Array): JsonValue => ({
          codec: VERSION_CODEC,
          path,
          digest: sha256Hex(bytes),
          size: bytes.byteLength,
          complete: bytes.byteLength <= MAX_READ_BYTES,
        })
        const observed: ToolContext = {
          ...context,
          fs: {
            ...context.fs,
            async read(input, options) {
              let bytes: Uint8Array
              try {
                bytes = await context.fs.read(input, options)
              } catch (error) {
                if (resolve(context.cwd, input) === path && recoveryVersions.has(path)) {
                  attempt.versionRefusal = true
                  throw new Error('Reconciled file is no longer readable; read it again before mutation')
                }
                throw error
              }
              if (resolve(context.cwd, input) === path && options === undefined) {
                attempt.before = version(bytes)
                const expected = recoveryVersions.get(path)
                if (expected && canonicalJson(expected) !== canonicalJson(attempt.before)) {
                  attempt.versionRefusal = true
                  throw new Error('Reconciled file changed; read it again before mutation')
                }
              }
              return bytes
            },
            async write(input, data) {
              const expected = recoveryVersions.get(path)
              if (expected) {
                try {
                  const current = await context.fs.read(input)
                  if (
                    resolve(context.cwd, input) !== path ||
                    canonicalJson(version(current)) !== canonicalJson(expected)
                  )
                    throw new Error('changed')
                } catch {
                  attempt.versionRefusal = true
                  throw new Error('Reconciled file changed before write; read it again before mutation')
                }
              }
              attempt.writeCalls = Number(attempt.writeCalls) + 1
              if (resolve(context.cwd, input) !== path) attempt.multipleTargets = true
              else
                attempt.submitted = version(typeof data === 'string' ? new TextEncoder().encode(data) : data)
              return context.fs.write(input, data)
            },
          },
        }
        const completed = (): JsonValue => {
          attempt.completed = true
          const meta = { fileWriteAttempt: structuredClone(attempt) }
          observedWriteMetadata.add(meta)
          mutationAttempts.set(intent.id, structuredClone(meta))
          return meta
        }
        try {
          const result = await invoke(observed)
          if (!result.isError && Number(attempt.writeCalls) > 0) recoveryVersions.delete(path)
          return { result, meta: completed() }
        } catch (error) {
          throw new ObservedWriteFailure(error, completed())
        }
      }
      if (
        intent.tool !== 'read' ||
        registered.get(intent.tool) !== intent.toolRevision ||
        typeof intent.arguments.path !== 'string' ||
        intent.arguments.path.startsWith('artifact://')
      )
        return { result: await invoke(context) }
      const path = resolve(context.cwd, intent.arguments.path)
      if (intent.toolRevision === recoveryReadRevision) await restoreRecoveryVersion(path)
      let readVersion: JsonValue | undefined
      // Record the actual bytes delivered to the real tool, rather than a second read guessed to
      // be identical. The original filesystem capability still owns every access-policy check.
      const observed: ToolContext = {
        ...context,
        fs: {
          ...context.fs,
          async read(input, readOptions) {
            const bytes = await context.fs.read(input, readOptions)
            if (
              resolve(context.cwd, input) === path &&
              (readOptions?.offset ?? 0) === 0 &&
              readOptions?.limit === MAX_READ_BYTES + 1
            ) {
              const condition = object(intent.preconditions)
              if (
                condition?.codec === PRECONDITION_CODEC &&
                (condition.path !== path ||
                  condition.size !== bytes.byteLength ||
                  condition.digest !== sha256Hex(bytes))
              )
                throw new Error('Read continuation source changed before the actual read')
              readVersion = {
                codec: VERSION_CODEC,
                path,
                size: bytes.byteLength,
                digest: sha256Hex(bytes),
                complete: bytes.byteLength <= MAX_READ_BYTES,
              }
            }
            return bytes
          },
        },
      }
      const result = await invoke(observed)
      if (readVersion && result.isError !== true && intent.toolRevision === recoveryReadRevision) {
        reads.set(intent.id, structuredClone(readVersion))
        if (object(readVersion)?.complete === true && recoveryVersions.has(path))
          recoveryVersions.set(path, structuredClone(readVersion))
      }
      return { result, ...(readVersion ? { meta: { readVersion } } : {}) }
    },
    async reconcileEffect(intent, outcome, records, signal) {
      signal.throwIfAborted()
      const captured = mutationAttempts.get(intent.id)
      if (
        intent.effectClass !== 'workspace_mutation' ||
        mutations.get(intent.tool) !== intent.toolRevision ||
        !captured ||
        canonicalJson(captured) !== canonicalJson(outcome.meta ?? null)
      )
        return undefined
      const attempt = object(object(captured)?.fileWriteAttempt)
      if (
        attempt?.completed !== true ||
        attempt.intentDigest !== sha256Hex(canonicalJson(intent)) ||
        attempt.multipleTargets ||
        typeof attempt.path !== 'string'
      )
        return undefined
      const nested = object(outcome.effectEvidence)?.nestedTools
      if (
        !Array.isArray(nested) ||
        nested.some((item) => {
          const evidence = object(item)
          return !evidence || !['none', 'not_applied'].includes(String(evidence.effect))
        })
      )
        return undefined
      const settlementIndex = records.findIndex(
        (record) =>
          record.kind === 'action.settled' && record.intentId === intent.id && record.effect === 'unknown',
      )
      if (settlementIndex < 0) return undefined
      for (let index = records.length - 1; index > settlementIndex; index--) {
        const record = records[index]
        if (record?.kind !== 'action.settled' || record.outcome.kind !== 'success') continue
        const read = records.find(
          (item) => item.kind === 'action.intended' && item.intent.id === record.intentId,
        )
        if (
          read?.kind !== 'action.intended' ||
          read.intent.tool !== 'read' ||
          !matching({ name: 'read', revision: read.intent.toolRevision })
        )
          continue
        const version = object(object(record.outcome.meta)?.readVersion)
        const trusted = reads.get(read.intent.id)
        if (
          !version ||
          !trusted ||
          version.path !== attempt.path ||
          version.complete !== true ||
          canonicalJson(version) !== canonicalJson(trusted)
        )
          continue
        // Any later mutable dispatch can invalidate this read; do not guess another tool's target.
        if (
          records
            .slice(index + 1)
            .some((item) => item.kind === 'action.intended' && item.intent.effectClass !== 'read_only')
        )
          return undefined
        const settlement = records[settlementIndex]
        if (!settlement) return undefined
        const port = session.d.workspaceInvocation
        if (!port) return undefined
        try {
          const handler: Parameters<typeof port.run<boolean>>[0] = async (view) => {
            signal.throwIfAborted()
            session.ac.signal.throwIfAborted()
            await view.ready(signal)
            const bytes = await view.fs().read(attempt.path as string, { limit: MAX_READ_BYTES + 1 })
            signal.throwIfAborted()
            session.ac.signal.throwIfAborted()
            return (
              bytes.byteLength <= MAX_READ_BYTES &&
              bytes.byteLength === version.size &&
              sha256Hex(bytes) === version.digest
            )
          }
          const verified = session.d.workspacePublication
            ? await session.d.workspacePublication.workspace(() => ({ port, handler }))
            : await port.run(handler)
          signal.throwIfAborted()
          session.ac.signal.throwIfAborted()
          if (!verified) return undefined
        } catch {
          signal.throwIfAborted()
          session.ac.signal.throwIfAborted()
          return undefined
        }
        recoveryVersions.set(attempt.path, structuredClone(version))
        return {
          resolution: 'reconciled_state',
          explanation:
            'Host verified the current complete contents of the single builtin file target; the historical mutation remains unknown.',
          evidence: [settlement.id, read.id, record.id],
          proof: {
            codec: 'agnes-host-builtin-file-reconciliation-v1',
            target: { path: attempt.path, tool: intent.tool, toolRevision: intent.toolRevision },
            currentVersion: version,
            complete: true,
            historyDisposition: 'unknown-retained',
          },
        }
      }
      return undefined
    },
    async validatePreconditions(preconditions, tool, args) {
      const condition = object(preconditions),
        arguments_ = object(args)
      if (
        !matching(tool) ||
        tool.name !== 'read' ||
        condition?.codec !== PRECONDITION_CODEC ||
        typeof condition.sourceRecordId !== 'string' ||
        typeof condition.path !== 'string' ||
        arguments_?.path !== condition.path ||
        typeof condition.digest !== 'string' ||
        !Number.isSafeInteger(condition.size) ||
        (condition.size as number) < 0 ||
        (condition.size as number) > MAX_READ_BYTES
      )
        return false
      const entries = await ledger.read()
      const source = entries.find((entry) => entry.record.id === condition.sourceRecordId)?.record
      if (source?.kind !== 'action.settled' || source.outcome.kind !== 'success') return false
      const sourceFact = object(source.outcome.value),
        sourcePage = object(sourceFact?.page),
        sourceCoverage = object(sourceFact?.coverage)
      if (
        sourceFact?.codec !== FACT_CODEC ||
        sourceFact.tool !== 'read' ||
        sourceCoverage?.continuationSafe !== true ||
        sourcePage?.nextOffset !== arguments_?.offset
      )
        return false
      const version = object(object(source.outcome.meta)?.readVersion)
      if (
        version?.codec !== VERSION_CODEC ||
        version.complete !== true ||
        version.path !== condition.path ||
        version.digest !== condition.digest ||
        version.size !== condition.size
      )
        return false
      const port = session.d.workspaceInvocation
      if (!port) return false
      try {
        const handler: Parameters<typeof port.run<boolean>>[0] = async (view) => {
          await view.ready(session.ac.signal)
          const bytes = await view.fs().read(condition.path as string, { limit: MAX_READ_BYTES + 1 })
          return bytes.byteLength === condition.size && sha256Hex(bytes) === condition.digest
        }
        return session.d.workspacePublication
          ? await session.d.workspacePublication.workspace(() => ({ port, handler }))
          : await port.run(handler)
      } catch {
        return false
      }
    },
  }
}

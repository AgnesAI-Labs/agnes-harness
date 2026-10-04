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
  ToolDescriptor,
  ToolSemantics,
} from '@agnes/jev-runtime'
import { validateAgainst } from '@agnes/protocol'
import { createToolSemantics } from '@agnes/runtime-jev'
import { verifiedChildControlTool } from './jev-child-tools.js'
import { operationCandidates } from './jev-operation-candidates.js'
import { verifiedOperationProfile } from './jev-operation-profiles.js'
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
  const parameterSchemas = new Map<string, RegisteredTool['parameters']>()
  const operationProfiles = new Map<string, DecisionToolProfile>()
  for (const definition of session.currentTools().snapshot(session.lastSeq).byName.values()) {
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
        intent.tool !== 'read' ||
        registered.get(intent.tool) !== intent.toolRevision ||
        typeof intent.arguments.path !== 'string' ||
        intent.arguments.path.startsWith('artifact://')
      )
        return { result: await invoke(context) }
      const path = resolve(context.cwd, intent.arguments.path)
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
      return { result, ...(readVersion ? { meta: { readVersion } } : {}) }
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

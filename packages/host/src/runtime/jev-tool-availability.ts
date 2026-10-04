import {
  type ChildrenFactory,
  canonicalJson,
  KernelChildren,
  type RegisteredTool,
  type SessionImpl,
} from '@agnes/core'
import { InvalidAuthoredArguments, type JsonValue, type ToolDescriptor } from '@agnes/jev-runtime'
import { verifiedChildControlTool } from './jev-child-tools.js'

/** Explicit Host support declaration for the exact child factory composed into this session. */
export interface ChildFactoryRuntimeSupport {
  readonly factory: ChildrenFactory
  supportsRuntime(identity: Readonly<{ id: string; version: string }>): boolean
  supportsContinuation?(identity: Readonly<{ id: string; version: string }>): boolean
}

const objectSchema = (properties: Record<string, JsonValue>, required: string[] = []): JsonValue => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
})
const text = { type: 'string', minLength: 1 }
const childModel = {
  ...text,
  description:
    'Omit to inherit the actual parent model. Override only with an explicitly configured model slot, model id, or route/model; do not invent an alias.',
}
const definitions = {
  run_code: {
    source: 'agnes/code-mode',
    readOnly: false,
    mechanism: 'codeMode',
    parameters: objectSchema(
      {
        code: { type: 'string', description: 'The program to run in this cell.' },
        description: {
          type: 'string',
          maxLength: 512,
          description: 'One line describing what this cell does.',
        },
      },
      ['code'],
    ),
  },
  compact: {
    source: 'agnes/compaction',
    readOnly: true,
    mechanism: 'compaction',
    parameters: objectSchema({ instructions: { type: 'string', maxLength: 4000 } }),
  },
  subagent_fork: {
    source: 'agnes/subagent',
    readOnly: false,
    mechanism: 'childCreation',
    parameters: objectSchema({ question: text, model: childModel }, ['question']),
  },
  subagent_spawn: {
    source: 'agnes/subagent',
    readOnly: false,
    mechanism: 'childCreation',
    parameters: objectSchema(
      {
        task: text,
        model: childModel,
        isolation: {
          anyOf: [
            { type: 'string', const: 'worktree' },
            { type: 'string', const: 'shared' },
          ],
        },
        budget: {
          type: 'integer',
          minimum: 1,
          description:
            'Omit to inherit the configured tree budget, including unlimited. Set a local credit cap only when explicitly requested; do not invent a limit.',
        },
      },
      ['task'],
    ),
  },
  shell: {
    source: 'agnes/tools-core',
    readOnly: false,
    mechanism: 'backgroundJobs',
    parameters: objectSchema(
      {
        command: text,
        timeoutMs: { type: 'integer', minimum: 1 },
        cwd: { type: 'string', minLength: 1, maxLength: 4096 },
        background: { type: 'boolean' },
      },
      ['command'],
    ),
  },
} as const

/** Admission concerns Host mechanisms; unverified definitions remain ordinary executable tools. */
export function createJevToolAvailability(session: SessionImpl, childSupport?: ChildFactoryRuntimeSupport) {
  const verified = (definition: RegisteredTool) => {
    if (verifiedChildControlTool(definition)) return { mechanism: 'childContinuation' as const }
    const expected = definitions[definition.name as keyof typeof definitions]
    return expected &&
      definition.source.source === expected.source &&
      definition.source.trust === 'builtin' &&
      definition.executionDomain === 'workspace' &&
      definition.meta.isReadOnly === expected.readOnly &&
      canonicalJson(JSON.parse(JSON.stringify(definition.parameters))) === canonicalJson(expected.parameters)
      ? expected
      : undefined
  }
  const registered = new Map<string, string>()
  for (const definition of session.currentTools().snapshot(session.lastSeq).byName.values()) {
    if (verified(definition)) registered.set(definition.name, definition.definitionFingerprint)
  }
  let childCreation = false
  let childContinuation = false
  const nativeFactory = session.d.children instanceof KernelChildren
  try {
    childCreation =
      childSupport !== undefined && childSupport.factory === session.d.children
        ? childSupport.supportsRuntime(Object.freeze({ ...session.runtimeIdentity })) === true
        : nativeFactory && session.runtimeIdentity.id === 'native' && session.runtimeIdentity.version === '1'
    if (session.d.children instanceof KernelChildren)
      childCreation &&= session.d.children.supportsRuntime(Object.freeze({ ...session.runtimeIdentity }))
    childContinuation =
      childCreation &&
      (nativeFactory ||
        (childSupport?.factory === session.d.children &&
          childSupport.supportsContinuation?.(Object.freeze({ ...session.runtimeIdentity })) === true &&
          typeof session.d.children.sendMessage === 'function' &&
          typeof session.d.children.interrupt === 'function'))
  } catch {
    /* A broken capability declaration does not admit effects. */
  }
  // These two mechanisms have no composed port in this adapter: requestCompaction rejects,
  // and no background job lifecycle is exposed. The default artifacts-local runner also refuses jobs.
  const mechanisms = {
    codeMode: {
      available: false,
      reason: 'Jev selects native tools directly; code-mode presentation is unavailable',
    },
    compaction: { available: false, reason: 'Jev has no compaction mechanism' },
    childCreation: {
      available: childCreation,
      reason: childCreation
        ? 'Factory supports this runtime'
        : nativeFactory
          ? 'Kernel child factory does not support this runtime'
          : 'Child factory has no explicit support for this runtime',
    },
    backgroundJobs: {
      available: false,
      reason: 'Jev has no background job lifecycle; the default artifacts-local runner is unimplemented',
    },
    childContinuation: {
      available: childContinuation,
      reason: childContinuation
        ? 'Factory supports continuable child conversations'
        : 'Child factory has no explicit continuation support for this runtime',
    },
  }
  const requirement = (definition: RegisteredTool) =>
    registered.get(definition.name) === definition.definitionFingerprint ? verified(definition) : undefined
  const facts = (current: Iterable<RegisteredTool>): JsonValue => {
    const restrictions: JsonValue[] = []
    for (const definition of current) {
      const expected = requirement(definition)
      if (!expected || mechanisms[expected.mechanism].available) continue
      restrictions.push({
        operation: definition.name,
        toolRevision: definition.definitionFingerprint,
        mechanism: expected.mechanism,
        reason: mechanisms[expected.mechanism].reason,
        ...(expected.mechanism === 'backgroundJobs'
          ? { unavailableParameters: ['background'] }
          : { unavailable: true }),
      })
    }
    return { kind: 'agnes.jev-tool-availability.v1', mechanisms, restrictions }
  }
  return {
    facts,
    project(definition: RegisteredTool, descriptor: ToolDescriptor): ToolDescriptor | undefined {
      const expected = requirement(definition)
      if (!expected || mechanisms[expected.mechanism].available) return descriptor
      if (expected.mechanism !== 'backgroundJobs') return undefined
      const parameters = structuredClone(descriptor.parameters) as { properties: Record<string, JsonValue> }
      delete parameters.properties.background
      return {
        ...descriptor,
        parameters,
        description:
          'Run a foreground command line in the session shell. Output is captured; long output is stored as an artifact. timeoutMs can shorten the call within the session limit. Background jobs are unavailable in this runtime.',
      }
    },
    validate(definition: RegisteredTool, args: Record<string, JsonValue>) {
      const expected = requirement(definition)
      if (!expected || mechanisms[expected.mechanism].available) return
      if (expected.mechanism !== 'backgroundJobs' || args.background === true)
        throw new InvalidAuthoredArguments(
          `Unavailable runtime capability (${expected.mechanism}): ${mechanisms[expected.mechanism].reason}`,
        )
    },
  }
}

import {
  type CoreError,
  canonicalJson,
  KernelChildren,
  type RegisteredTool,
  type SessionImpl,
  sha256Hex,
} from '@agnes/core'

type ChildCreationRefusal = Readonly<{
  kind: 'fork' | 'spawn'
  parentKey: string
  writerRunId: string
  lane: string
  toolUseId: string
  callSeq: number
  code: CoreError['code']
}>

// Full shipped contracts, including optional model documentation and effect policy. Neither a
// familiar name nor an error code grants authority to claim that a child was never created.
const contracts = {
  subagent_fork: { kind: 'fork', hash: '6b6fe5044c8b6adcfaa00d614d0acb70d5a2745aee7d6fccae18f1f274a31e8d' },
  subagent_spawn: { kind: 'spawn', hash: '094a4684c439ae30d8112f411daaec0d456d1af83c8f8116ea0e959c692985ca' },
} as const
const readCreationRefusal = KernelChildren.prototype.readCreationRefusal

function verified(definition: RegisteredTool) {
  const contract = contracts[definition.name as keyof typeof contracts]
  if (
    !contract ||
    definition.source.source !== 'agnes/subagent' ||
    definition.source.trust !== 'builtin' ||
    definition.executionDomain !== 'workspace' ||
    definition.classify !== undefined ||
    definition.policyVersion !== undefined
  )
    return undefined
  const actual = sha256Hex(
    canonicalJson(
      JSON.parse(
        JSON.stringify({
          description: definition.description,
          meta: definition.meta,
          parameters: definition.parameters,
        }),
      ),
    ),
  )
  return actual === contract.hash ? contract : undefined
}

export function createJevChildRefusalReader(
  session: SessionImpl,
): (
  definition: RegisteredTool,
  error: unknown,
  toolUseId: string,
  callSeq: number,
) => ChildCreationRefusal | undefined {
  const factory = session.d.children
  const registered = new Map<string, string>()
  for (const definition of session.currentTools().snapshot(session.lastSeq).byName.values()) {
    if (verified(definition)) registered.set(definition.name, definition.definitionFingerprint)
  }
  return (definition: RegisteredTool, error: unknown, toolUseId: string, callSeq: number) => {
    const contract = verified(definition)
    if (
      !contract ||
      registered.get(definition.name) !== definition.definitionFingerprint ||
      session.d.children !== factory ||
      !(factory instanceof KernelChildren) ||
      Object.getPrototypeOf(factory) !== KernelChildren.prototype
    )
      return undefined
    try {
      return readCreationRefusal.call(factory, error, { kind: contract.kind, toolUseId, callSeq })
    } catch {
      return undefined
    }
  }
}

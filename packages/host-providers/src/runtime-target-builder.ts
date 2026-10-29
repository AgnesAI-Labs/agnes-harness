import { createHash } from 'node:crypto'
import {
  buildRuntimeTarget,
  encodeRuntimeTargetArtifact,
  type PluginRow,
  type RuntimeTarget,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'

export type CompleteRuntimeTargetInput = Readonly<{
  rows: readonly Readonly<PluginRow>[]
  resources: Readonly<{ mcp: unknown; skills: unknown }>
  resourceRevision?: string
  compositeRevision?: string
}>

export type CompleteRuntimeTarget = Readonly<{
  target: RuntimeTarget
  artifact: RuntimeTargetArtifact
}>

const REVISION = /^[a-f0-9]{64}$/

function revision(value: string, field: string): string {
  if (!REVISION.test(value)) {
    throw new Error(`E_RUNTIME_TARGET_IDENTITY: ${field} must be 64 lowercase hexadecimal characters`)
  }
  return value
}

function digestHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * The only production builder: one complete desired-row set becomes one canonical target, then one
 * artifact. Callers must persist and probe that artifact; they must not rebuild after probe.
 */
export function buildCompleteRuntimeTarget(input: CompleteRuntimeTargetInput): CompleteRuntimeTarget {
  const draft = buildRuntimeTarget({
    rows: input.rows,
    resources: input.resources,
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })
  const resourceRevision = revision(
    input.resourceRevision ??
      digestHex(`${JSON.stringify(draft.resource.resources)}\n${JSON.stringify(draft.resource.rows)}`),
    'resourceRevision',
  )
  const compositeRevision = revision(
    input.compositeRevision ?? digestHex(`${draft.tree.hash}:${resourceRevision}`),
    'compositeRevision',
  )
  const target = buildRuntimeTarget({
    rows: input.rows,
    resources: input.resources,
    resourceRevision,
    compositeRevision,
  })
  return Object.freeze({ target, artifact: encodeRuntimeTargetArtifact(target) })
}

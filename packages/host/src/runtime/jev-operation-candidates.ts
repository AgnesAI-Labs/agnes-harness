import { canonicalJson, sha256Hex } from '@agnes/core'
import type {
  Candidate,
  CandidateContext,
  CandidateEvidence,
  CandidateId,
  EnvironmentEpoch,
  JsonValue,
  ToolDescriptor,
} from '@agnes/jev-runtime'

const object = (value: JsonValue | undefined) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const text = (value: JsonValue | undefined): value is string => typeof value === 'string' && value.length > 0
const integer = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Complete calls from authenticated catalog metadata and successful, version-bound tool receipts. */
export function* operationCandidates(
  tool: ToolDescriptor,
  epoch: EnvironmentEpoch,
  context: CandidateContext,
  verified: (tool: { name: string; revision: string }) => boolean,
): Iterable<Candidate> {
  if (!verified(tool) || !['skill_read', 'skill_read_file', 'subagent_collect'].includes(tool.name)) return
  const seen = new Set<string>()
  let count = 0
  const offer = (
    args: Record<string, JsonValue>,
    evidence: CandidateEvidence[],
    revisit = false,
  ): Candidate | undefined => {
    const key = canonicalJson(args)
    if (seen.has(key) || count >= context.limit) return
    seen.add(key)
    count++
    return {
      id: `agnes-${sha256Hex(canonicalJson({ tool: tool.name, revision: tool.revision, epoch, args, evidence }))}` as CandidateId,
      tool: tool.name,
      label: `${tool.name} ${String(args.name ?? args.relativePath ?? args.childKey)}`,
      arguments: args,
      sourceRecordIds: [...new Set(evidence.map((item) => item.sourceRecordId))],
      toolRevision: tool.revision,
      environmentEpoch: epoch,
      evidence,
      ...(revisit ? { revisit: 'verification' as const } : {}),
    }
  }
  const catalog = context.records.findLast(
    (record) =>
      record.kind === 'resource.observed' && object(record.resource)?.kind === 'jev.skill-catalog.v1',
  )
  const resource = catalog?.kind === 'resource.observed' ? object(catalog.resource) : undefined
  const entries = resource?.entries
  const activeNames = new Set(
    Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const name = object(entry)?.name
          return text(name) ? [name] : []
        })
      : [],
  )
  const knownChildren = new Set(
    context.records.flatMap((record) => {
      if (
        record.kind !== 'action.settled' ||
        record.outcome.kind !== 'success' ||
        record.effect === 'unknown' ||
        record.effect === 'not_applied'
      )
        return []
      const source = context.records.find(
        (item) => item.kind === 'action.intended' && item.intent.id === record.intentId,
      )
      const child = object(record.outcome.value)?.childKey
      return source?.kind === 'action.intended' &&
        ['subagent_spawn', 'subagent_collect'].includes(source.intent.tool) &&
        verified({ name: source.intent.tool, revision: source.intent.toolRevision }) &&
        text(child)
        ? [child]
        : []
    }),
  )
  const skillNames = new Map<string, string>()
  for (const record of context.records) {
    if (
      record.kind !== 'action.settled' ||
      record.outcome.kind !== 'success' ||
      record.effect === 'unknown' ||
      record.effect === 'not_applied'
    )
      continue
    const source = context.records.find(
      (item) => item.kind === 'action.intended' && item.intent.id === record.intentId,
    )
    const value = object(record.outcome.value)
    if (
      source?.kind === 'action.intended' &&
      source.intent.tool === 'skill_read' &&
      verified({ name: source.intent.tool, revision: source.intent.toolRevision }) &&
      text(value?.resourceId) &&
      text(value.name)
    )
      skillNames.set(value.resourceId, value.name)
  }
  const invalidated = new Set<string>()
  const latest = new Set<string>()
  for (const record of context.records.toReversed()) {
    if (record.kind === 'candidate.invalidation') {
      if (record.tool === tool.name) break
      invalidated.add(record.tool)
      continue
    }
    if (
      record.kind !== 'action.settled' ||
      record.outcome.kind !== 'success' ||
      record.effect === 'unknown' ||
      record.effect === 'not_applied'
    )
      continue
    const intended = context.records.find(
      (item) => item.kind === 'action.intended' && item.intent.id === record.intentId,
    )
    if (
      intended?.kind !== 'action.intended' ||
      invalidated.has(intended.intent.tool) ||
      !verified({ name: intended.intent.tool, revision: intended.intent.toolRevision })
    )
      continue
    const value = object(record.outcome.value)
    if (!value) continue
    const evidence = (field: string): CandidateEvidence => ({
      sourceRecordId: record.id,
      pointer: `/outcome/value/${field}`,
      value: value[field] as JsonValue,
    })
    let candidate: Candidate | undefined
    if (
      tool.name === 'subagent_collect' &&
      ['subagent_spawn', 'subagent_collect', 'subagent_cancel', 'subagent_send_message'].includes(
        intended.intent.tool,
      )
    ) {
      if (!text(value.childKey) || latest.has(value.childKey)) continue
      if (intended.intent.tool === 'subagent_send_message' && !knownChildren.has(value.childKey)) continue
      latest.add(value.childKey)
      // Cancel receipts are not collection receipts: collect once to confirm their terminal state.
      if (intended.intent.tool === 'subagent_collect' && value.status !== 'running') continue
      // Use the native cancellable wait instead of spending decision steps polling the same state.
      candidate = offer({ childKey: value.childKey, wait: true }, [evidence('childKey')])
    } else if (
      (tool.name === 'skill_read' || tool.name === 'skill_read_file') &&
      intended.intent.tool === tool.name
    ) {
      const key = tool.name === 'skill_read' ? value.name : `${value.resourceId}\0${value.relativePath}`
      if (!text(key) || latest.has(key)) continue
      latest.add(key)
      if (tool.name === 'skill_read' && resource?.complete === true && !activeNames.has(String(value.name)))
        continue
      // Successful skill reads bind opaque file resourceIds to catalog names without exposing ids in the catalog.
      const resourceName = text(value.resourceId) ? skillNames.get(value.resourceId) : undefined
      if (
        tool.name === 'skill_read_file' &&
        resource?.complete === true &&
        (activeNames.size === 0 || (resourceName !== undefined && !activeNames.has(resourceName)))
      )
        continue
      if (
        !integer(value.offset) ||
        !integer(value.nextOffset) ||
        !integer(value.totalBytes) ||
        value.nextOffset <= value.offset ||
        value.nextOffset >= value.totalBytes
      )
        continue
      if (
        tool.name === 'skill_read' &&
        text(value.name) &&
        text(value.pageKey) &&
        /^[a-f0-9]{64}$/u.test(value.pageKey)
      ) {
        candidate = offer({ name: value.name, offset: value.nextOffset, pageKey: value.pageKey }, [
          evidence('name'),
          evidence('nextOffset'),
          evidence('pageKey'),
        ])
      } else if (
        tool.name === 'skill_read_file' &&
        text(value.resourceId) &&
        text(value.relativePath) &&
        text(intended.intent.arguments.expectedRevision) &&
        intended.intent.arguments.resourceId === value.resourceId &&
        intended.intent.arguments.relativePath === value.relativePath &&
        value.artifact !== true
      ) {
        candidate = offer(
          {
            resourceId: value.resourceId,
            relativePath: value.relativePath,
            expectedRevision: intended.intent.arguments.expectedRevision,
            offset: value.nextOffset,
          },
          [
            evidence('resourceId'),
            evidence('relativePath'),
            evidence('nextOffset'),
            {
              sourceRecordId: intended.id,
              pointer: '/intent/arguments/expectedRevision',
              value: intended.intent.arguments.expectedRevision,
            },
          ],
        )
      }
    }
    if (candidate) yield candidate
  }
  if (tool.name !== 'skill_read') return
  if (catalog?.kind !== 'resource.observed') return
  if (!Array.isArray(entries)) return
  for (const [index, entry] of entries.entries()) {
    const name = object(entry)?.name
    if (!text(name)) continue
    const candidate = offer(
      { name },
      [{ sourceRecordId: catalog.id, pointer: `/resource/entries/${index}/name`, value: name }],
      latest.has(name),
    )
    if (candidate) yield candidate
  }
}

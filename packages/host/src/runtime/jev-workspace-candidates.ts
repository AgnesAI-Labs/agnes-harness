import { resolve } from 'node:path'
import { canonicalJson, sha256Hex } from '@agnes/core'
import type {
  Candidate,
  CandidateContext,
  CandidateId,
  EnvironmentEpoch,
  JsonValue,
  ToolDescriptor,
} from '@agnes/jev-runtime'

const object = (value: JsonValue | undefined) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Pure complete calls from one persisted root listing, never from task text or path guesses. */
export function* workspaceCandidates(
  tool: ToolDescriptor,
  epoch: EnvironmentEpoch,
  context: CandidateContext,
  cwd: string,
): Iterable<Candidate> {
  const position = context.records.findLastIndex(
    (record) =>
      record.kind === 'resource.observed' && object(record.resource)?.kind === 'jev.workspace-directory.v1',
  )
  const source = context.records[position]
  if (source?.kind !== 'resource.observed') return
  const directory = object(source.resource)
  if (
    directory?.status !== 'observed' ||
    directory.root !== cwd ||
    !Array.isArray(directory.entries) ||
    context.records
      .slice(position + 1)
      .some(
        (record) =>
          record.kind === 'candidate.invalidation' ||
          (record.kind === 'action.intended' && record.intent.effectClass !== 'read_only'),
      )
  )
    return
  const unseen: Candidate[] = []
  const revisits: Candidate[] = []
  if (tool.name === 'ls') {
    const args = { path: cwd }
    // The recorded root supplies a discovery option even when no child directory was retained.
    unseen.push({
      id: `agnes-${sha256Hex(canonicalJson({ tool: tool.name, revision: tool.revision, epoch, record: source.id, args }))}` as CandidateId,
      tool: tool.name,
      label: 'ls observed workspace root',
      arguments: args,
      sourceRecordIds: [source.id],
      toolRevision: tool.revision,
      environmentEpoch: epoch,
      evidence: [
        { sourceRecordId: source.id, pointer: '/resource/root', value: cwd },
        { sourceRecordId: source.id, pointer: '/resource/status', value: 'observed' },
      ],
    })
  }
  for (const [index, value] of directory.entries.entries()) {
    const entry = object(value)
    const name = entry?.path
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/u.test(name)) continue
    if (entry?.kind !== (tool.name === 'read' ? 'file' : 'directory')) continue
    const path = resolve(cwd, name)
    // A directory entry establishes a path, not text MIME; native read must choose the format.
    const args = { path }
    const lastMutation = context.records.findLastIndex((record) => record.kind === 'candidate.invalidation')
    const prior = context.records.slice(lastMutation + 1).some((record) => {
      if (record.kind !== 'action.settled' || record.outcome.kind !== 'success') return false
      const previous = context.records
        .slice(0, context.records.indexOf(record))
        .findLast(
          (item) =>
            item.kind === 'resource.observed' && object(item.resource)?.kind === 'jev.workspace-directory.v1',
        )
      const earlier = previous?.kind === 'resource.observed' ? object(previous.resource) : undefined
      const earlierEntry = Array.isArray(earlier?.entries)
        ? earlier.entries.find((value) => object(value)?.path === name)
        : undefined
      if (
        earlier?.root !== cwd ||
        typeof entry.version !== 'string' ||
        object(earlierEntry)?.version !== entry.version
      )
        return false
      const intent = context.records.find(
        (item) => item.kind === 'action.intended' && item.intent.id === record.intentId,
      )
      return (
        intent?.kind === 'action.intended' &&
        intent.intent.tool === tool.name &&
        intent.intent.toolRevision === tool.revision &&
        canonicalJson(intent.intent.arguments) === canonicalJson(args)
      )
    })
    const candidate: Candidate = {
      id: `agnes-${sha256Hex(canonicalJson({ tool: tool.name, revision: tool.revision, epoch, record: source.id, args }))}` as CandidateId,
      tool: tool.name,
      label: `${tool.name} observed ${name}`,
      arguments: args,
      sourceRecordIds: [source.id],
      toolRevision: tool.revision,
      environmentEpoch: epoch,
      evidence: [
        { sourceRecordId: source.id, pointer: '/resource/root', value: cwd },
        { sourceRecordId: source.id, pointer: `/resource/entries/${index}/path`, value: name },
        { sourceRecordId: source.id, pointer: `/resource/entries/${index}/kind`, value: entry.kind },
      ],
      ...(prior ? { revisit: 'verification' as const } : {}),
    }
    ;(prior ? revisits : unseen).push(candidate)
  }
  yield* [...unseen, ...revisits].slice(0, context.limit)
}

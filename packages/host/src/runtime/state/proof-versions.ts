import type { ReadGuard, RecordVersionRef, SchemaRef } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { integrity } from './refusal.js'

/** Relation checks consume versions already authenticated against the original ledger manifest. */
export function assertStateProofVersion(
  guard: ReadGuard,
  version: RecordVersionRef,
  expectedSchema: SchemaRef,
  expectedCommitId?: string,
): void {
  const validGuard = validateRuntime('ReadGuard', guard)
  const validVersion = validateRuntime('RecordVersionRef', version)
  if (
    !validGuard.ok ||
    !validVersion.ok ||
    guard.expectedRecordRevision === null ||
    guard.expectedRecordRevision < 1 ||
    version.recordRevision < 1 ||
    version.recordId !== guard.recordId ||
    version.recordRevision !== guard.expectedRecordRevision
  )
    integrity('State proof source version does not match its guard')
  if (!sameSchema(version.schema, expectedSchema)) integrity('State proof source schema mismatch')
  if (expectedCommitId !== undefined && version.commitId !== expectedCommitId)
    integrity('State proof source was not created in the original transaction')
  if (version.body.state !== 'available') integrity('State proof source body is unavailable')
}

/** Null predecessor is meaningful only for a verified first version, never a missing cache row. */
export function assertStateLeasePredecessor(next: RecordVersionRef, previous: RecordVersionRef | null): void {
  if (!validateRuntime('RecordVersionRef', next).ok || next.recordRevision < 1)
    integrity('invalid next State lease version')
  if (previous === null) {
    if (next.recordRevision !== 1) integrity('State lease genesis cannot skip its predecessor')
    return
  }
  if (
    !validateRuntime('RecordVersionRef', previous).ok ||
    previous.recordRevision < 1 ||
    previous.recordId !== next.recordId ||
    previous.recordRevision !== next.recordRevision - 1 ||
    !sameSchema(previous.schema, next.schema) ||
    previous.body.state !== 'available'
  )
    integrity('State lease predecessor is missing or unrelated')
}

function sameSchema(left: SchemaRef, right: SchemaRef): boolean {
  return left.typeId === right.typeId && left.revision === right.revision && left.digest === right.digest
}

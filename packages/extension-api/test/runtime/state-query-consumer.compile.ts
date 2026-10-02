import type {
  DataRef,
  Page,
  RuntimeFormatData,
  RuntimeWireTypes,
  StateProbeCommitRequest,
  StateProbeCommitResult,
  StateScanResult,
  StateStoreControl,
  StateWriteOpenProofValue,
} from '@agnes/extension-api/runtime'
import {
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  RuntimeStateLegacyReaders,
  validateRuntime,
} from '@agnes/protocol/runtime'

const methods = RuntimeServiceCatalog['agh.state'].methods
export const probe: RuntimeWireTypes[typeof methods.probeCommit.input] = {
  commitId: 'commit',
} satisfies StateProbeCommitRequest
export const absent: RuntimeWireTypes[typeof methods.probeCommit.output] =
  null satisfies StateProbeCommitResult
export const page: StateScanResult = { items: [], snapshot: 'snapshot', nextCursor: null, complete: true }
export const genericPage: Page<DataRef> = page
export const format: RuntimeFormatData = {
  formatVersion: 2,
  runtimeSchemaMajor: 1,
  minReader: 2,
  previousFormat: 1,
  legacyThroughSeq: 0,
  sourceHeadDigest: null,
}
// @ts-expect-error Future readers are not part of the current decoder contract.
export const future: RuntimeFormatData = { ...format, minReader: 3 }
// @ts-expect-error Generated Page item arrays remain readonly.
page.items.push({})
declare const control: StateStoreControl
// @ts-expect-error Q-only operations do not become Local control methods.
control.scan
// @ts-expect-error Commit probes remain Q-only too.
control.probeCommit
declare const proof: StateWriteOpenProofValue
const mode: 'write' = proof.request.mode
void mode
// @ts-expect-error The exact existing write branch cannot carry the read-mode null writer.
const writer: null = proof.request.writerId
void writer
const parsed = validateRuntime(methods.scan.output, page)
if (parsed.ok) {
  const result: StateScanResult = parsed.value
  void result
}
export const schemaId: 'agh.state/scan.response@1' = RuntimeMethodSchemaRefs['agh.state'].scan.output.typeId
export const sourceRevisions: readonly number[] = RuntimeStateLegacyReaders.entries.map(
  (e) => e.targetRevision,
)

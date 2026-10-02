import { createHash } from 'node:crypto'
import { jcs } from '../src/jcs.js'
import type { JsonSchemaDoc } from './gen-core.js'
import { normalizeRuntimeCatalog } from './gen-runtime-catalog.js'

type Json = Record<string, unknown>
function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Json {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function fail(): never {
  throw new Error('invalid State runtime metadata')
}

/** The controlled fragment remains the existing write branch, with no copied request DTO. */
export function validateStateOpenDefinition(value: unknown): void {
  if (!exact(value, ['anyOf']) || !Array.isArray(value.anyOf) || value.anyOf.length !== 2) fail()
  const names = ['requestId', 'authority', 'sessionId', 'mode', 'writerId', 'ttlMs']
  for (const [index, mode] of ['read', 'write'].entries()) {
    const branch = value.anyOf[index]
    if (
      !exact(branch, ['type', 'additionalProperties', 'required', 'properties']) ||
      branch.type !== 'object' ||
      branch.additionalProperties !== false ||
      !Array.isArray(branch.required) ||
      branch.required.length !== names.length ||
      !names.every((n) => (branch.required as unknown[]).includes(n)) ||
      !exact(branch.properties, names)
    )
      fail()
    const props = branch.properties
    if (jcs(props.mode) !== jcs({ const: mode })) fail()
    for (const [name, ref] of [
      ['requestId', 'Id'],
      ['authority', 'StateAuthorityRef'],
      ['sessionId', 'Id'],
    ])
      if (jcs(props[name as string]) !== jcs({ $ref: `#/$defs/${ref}` })) fail()
    if (mode === 'read') {
      if (jcs(props.writerId) !== jcs({ type: 'null' }) || jcs(props.ttlMs) !== jcs({ type: 'null' })) fail()
    } else if (
      jcs(props.writerId) !== jcs({ $ref: '#/$defs/Id' }) ||
      jcs(props.ttlMs) !== jcs({ $ref: '#/$defs/UInt53' })
    )
      fail()
  }
}

/** Historical tag documents identify old bytes; they are never used as full payload validators. */
export function validateStateRuntimeMetadata(
  graph: JsonSchemaDoc,
  metadata: JsonSchemaDoc,
  local: Json,
  legacyDocuments: unknown,
): void {
  const definitions = graph.$defs ?? {}
  validateStateOpenDefinition(definitions.StateOpenRequest)
  const query = metadata['x-state-query-api']
  if (
    !exact(query, ['contract', 'methods']) ||
    query.contract !== 'agh.state' ||
    jcs(query.methods) !== jcs(['scan', 'probeCommit'])
  )
    fail()
  const catalog = normalizeRuntimeCatalog(metadata, new Set(Object.keys(definitions)))
  const methods = (catalog['agh.state'] as Json).methods as Json
  for (const [name, input, output] of [
    ['scan', 'StateScanRequest', 'StateScanResult'],
    ['probeCommit', 'StateProbeCommitRequest', 'StateProbeCommitResult'],
  ]) {
    const operation = methods[name as string]
    if (
      !exact(operation, [
        'kind',
        'input',
        'output',
        'inputTypeId',
        'outputTypeId',
        'sameAttemptBrokerAllowed',
      ]) ||
      operation.kind !== 'query' ||
      operation.input !== input ||
      operation.output !== output ||
      operation.inputTypeId !== `agh.state/${name}.request@1` ||
      operation.outputTypeId !== `agh.state/${name}.response@1` ||
      operation.sameAttemptBrokerAllowed !== false ||
      !definitions[input as string] ||
      !definitions[output as string]
    )
      fail()
  }
  const localApi = local['x-local-api'] as Json
  const runtime = localApi.runtime as Json
  if (
    typeof runtime.StateStoreControl !== 'string' ||
    /\b(?:scan|probeCommit)\s*\(/.test(runtime.StateStoreControl)
  )
    fail()
  if ((methods.open as Json)?.kind !== 'control') fail()
  const expectedOpen = {
    contract: 'agh.state',
    method: 'open',
    requestDefinition: 'StateOpenRequest',
    byMode: { read: 'fresh-verified-snapshot', write: 'immutable-original-result' },
  }
  if (jcs(metadata['x-state-open-retry-policy']) !== jcs(expectedOpen)) fail()
  const legacy = metadata['x-state-legacy-readers']
  if (
    !exact(legacy, ['formatVersion', 'sourceMinReader', 'targetMinReader', 'entries']) ||
    legacy.formatVersion !== 2 ||
    legacy.sourceMinReader !== 1 ||
    legacy.targetMinReader !== 2 ||
    !Array.isArray(legacy.entries) ||
    legacy.entries.length !== 17 ||
    !object(legacyDocuments) ||
    Object.keys(legacyDocuments).length !== 17
  )
    fail()
  const ids = metadata['x-schema-ids'] as Json
  const revisions = metadata['x-schema-revisions'] as Json
  const seen = new Set<string>()
  const seenTargets = new Set<string>()
  const rules: Json = {
    ReceiptRecordValue: 'R',
    SignalRecordValue: 'S',
    UsageMirrorValue: 'U',
    OutboxRecord: 'O',
    ReferenceRecordValue: 'F',
  }
  for (const entry of legacy.entries) {
    if (
      !exact(entry, ['source', 'targetDefinition', 'targetRevision', 'decoderProfile', 'conversionRule']) ||
      !exact(entry.source, ['typeId', 'revision', 'digest']) ||
      typeof entry.targetDefinition !== 'string'
    )
      fail()
    const target = entry.targetDefinition,
      doc = legacyDocuments[target]
    if (!object(doc) || typeof doc.$id !== 'string' || !doc.$id.endsWith('.value') || !definitions[target])
      fail()
    const typeId = `${doc.$id.slice(0, -6)}@1`
    const profile =
      target === 'OutboxRecord'
        ? 'state85-outbox-created'
        : `state85-${typeId.slice(typeId.lastIndexOf('/') + 1, -2)}`
    const source = entry.source
    const digest = createHash('sha256').update(jcs(doc)).digest('hex')
    const identity = jcs(source)
    if (
      seen.has(identity) ||
      seenTargets.has(target) ||
      source.typeId !== typeId ||
      source.revision !== 1 ||
      source.digest !== digest ||
      ids[target] !== typeId ||
      entry.decoderProfile !== profile ||
      entry.conversionRule !== (rules[target] ?? 'V') ||
      entry.targetRevision !== revisions[target] ||
      typeof entry.targetRevision !== 'number' ||
      entry.targetRevision < 2
    )
      fail()
    seen.add(identity)
    seenTargets.add(target)
  }
}

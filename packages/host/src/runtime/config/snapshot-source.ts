import { type ConfigReadResult, type JsonValue, validateRuntime } from '@agnes/protocol/runtime'
import { parse as parseYaml } from 'yaml'
import {
  type ConfigOutcome,
  type ConfigRefusal,
  canonicalByteLength,
  configRefusal,
  documentDigest,
  MAX_INLINE_BYTES,
} from './config-digest.js'
import type { SchemaRef } from './schema-catalog.js'

type Stored = {
  sourceRef: string
  revision: number
  digest: string
  schema: SchemaRef
  value: JsonValue
}

export type ConfigSource = {
  read(sourceRef: string, revision: number | null): ConfigOutcome<ConfigReadResult>
  dispose(): void
  readonly disposed: boolean
}

export type FileConfigSource = {
  source: ConfigSource
  refresh(sourceRef: string, signal?: AbortSignal): ConfigRefusal | null
}

export type FetchedSnapshot = {
  revision: number
  schema: unknown
  value: unknown
}

export type SnapshotFetcher = (
  sourceRef: string,
  signal: AbortSignal,
) => Promise<FetchedSnapshot | ConfigRefusal>

export type FetchConfigSource = {
  source: ConfigSource
  refresh(sourceRef: string, signal?: AbortSignal): Promise<ConfigRefusal | null>
}

function firstError(errors: { message: string }[]): string {
  return errors[0]?.message ?? 'invalid document'
}

function refused(refusal: ConfigRefusal): ConfigOutcome<ConfigReadResult> {
  return { ok: false, refusal }
}

function createStore(): {
  admit(sourceRef: string, revision: number, schema: SchemaRef, value: unknown): ConfigRefusal | null
  read(sourceRef: string, revision: number | null): ConfigOutcome<ConfigReadResult>
  dispose(): void
  disposed: boolean
} {
  const revisions = new Map<string, Map<number, Stored>>()
  const latest = new Map<string, number>()
  let disposed = false

  const admit = (
    sourceRef: string,
    revision: number,
    schema: SchemaRef,
    value: unknown,
  ): ConfigRefusal | null => {
    if (disposed) return configRefusal('disposed', '', 'config source is disposed')
    if (!Number.isSafeInteger(revision) || revision < 1) {
      return configRefusal('schema_invalid', '/revision', 'revision must be a positive integer')
    }
    const schemaResult = validateRuntime('SchemaRef', schema)
    if (!schemaResult.ok) return configRefusal('schema_invalid', '/schema', firstError(schemaResult.errors))
    const valueResult = validateRuntime('JsonValue', value)
    if (!valueResult.ok) return configRefusal('schema_invalid', '/value', firstError(valueResult.errors))
    const digest = documentDigest(valueResult.value)
    const bytes = canonicalByteLength(valueResult.value)
    if (bytes > MAX_INLINE_BYTES) {
      return configRefusal('document_too_large', '/value', 'document exceeds the inline byte limit')
    }
    const byRevision = revisions.get(sourceRef) ?? new Map<number, Stored>()
    const current = latest.get(sourceRef)
    const existing = byRevision.get(revision)
    if (existing) {
      if (existing.digest !== digest) {
        return configRefusal('revision_conflict', '/revision', 'revision already holds a different document')
      }
      return null
    }
    if (current !== undefined && revision !== current + 1) {
      return configRefusal('revision_conflict', '/revision', 'revision must follow the admitted snapshot')
    }
    const stored: Stored = {
      sourceRef,
      revision,
      digest,
      schema: schemaResult.value,
      value: valueResult.value,
    }
    const result: ConfigReadResult = {
      documentRef: { kind: 'inline', schema: stored.schema, value: stored.value, digest, bytes },
      revision,
      digest,
    }
    const checked = validateRuntime('ConfigReadResult', result)
    if (!checked.ok) return configRefusal('schema_invalid', '/read', firstError(checked.errors))
    byRevision.set(revision, stored)
    revisions.set(sourceRef, byRevision)
    latest.set(sourceRef, current === undefined ? revision : Math.max(current, revision))
    return null
  }

  return {
    admit,
    read(sourceRef, revision) {
      if (disposed) return refused(configRefusal('disposed', '', 'config source is disposed'))
      const byRevision = revisions.get(sourceRef)
      const current = latest.get(sourceRef)
      if (!byRevision || current === undefined) {
        return refused(configRefusal('source_unavailable', '/sourceRef', 'no admitted snapshot'))
      }
      const selected = revision === null ? current : revision
      const stored = byRevision.get(selected)
      if (!stored)
        return refused(configRefusal('source_unavailable', '/revision', 'admitted revision is not available'))
      const bytes = canonicalByteLength(stored.value)
      const result: ConfigReadResult = {
        documentRef: {
          kind: 'inline',
          schema: stored.schema,
          value: stored.value,
          digest: stored.digest,
          bytes,
        },
        revision: stored.revision,
        digest: stored.digest,
      }
      const checked = validateRuntime('ConfigReadResult', result)
      if (!checked.ok) return refused(configRefusal('schema_invalid', '/read', firstError(checked.errors)))
      return { ok: true, result: checked.value }
    },
    dispose() {
      disposed = true
    },
    get disposed() {
      return disposed
    },
  }
}

function parseSnapshotText(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed)
  return parseYaml(trimmed)
}

function snapshotFromUnknown(value: unknown): FetchedSnapshot | ConfigRefusal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configRefusal('schema_invalid', '/document', 'snapshot must be an object')
  }
  const record = value as Record<string, unknown>
  const revision = record.revision
  if (typeof revision !== 'number') return configRefusal('schema_invalid', '/revision', 'revision is missing')
  return { revision, schema: record.schema, value: record.value }
}

function admitFetched(
  store: ReturnType<typeof createStore>,
  sourceRef: string,
  fetched: FetchedSnapshot | ConfigRefusal,
): ConfigRefusal | null {
  if ('code' in fetched) return fetched
  const schema = validateRuntime('SchemaRef', fetched.schema)
  if (!schema.ok) return configRefusal('schema_invalid', '/schema', firstError(schema.errors))
  return store.admit(sourceRef, fetched.revision, schema.value, fetched.value)
}

export function createFileConfigSource(load: (sourceRef: string) => string | null): FileConfigSource {
  const store = createStore()
  return {
    source: store,
    refresh(sourceRef, signal) {
      if (store.disposed) return configRefusal('disposed', '', 'config source is disposed')
      // An aborted caller never admits. The loader is not asked once the signal is already aborted.
      if (signal?.aborted) return configRefusal('cancelled', '/sourceRef', 'snapshot refresh was cancelled')
      const text = load(sourceRef)
      if (signal?.aborted) return configRefusal('cancelled', '/sourceRef', 'snapshot refresh was cancelled')
      if (text === null)
        return configRefusal('source_unavailable', '/sourceRef', 'snapshot file is unavailable')
      let parsed: unknown
      try {
        parsed = parseSnapshotText(text)
      } catch {
        return configRefusal('schema_invalid', '/document', 'snapshot text cannot be parsed')
      }
      return admitFetched(store, sourceRef, snapshotFromUnknown(parsed))
    },
  }
}

export function createFetchConfigSource(fetchSnapshot: SnapshotFetcher): FetchConfigSource {
  const store = createStore()
  return {
    source: store,
    async refresh(sourceRef, signal) {
      if (store.disposed) return configRefusal('disposed', '', 'config source is disposed')
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (signal?.aborted) return configRefusal('cancelled', '/sourceRef', 'snapshot refresh was cancelled')
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const fetched = await fetchSnapshot(sourceRef, controller.signal)
        if (signal?.aborted || controller.signal.aborted) {
          return configRefusal('cancelled', '/sourceRef', 'snapshot refresh was cancelled')
        }
        return admitFetched(store, sourceRef, fetched)
      } catch {
        if (signal?.aborted || controller.signal.aborted) {
          return configRefusal('cancelled', '/sourceRef', 'snapshot refresh was cancelled')
        }
        return configRefusal('source_unavailable', '/sourceRef', 'snapshot fetch failed')
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}

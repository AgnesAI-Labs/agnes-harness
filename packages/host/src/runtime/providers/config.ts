import type { ConfigReadResult, ConfigResolveResult } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import {
  CONFIG_CONTRACT,
  CONFIG_PACKAGE,
  CONFIG_PROVIDER_ID,
  type ConfigOutcome,
  configRefusal,
} from '../config/config-digest.js'
import { resolveConfigRequest } from '../config/resolve-request.js'
import { createSchemaCatalog, type SchemaCatalog } from '../config/schema-catalog.js'
import {
  type ConfigSource,
  createFetchConfigSource,
  createFileConfigSource,
  type FetchConfigSource,
  type FileConfigSource,
  type SnapshotFetcher,
} from '../config/snapshot-source.js'

export {
  CONFIG_CONTRACT,
  CONFIG_PACKAGE,
  CONFIG_PROVIDER_ID,
  CONFIG_REFUSAL_CODES,
  type ConfigOutcome,
  type ConfigRefusal,
  type ConfigRefusalCode,
} from '../config/config-digest.js'
export { createSchemaCatalog, type SchemaCatalog, type SchemaRef } from '../config/schema-catalog.js'
export {
  type ConfigSource,
  createFetchConfigSource,
  createFileConfigSource,
  type FetchConfigSource,
  type FetchedSnapshot,
  type FileConfigSource,
  type SnapshotFetcher,
} from '../config/snapshot-source.js'

export type ConfigProvider = {
  providerId: typeof CONFIG_PROVIDER_ID
  contract: typeof CONFIG_CONTRACT
  packageName: typeof CONFIG_PACKAGE
  read(input: unknown): ConfigOutcome<ConfigReadResult>
  resolve(input: unknown): ConfigOutcome<ConfigResolveResult>
  dispose(): void
}

function firstError(errors: { message: string }[]): string {
  return errors[0]?.message ?? 'invalid document'
}

export function createConfigProvider(source: ConfigSource, catalog: SchemaCatalog): ConfigProvider {
  let disposed = false
  return {
    providerId: CONFIG_PROVIDER_ID,
    contract: CONFIG_CONTRACT,
    packageName: CONFIG_PACKAGE,
    read(input) {
      if (disposed || source.disposed) {
        return { ok: false, refusal: configRefusal('disposed', '', 'config provider is disposed') }
      }
      const parsed = validateRuntime('ConfigReadRequest', input)
      if (!parsed.ok)
        return { ok: false, refusal: configRefusal('schema_invalid', '/read', firstError(parsed.errors)) }
      return source.read(parsed.value.sourceRef, parsed.value.revision)
    },
    resolve(input) {
      if (disposed || source.disposed) {
        return { ok: false, refusal: configRefusal('disposed', '', 'config provider is disposed') }
      }
      return resolveConfigRequest(input, catalog)
    },
    dispose() {
      disposed = true
      source.dispose()
    },
  }
}

export function createFileConfigProvider(
  load: (sourceRef: string) => string | null,
  catalog: SchemaCatalog = createSchemaCatalog(),
): { provider: ConfigProvider; source: FileConfigSource; catalog: SchemaCatalog } {
  const source = createFileConfigSource(load)
  return { provider: createConfigProvider(source.source, catalog), source, catalog }
}

export function createFetchConfigProvider(
  fetchSnapshot: SnapshotFetcher,
  catalog: SchemaCatalog = createSchemaCatalog(),
): { provider: ConfigProvider; source: FetchConfigSource; catalog: SchemaCatalog } {
  const source = createFetchConfigSource(fetchSnapshot)
  return { provider: createConfigProvider(source.source, catalog), source, catalog }
}

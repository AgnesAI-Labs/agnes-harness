import {
  createSecretsEnv,
  createSecretsFile,
  type createSqliteStorage,
  privateStateRoots,
  type ScanRead,
} from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import type { StartSupervisorOptions } from '../assembly-options.js'
import { secretsDirectory } from '../assembly-secrets.js'
import { adaptHostTables } from '../storage-adapters.js'
import { openTelemetry } from './service.js'

export function openProductionTelemetry(
  options: StartSupervisorOptions,
  home: string,
  scan: (key: string) => ScanRead<EventEnvelope>,
  storage: ReturnType<typeof createSqliteStorage>,
) {
  const secretsDir =
    options.profile.adapters?.secrets?.kind === 'file'
      ? secretsDirectory(options.profile, options.config)
      : undefined
  return openTelemetry({
    home,
    scan,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.configuration ? { configuration: options.configuration } : {}),
    table: () => adaptHostTables(storage.tables('@agnes/telemetry')).table('trace_upload_watermarks'),
    paths: (cwd) => ({
      privatePaths: [
        options.config.dataDir,
        ...privateStateRoots({
          home,
          dataDir: options.config.dataDir,
          profileDir: options.profileDir,
          ...(cwd ? { workspace: cwd } : {}),
          ...(secretsDir ? { secretsDir } : {}),
        }),
      ],
      workspacePaths: options.workspaceRoot ? [options.workspaceRoot] : [],
    }),
    credentials: async () => {
      const values = [...((await options.configuration?.telemetrySecrets?.()) ?? [])]
      const env = createSecretsEnv()
      const file = secretsDir ? createSecretsFile({ dir: secretsDir }) : undefined
      for (const route of options.profile.provider?.routes ?? []) {
        if (route.baseUrl) values.push(route.baseUrl)
        if (route.displayName) values.push(route.displayName)
        if (!route.credentialRef) continue
        for (const store of [file, env]) {
          try {
            if (store) values.push(store.resolve(route.credentialRef))
          } catch {
            // A route may have credentials in either fitted store.
          }
        }
      }
      for (const [name, value] of Object.entries(process.env))
        if (
          value &&
          /^(?:AGNES_SECRET_)|(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN)$/.test(name)
        )
          values.push(value)
      return values
    },
  })
}

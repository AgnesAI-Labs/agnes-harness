import {
  createCredentialStore,
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

// Names that hold a credential by convention. `PWD` alone is the working directory, so only a
// prefixed `*_PWD` counts.
const SECRET_ENV = /^AGNES_SECRET_|(?:^|_)(?:SECRET|PASSWORD|PASSWD|PASS|TOKEN|KEY|CREDENTIALS?)$|_PWD$/i

/**
 * Values are matched literally anywhere in a turn, so a short or dictionary-shaped value such as
 * `password` or `localhost` would erase ordinary prose. Real keys and passwords are longer or mix
 * in digits and punctuation.
 */
function distinctive(value: string): boolean {
  return value.length >= 8 && (/[^A-Za-z]/.test(value) || value.length >= 16)
}

export function secretEnvValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value && SECRET_ENV.test(name) && distinctive(value) ? [value] : [],
  )
}

/** Generic credentials hold plugin, MCP and service keys that a turn can echo from any file. */
export async function storedSecretValues(home: string): Promise<string[]> {
  const store = createCredentialStore({ root: home })
  const values: string[] = []
  for (const { id } of await store.listGeneric()) {
    const credential = await store.read(id)
    if (credential?.kind === 'api-key' && credential.value.trim().length >= 6) values.push(credential.value)
  }
  return values
}

/** Every value the redactor treats as a secret wherever it appears in a turn. */
export async function telemetryCredentials(
  options: Pick<StartSupervisorOptions, 'configuration' | 'profile'>,
  home: string,
  secretsDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const values = [
    ...((await options.configuration?.telemetrySecrets?.()) ?? []),
    // An unreadable store fails the run: its keys could not be redacted from the upload.
    ...(await storedSecretValues(home)),
    ...secretEnvValues(env),
  ]
  const secretsEnv = createSecretsEnv()
  const file = secretsDir ? createSecretsFile({ dir: secretsDir }) : undefined
  for (const route of options.profile.provider?.routes ?? []) {
    if (route.baseUrl) values.push(route.baseUrl)
    if (route.displayName) values.push(route.displayName)
    if (!route.credentialRef) continue
    for (const store of [file, secretsEnv]) {
      try {
        if (store) values.push(store.resolve(route.credentialRef))
      } catch {
        // A route may have credentials in either fitted store.
      }
    }
  }
  return values
}

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
    credentials: () => telemetryCredentials(options, home, secretsDir),
  })
}

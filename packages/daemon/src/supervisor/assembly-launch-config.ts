import {
  composeSecrets,
  type createPlatform,
  createSecretsEnv,
  createSecretsFile,
  type ResolvedProfile,
} from '@agnes/host'
import type { StartSupervisorOptions } from './assembly-options.js'
import { secretsDirectory } from './assembly-secrets.js'
import { buildConfig } from './config.js'
import type { RunAgnesdArgs, RunAgnesdDeps } from './runtime.js'
import type { resolveDaemonScope } from './scope.js'
import { prepareDaemonSocketPaths } from './socket-paths.js'

type Scope = Awaited<ReturnType<typeof resolveDaemonScope>>
type Platform = ReturnType<ReturnType<typeof createPlatform>['snapshot']>
export function resolveLaunchConfig(
  args: RunAgnesdArgs,
  deps: RunAgnesdDeps,
  scope: Scope,
  profile: ResolvedProfile,
  platform: Platform,
) {
  // `buildConfig`'s own doc comment: the OS/transport shape comes from the caller, which already went
  // through host's platform adapter above - never a raw runtime OS check of this package's own.
  const ipc: 'unix' | 'pipe' = platform.os === 'win32' ? 'pipe' : 'unix'
  const config = buildConfig({
    args: { profile: scope.profile, ...args, dataDir: scope.dataDir },
    profile,
    home: scope.home,
    ipc,
  })
  prepareDaemonSocketPaths(config)
  const localWeb =
    deps.localWeb ??
    (args.localWebAddr !== undefined || args.localWebOrigin !== undefined
      ? { addr: args.localWebAddr ?? '127.0.0.1:0', origin: args.localWebOrigin ?? '' }
      : undefined)
  if (localWeb) {
    if (!localWeb.addr || !localWeb.origin)
      throw new Error('local Web requires both address and exact origin')
    config.localWeb = localWeb
    delete config.ws
  }
  let remoteAuth: StartSupervisorOptions['remoteAuth']
  if (config.ws) {
    const resolver =
      deps.secrets ??
      (profile.adapters.secrets.kind === 'file'
        ? composeSecrets(
            createSecretsFile({
              dir: secretsDirectory(profile, config),
            }),
            createSecretsEnv(),
          )
        : createSecretsEnv())
    const { cert, key } = config.ws
    config.ws = { ...config.ws, cert: resolver.resolve(cert), key: resolver.resolve(key) }
    const transportAuth = profile.transports.find((transport) => transport.kind === 'ws-tls')?.auth
    const sourceAuthCredentials = transportAuth?.sourceAuthSecrets?.map((credentialId) => ({
      credentialId,
      secret: resolver.resolve(credentialId),
    }))
    const jwt = transportAuth?.jwt
    if (sourceAuthCredentials?.length || (jwt?.issuer && (jwt.secret || jwt.jwks))) {
      remoteAuth = {
        ...(sourceAuthCredentials?.length ? { sourceAuthCredentials } : {}),
        ...(transportAuth?.rotationGraceMs !== undefined
          ? { rotationGraceMs: transportAuth.rotationGraceMs }
          : {}),
        ...(jwt?.issuer && (jwt.secret || jwt.jwks)
          ? {
              jwt: {
                issuer: jwt.issuer,
                ...(jwt.secret ? { secret: resolver.resolve(jwt.secret) } : {}),
                ...(jwt.jwks ? { jwksUrl: jwt.jwks } : {}),
              },
            }
          : {}),
      }
    }
  }

  return { config, localWeb, remoteAuth }
}

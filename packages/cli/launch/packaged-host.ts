import { dirname, join } from 'node:path'
import {
  createHost,
  createJitiPackageLoader,
  createLoader,
  HostError,
  type HostOptions,
  loadChildEnginePluginLayers,
  type PackageLoader,
  type PackageModule,
  type Prompter,
  packageDir,
  type ResolvedProfile,
  readLock,
  readNamedExports,
  verifyLockIntegrity,
} from '@agnes/host'
import type { AgnesPluginManifestEntry } from '@agnes/package-manager'
import { AGNES_BASE_PLUGIN_METADATA } from './base-plugin-metadata.js'

declare const AGNES_BASE_EXTENSION_MANIFESTS: NonNullable<PackageModule['embeddedExtensions']> | undefined
declare const AGNES_CODE_EXTENSION_MANIFESTS: NonNullable<PackageModule['embeddedExtensions']> | undefined

/**
 * SEA workers cannot read workspace package.json files at runtime. Keep the normalized form of
 * @agnes/base's package.json#agnes.plugins declaration beside the packaged importer instead.
 */
export const AGNES_BASE_PLUGIN_DECLARATIONS = Object.freeze(
  (
    [
      {
        export: 'toolPolicyPlugin',
        apiRange: '^4.0.0',
        id: 'tool-policy:default',
        inject: ['providers', 'planMode'],
        optionalInject: ['planMode'],
        runtime: 'in-process',
        default: true,
      },
      {
        id: 'observability:otel',
        export: 'observabilityPlugin',
        inject: ['providers'],
        runtime: 'in-process',
        default: true,
        apiRange: '^4.0.0',
        configReload: 'next-session',
        configSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
              default: false,
              description: 'Enable OpenTelemetry export.',
            },
            endpoint: {
              type: 'string',
              format: 'uri',
              description: 'OTLP collector URL.',
            },
            tracesEndpoint: {
              type: 'string',
              format: 'uri',
            },
            metricsEndpoint: {
              type: 'string',
              format: 'uri',
            },
            batchMs: {
              type: 'integer',
              minimum: 10,
              maximum: 30000,
              default: 1000,
            },
            timeoutMs: {
              type: 'integer',
              minimum: 10,
              maximum: 30000,
              default: 3000,
            },
            logsEndpoint: {
              type: 'string',
              format: 'uri',
            },
            redaction: {
              enum: ['metadata', 'content'],
              default: 'metadata',
              description: 'Choose metadata-only or content telemetry.',
            },
            batchSize: {
              type: 'integer',
              minimum: 1,
              maximum: 16384,
            },
            queueSize: {
              type: 'integer',
              minimum: 1,
              maximum: 16384,
              default: 1024,
            },
            shutdownPolicy: {
              enum: ['flush', 'discard'],
              default: 'flush',
            },
            headers: {
              type: 'object',
              maxProperties: 16,
              description:
                'OTLP headers use environment secret references; header values are never stored here.',
              propertyNames: {
                pattern: '^[a-zA-Z0-9-]{1,128}$',
                not: {
                  enum: ['content-type', 'host', 'content-length'],
                },
              },
              additionalProperties: {
                type: 'object',
                required: ['secretRef'],
                additionalProperties: false,
                properties: {
                  secretRef: {
                    type: 'string',
                    pattern: '^env:[A-Z_][A-Z0-9_]{0,123}$',
                    description: 'Environment secret reference, for example env:OTLP_TOKEN.',
                  },
                },
              },
            },
          },
        },
      },
      {
        export: 'seamProvidersPlugin',
        apiRange: '^4.0.0',
        id: 'seam-providers:default',
        inject: ['providers'],
        default: true,
        runtime: 'in-process',
      },
      {
        export: 'defaultLoopPlugin',
        id: 'loop:agnes.default',
        inject: ['providers'],
        runtime: 'in-process',
        default: true,
        apiRange: '^4.0.0',
      },
      {
        export: 'codexChildAgentsPlugin',
        id: 'child-agent:codex',
        inject: ['providers'],
        runtime: 'in-process',
        default: false,
        apiRange: '^4.0.0',
      },
      {
        export: 'claudeCodeChildAgentsPlugin',
        id: 'child-agent:claude-code',
        inject: ['providers'],
        runtime: 'in-process',
        default: false,
        apiRange: '^4.0.0',
      },
      {
        export: 'sdkChildAgentsPlugin',
        id: 'child-agent:sdk',
        inject: ['providers'],
        runtime: 'in-process',
        default: false,
        apiRange: '^4.0.0',
      },
      {
        id: 'memory:file',
        export: 'memoryPlugin',
        inject: ['providers'],
        runtime: 'in-process',
        default: true,
        apiRange: '^4.0.0',
      },
      {
        id: 'skills:remembering',
        export: 'rememberingPlugin',
        inject: ['skills'],
        runtime: 'in-process',
        default: true,
        apiRange: '^4.0.0',
      },
      {
        id: 'reference-resolvers:default',
        export: 'referenceResolversPlugin',
        inject: ['providers'],
        runtime: 'in-process',
        default: true,
        apiRange: '^4.0.0',
      },
      {
        id: 'service:plan-mode',
        export: 'planModePlugin',
        inject: ['providers', 'services'],
        provide: ['planMode'],
        runtime: 'in-process',
        default: true,
        apiRange: '^4.0.0',
        capabilities: {
          services: [
            {
              name: 'plan.status',
              kind: 'query',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: { type: 'object', additionalProperties: true },
              timeoutMs: 10000,
              maxResultBytes: 1048576,
            },
            {
              name: 'plan.command',
              kind: 'effect',
              inputSchema: {
                type: 'object',
                properties: { line: { type: 'string', maxLength: 8192, pattern: '^\\s*/plan(?:\\s|$)' } },
                required: ['line'],
                additionalProperties: false,
              },
              outputSchema: { type: 'object', additionalProperties: true },
              timeoutMs: 10000,
              maxResultBytes: 1048576,
            },
          ],
        },
      },
    ] satisfies readonly Readonly<AgnesPluginManifestEntry>[]
  ).map((entry) => {
    const metadata = AGNES_BASE_PLUGIN_METADATA[entry.id]
    return Object.freeze({ ...entry, ...(metadata === undefined ? {} : { metadata }) })
  }),
)

export const AGNES_CODE_PLUGIN_DECLARATIONS = Object.freeze([
  Object.freeze({
    id: 'system-prompt:default',
    export: 'systemPromptPlugin',
    apiRange: '^4.0.0',
    inject: ['providers'],
    runtime: 'in-process',
    default: true,
  } satisfies AgnesPluginManifestEntry),
])

export function readPackagedBuiltinExports(
  id: string,
  entryFile: string,
  module: Record<string, unknown>,
): PackageModule {
  return readNamedExports(
    id,
    entryFile,
    module,
    id === '@agnes/base'
      ? AGNES_BASE_PLUGIN_DECLARATIONS
      : id === '@agnes/code'
        ? AGNES_CODE_PLUGIN_DECLARATIONS
        : undefined,
  )
}

/** Builtin modules are compiled into the executable; external packages retain lock/integrity checks. */
export function packagedPackages(profile: ResolvedProfile, home: string, entryFile: string) {
  const profileDir = join(home, 'profiles', profile.name)
  const hostRoot = dirname(entryFile)
  const lock = readLock(profileDir, { profile: profile.name, agnesVersion: '0.0.0' })
  verifyLockIntegrity(lock, { dataDir: profile.dataDir, profile: profile.name })
  const jiti = createLoader({ cacheDir: profile.cacheDir, hostRoot, agnesVersion: '0.0.0' })
  const external = createJitiPackageLoader(jiti)
  const builtin = async (id: string): Promise<Record<string, unknown>> => {
    if (id === '@agnes/ai') return import('@agnes/ai')
    if (id === '@agnes/base') return import('@agnes/base')
    if (id === '@agnes/code') return import('@agnes/code')
    throw new HostError('E_DEP_MISSING', 'unknown builtin package')
  }
  const isBuiltin = (id: string) => ['@agnes/ai', '@agnes/base', '@agnes/code'].includes(id)
  const loader: PackageLoader = {
    async importPackage(id, dir) {
      if (!isBuiltin(id)) return external.importPackage(id, dir)
      const { extensionEntry: _fileEntry, ...module } = readPackagedBuiltinExports(
        id,
        entryFile,
        await builtin(id),
      )
      const manifests =
        id === '@agnes/base'
          ? typeof AGNES_BASE_EXTENSION_MANIFESTS === 'undefined'
            ? undefined
            : AGNES_BASE_EXTENSION_MANIFESTS
          : id === '@agnes/code'
            ? typeof AGNES_CODE_EXTENSION_MANIFESTS === 'undefined'
              ? undefined
              : AGNES_CODE_EXTENSION_MANIFESTS
            : undefined
      if (id !== '@agnes/ai' && !manifests)
        throw new HostError(
          'E_DEP_MISSING',
          'packaged extension manifests are missing; rebuild the local distribution',
        )
      return manifests ? { ...module, embeddedExtensions: manifests } : module
    },
  }
  return {
    loader,
    extensionLoader: jiti,
    packageDirs: new Map<string, string>(
      profile.packages
        .filter((pkg) => pkg.enabled)
        .map((pkg) => [
          pkg.id,
          isBuiltin(pkg.id) ? hostRoot : packageDir(profile.dataDir, profile.name, pkg.id),
        ]),
    ),
  }
}

export async function createPackagedHost(
  profile: ResolvedProfile,
  prompter: Prompter,
  options: {
    home: string
    cwd: string
    entryFile: string
    log?: HostOptions['log']
  } & Pick<
    HostOptions,
    | 'scheduling'
    | 'boundWakes'
    | 'skillResources'
    | 'skillInstall'
    | 'runtimePluginSnapshots'
    | 'runtimePluginSources'
    | 'deferInitialGeneration'
    | 'managedExtensionPackageIds'
    | 'serviceAuthority'
  >,
) {
  const { home, cwd, entryFile, log, ...resources } = options
  const ordinaryPluginLayers = await loadChildEnginePluginLayers({ home, profile: profile.name })
  return createHost(profile, {
    dataDir: profile.dataDir,
    profileDir: join(home, 'profiles', profile.name),
    workspaceRoot: cwd,
    hostRoot: dirname(entryFile),
    agnesVersion: '0.0.0',
    prompter,
    log: log ?? { debug() {}, info() {}, warn() {}, error() {} },
    ...packagedPackages(profile, home, entryFile),
    ...resources,
    ...(ordinaryPluginLayers ? { ordinaryPluginLayers } : {}),
  })
}

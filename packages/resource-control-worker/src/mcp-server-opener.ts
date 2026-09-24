import { createHash } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { connectMcp, type McpServerOpener } from '@agnes/base'
import { jcs, type McpServerDefinitionInput, validateResourceControlData } from '@agnes/protocol'
import {
  type McpCredentialResolver,
  type McpHttpPolicy,
  type McpOAuthCredentialResolver,
  type McpStdioPolicy,
  resolvedConfig,
  validateManagedHttpUrl,
} from '@agnes/resource-control-runtime'
import type { WorkerResourceBootstrapInput } from './runtime-bootstrap.js'
import { deploymentMcpPolicy } from './skill-bootstrap.js'

export function managedMcpExecutableShape(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32' || !win32.isAbsolute(executable)) return false
  const name = win32
    .basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(name)) return false
  return /\.exe$/i.test(executable)
}

/** An MCP trust decision may authorize a local program only after checking the actual file. */
export async function verifyManagedMcpExecutable(
  executable: string,
  platform: NodeJS.Platform = process.platform, // guards-allow-platform: native executable checks must match the worker OS.
): Promise<void> {
  if (!managedMcpExecutableShape(executable, platform))
    throw new Error('MCP executable is not eligible for Windows automatic authorization')
  if (!managedMcpExecutableShape(await realpath(executable), platform))
    throw new Error('MCP executable resolves to an ineligible Windows program')
  const info = await stat(executable)
  if (!info.isFile()) throw new Error('MCP executable is not a regular file')
  const file = await open(executable, 'r')
  try {
    const header = Buffer.alloc(2)
    const { bytesRead } = await file.read(header, 0, 2, 0)
    if (bytesRead !== 2 || header.toString('ascii') !== 'MZ')
      throw new Error('MCP executable is not a Windows executable')
  } finally {
    await file.close()
  }
}

type ManagedEntry = Readonly<{
  definition: McpServerDefinitionInput
  desired: string
  trust: string
}>

/** Windows settings flow: grant only validated native programs from trusted enabled definitions. */
export async function syncManagedMcpExecutableAllowlist(
  entries: readonly ManagedEntry[],
  deploymentAllowed: readonly string[],
  managedAllowed: string[],
  env: NodeJS.ProcessEnv,
  restoreUnset: boolean,
): Promise<void> {
  if (process.platform !== 'win32') return // guards-allow-platform: Mac/POSIX keep the upstream approval path.
  const verified: string[] = []
  for (const entry of entries) {
    if (
      entry.trust !== 'trusted' ||
      entry.desired !== 'enabled' ||
      entry.definition.transport.kind !== 'stdio' ||
      !validateResourceControlData('McpServerDefinitionInput', entry.definition).ok
    )
      continue
    const executable = entry.definition.transport.executable
    if (verified.includes(executable)) continue
    try {
      await verifyManagedMcpExecutable(executable)
      verified.push(executable)
    } catch {
      // An invalid file must reach the row as an unavailable connection, never as an allowed tool.
    }
  }
  managedAllowed.splice(0, managedAllowed.length, ...verified)
  const effective = [...new Set([...deploymentAllowed, ...verified])]
  if (effective.length === 0 && restoreUnset) delete env.AGNES_MCP_STDIO_ALLOWLIST
  else env.AGNES_MCP_STDIO_ALLOWLIST = effective.join(',')
}

export type McpServerOpenerDeps = Readonly<{
  /** Same shape `bootstrapWorkerResources` already builds for `createMcpResourceManager`'s own
   * `credentials` option (lazily memoized `input.createSecrets(...).resolve`). */
  resolver: McpCredentialResolver
  baseEnv: Readonly<Record<string, string>>
  stdioPolicy: McpStdioPolicy
  httpPolicy: McpHttpPolicy
  /** Omitted, an oauth-bound definition fails closed inside `resolvedConfig` itself
   * (`McpOAuthNeedsReconnectError`) -- matching `bootstrapWorkerResources`'s own optional wiring.
   * Moot in practice: `mcpServerRowsFromDefinitions` (`@agnes/worker-runtime`) filters
   * `secretBinding.kind === 'oauth'` definitions out before any row (and so this opener) ever sees
   * them (design doc §3.4, D105/D109). */
  oauthCredentials?: McpOAuthCredentialResolver
  approvedLocalStart?(definition: McpServerDefinitionInput): Promise<boolean>
  connectTimeoutMs?: number
}>

/**
 * Composes `resolvedConfig` (credential resolution + deployment policy) with `connectMcp`
 * (stage 2b step 3, D102) into the one `McpServerOpener` port `@agnes/base`'s row extensions depend
 * on. One instance is definition-agnostic and serves every MCP row: `deps` here is deployment-wide
 * state (the credential resolver, the two policies), never anything specific to one server.
 *
 * `resolvedConfig`'s first parameter is `McpManagedInput` (`{definition, revision, desired, trust}`),
 * but reading its implementation shows only `.definition` is ever read -- `revision`/`desired`/
 * `trust` exist for `createMcpResourceManager`'s own bookkeeping, not for config resolution itself.
 * The placeholder values below are therefore inert, not guesses: this call would behave identically
 * for any other `revision`/`desired`/`trust`, and a change to `resolvedConfig` that started reading
 * them would need this comment (and likely this whole function's signature) revisited anyway.
 */
export function createMcpServerOpener(deps: McpServerOpenerDeps): McpServerOpener {
  return Object.freeze({
    async connect(definition, signal) {
      const approved = definition.transport.kind === 'stdio' && (await deps.approvedLocalStart?.(definition))
      const stdioPolicy =
        approved && definition.transport.kind === 'stdio'
          ? { allowedExecutables: [...deps.stdioPolicy.allowedExecutables, definition.transport.executable] }
          : deps.stdioPolicy
      const config = await resolvedConfig(
        { definition, revision: '', desired: 'enabled', trust: 'trusted' },
        deps.resolver,
        signal,
        deps.baseEnv,
        { stdioPolicy, httpPolicy: deps.httpPolicy },
        deps.oauthCredentials ? { oauthCredentials: deps.oauthCredentials } : undefined,
      )
      return connectMcp(config, undefined, {
        signal,
        ...(deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {}),
        // Same redirect re-validation bootstrapWorkerResources already wires for
        // createMcpResourceManager's own `connect` -- an HTTP redirect target must pass the same
        // loopback/HTTPS policy the configured URL already passed (SSRF).
        validateRedirectUrl: (url) => validateManagedHttpUrl(url, deps.httpPolicy),
      })
    },
  })
}

/**
 * The one `McpServerOpener` a shared session worker gives every MCP row (stage 2b step 3), wired
 * exactly like `bootstrapWorkerResources` wires `createMcpResourceManager` today: the same
 * `AGNES_RESOURCE_MCP_POLICY` deployment policy, and the same lazily built `createSecrets` resolver
 * (a worker whose servers all use `secretBinding: none` never needs a configured secret backend).
 * The resolver is built once per worker, not per generation: the file and env resolvers read their
 * source on every `resolve`, so a rotated secret is still picked up by the next connect attempt.
 * `baseEnv` is `{}` because the manager's `baseEnvironment` is never set in production either.
 * No OAuth resolver: OAuth-bound definitions never become rows (design §3.4, D105/D109).
 */
export function createWorkerMcpServerOpener(
  input: Pick<WorkerResourceBootstrapInput, 'env' | 'profile' | 'createSecrets'>,
  managedAllowedExecutables: readonly string[] = [],
): McpServerOpener {
  const policy = deploymentMcpPolicy(input.env)
  let secrets: ReturnType<WorkerResourceBootstrapInput['createSecrets']> | undefined
  return createMcpServerOpener({
    resolver: async (ref, signal) => {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      secrets ??= input.createSecrets(input.profile)
      return secrets.resolve(ref)
    },
    ...(policy.localStartApprovals && input.env.AGNES_RESOURCE_SNAPSHOT
      ? {
          approvedLocalStart: (definition: McpServerDefinitionInput) =>
            snapshotApprovesLocalStart(
              input.env.AGNES_RESOURCE_SNAPSHOT as string,
              input.profile.name,
              definition,
            ),
        }
      : {}),
    baseEnv: {},
    stdioPolicy: {
      get allowedExecutables() {
        return [...policy.allowedExecutables, ...managedAllowedExecutables]
      },
    },
    httpPolicy: { allowLoopbackHttp: policy.allowLoopbackHttp, localDaemon: policy.localDaemon },
  })
}

/** Read the daemon-owned snapshot on each reconnect; a revoked/changed definition fails closed. */
export async function snapshotApprovesLocalStart(
  path: string,
  profile: string,
  definition: McpServerDefinitionInput,
): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object') return false
    const snapshot = raw as Record<string, unknown>
    if (
      snapshot.profile !== profile ||
      snapshot.mcpAuthority !== 'resource-control' ||
      !Array.isArray(snapshot.mcp)
    )
      return false
    const revision = createHash('sha256').update(jcs(definition)).digest('hex')
    return snapshot.mcp.some((item: unknown) => {
      if (!item || typeof item !== 'object') return false
      const row = item as Record<string, unknown>
      return (
        row.trust === 'trusted' &&
        row.desired === 'enabled' &&
        row.revision === revision &&
        row.localStartApproval === revision &&
        jcs(row.definition) === jcs(definition)
      )
    })
  } catch {
    return false
  }
}

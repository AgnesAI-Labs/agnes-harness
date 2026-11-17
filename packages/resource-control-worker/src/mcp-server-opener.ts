import { createHash, createHmac, randomBytes } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { connectMcp, type McpServerOpener } from '@agnes/base'
import { jcs, type McpServerDefinitionInput, validateResourceControlData } from '@agnes/protocol'
import {
  type McpCredentialResolver,
  type McpHttpPolicy,
  type McpOAuthStore,
  type McpStdioPolicy,
  mcpOAuthAuthorizer,
  resolvedConfig,
  validateManagedHttpUrl,
} from '@agnes/resource-control-runtime'
import {
  type McpSandboxContext,
  mcpConnectionBudget,
  mcpSandboxProfile,
  sandboxMcpConfig,
} from './mcp-sandbox.js'
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
  /** Where OAuth servers keep their sign-in, built on first use. Omitted, an OAuth server needs
   * sign-in (`McpOAuthNeedsReconnectError`) and is never contacted. */
  oauthStore?(): McpOAuthStore
  approvedLocalStart?(definition: McpServerDefinitionInput): Promise<boolean>
  connectTimeoutMs?: number
  sandbox?: McpSandboxContext
}>

/**
 * Composes `resolvedConfig` (credential resolution + deployment policy) with `connectMcp`
 * into the one `McpServerOpener` port `@agnes/base`'s row extensions depend
 * on. One instance is definition-agnostic and serves every MCP row: `deps` here is deployment-wide
 * state (the credential resolver, the two policies), never anything specific to one server.
 *
 * An OAuth server's connection gets a per-request authorizer instead of a token in its config, so
 * the pool key never holds a token and a refresh never needs a new connection.
 *
 * `resolvedConfig`'s first parameter is `McpManagedInput` (`{definition, revision, desired, trust}`),
 * but reading its implementation shows only `.definition` is ever read -- `revision`/`desired`/
 * `trust` exist for `createMcpResourceManager`'s own bookkeeping, not for config resolution itself.
 * The placeholder values below are therefore inert, not guesses: this call would behave identically
 * for any other `revision`/`desired`/`trust`, and a change to `resolvedConfig` that started reading
 * them would need this comment (and likely this whole function's signature) revisited anyway.
 */
export function createMcpServerOpener(deps: McpServerOpenerDeps): McpServerOpener {
  const salt = randomBytes(32)
  const prepare: NonNullable<McpServerOpener['prepare']> = async (definition, signal) => {
    const approved = definition.transport.kind === 'stdio' && (await deps.approvedLocalStart?.(definition))
    const stdioPolicy =
      approved && definition.transport.kind === 'stdio'
        ? {
            ...deps.stdioPolicy,
            allowedExecutables: [...deps.stdioPolicy.allowedExecutables, definition.transport.executable],
          }
        : deps.stdioPolicy
    const resolved = await resolvedConfig(
      { definition, revision: '', desired: 'enabled', trust: 'trusted' },
      deps.resolver,
      signal,
      deps.baseEnv,
      { stdioPolicy, httpPolicy: deps.httpPolicy },
    )
    const authorize = await mcpOAuthAuthorizer(definition, {
      store: definition.secretBinding.kind === 'oauth' ? deps.oauthStore?.() : undefined,
      resolver: deps.resolver,
      signal,
    })
    const candidate = {
      ...resolved,
      ...(definition.transport.kind === 'stdio'
        ? {
            sandboxProfile: mcpSandboxProfile(definition, deps.sandbox) as NonNullable<
              typeof resolved.sandboxProfile
            >,
          }
        : {}),
    }
    const budget =
      candidate.transport === 'stdio' && candidate.sandboxProfile !== 'off-with-warning'
        ? mcpConnectionBudget(deps.connectTimeoutMs)
        : undefined
    const config = await sandboxMcpConfig(candidate, deps.sandbox, signal, budget)
    // Worker-local HMAC avoids persisting credentials or exposing guessable credential digests.
    const key = createHmac('sha256', salt).update(jcs({ definition, config })).digest('hex')
    return Object.freeze({
      key,
      // A prepared confined config belongs to this attempt's deadline. Keep only the numeric
      // deadline: the pool connects immediately with its own signal, independent of this lease.
      connect: async (signal: AbortSignal) => {
        if (budget) signal.throwIfAborted()
        return connectMcp(config, undefined, {
          signal,
          ...(budget
            ? { connectTimeoutMs: budget.remaining() }
            : deps.connectTimeoutMs !== undefined
              ? { connectTimeoutMs: deps.connectTimeoutMs }
              : {}),
          validateRedirectUrl: (url) => validateManagedHttpUrl(url, deps.httpPolicy),
          ...(authorize ? { authorize } : {}),
        })
      },
    })
  }
  return Object.freeze({
    prepare,
    async connect(definition, signal) {
      return (await prepare(definition, signal)).connect(signal)
    },
  })
}

/**
 * The one `McpServerOpener` a shared session worker gives every MCP row, wired
 * exactly like `bootstrapWorkerResources` wires `createMcpResourceManager` today: the same
 * `AGNES_RESOURCE_MCP_POLICY` deployment policy, and the same lazily built `createSecrets` resolver
 * (a worker whose servers all use `secretBinding: none` never needs a configured secret backend).
 * The resolver is built once per worker, not per generation: the file and env resolvers read their
 * source on every `resolve`, so a rotated secret is still picked up by the next connect attempt.
 * `baseEnv` is `{}` because the manager's `baseEnvironment` is never set in production either.
 * The OAuth store is built the same lazy way, the first time an OAuth server connects.
 */
export function createWorkerMcpServerOpener(
  input: Pick<
    WorkerResourceBootstrapInput,
    'env' | 'profile' | 'createSecrets' | 'createMcpOAuthStore' | 'cwd' | 'agnesHomeDir'
  >,
  managedAllowedExecutables: readonly string[] = [],
): McpServerOpener {
  const policy = deploymentMcpPolicy(input.env)
  let secrets: ReturnType<WorkerResourceBootstrapInput['createSecrets']> | undefined
  let oauthStore: McpOAuthStore | undefined
  const createMcpOAuthStore = input.createMcpOAuthStore
  return createMcpServerOpener({
    ...(createMcpOAuthStore ? { oauthStore: () => (oauthStore ??= createMcpOAuthStore(input.profile)) } : {}),
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
    sandbox: {
      ...(input.agnesHomeDir ? { home: input.agnesHomeDir } : {}),
      ...(input.profile.adapters?.secrets.path ? { secretsDir: input.profile.adapters.secrets.path } : {}),
      ...(input.agnesHomeDir ? { profileDir: join(input.agnesHomeDir, 'profiles', input.profile.name) } : {}),
      dataDir: input.profile.dataDir,
      ...(input.cwd ? { workspace: input.cwd } : {}),
      ...(input.env.PATH ? { path: input.env.PATH } : {}),
    },
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

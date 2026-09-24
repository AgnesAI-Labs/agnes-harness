import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectMcp, inspectRemoteCatalog } from '@agnes/base'
import {
  type McpStatus,
  type SkillDescriptor,
  type SkillRootStatus,
  validateResourceControlData,
} from '@agnes/protocol'
import {
  createMcpOAuthCredentialResolver,
  createMcpResourceManager,
  createSkillCandidateRegistry,
  createWorkerResourceRuntime,
  type McpManagedInput,
  type McpOAuthCredentialStore,
  type ResourceActivationBarrier,
  validateManagedHttpUrl,
} from '@agnes/resource-control-runtime'
import { syncManagedMcpExecutableAllowlist } from './mcp-server-opener.js'
import { deploymentMcpPolicy, scanSkills } from './skill-bootstrap.js'
import { removeFilesystemSkill } from './skill-remove.js'
import { workspaceSkills } from './workspace-skills.js'

type ResourceProfile = Readonly<{
  name: string
  dataDir: string
  adapters: Readonly<{ secrets: Readonly<{ kind: string; path?: string }> }>
}>

type ResolvedSecrets = Readonly<{ resolve(ref: string): string | Promise<string> }>

/** Private resource state passed to Host and the daemon-only service command dispatcher. */
export type WorkerResourceState = Readonly<{
  removeSkill(descriptor: SkillDescriptor, validateOnly?: boolean): Promise<void>
  skillResources: ReturnType<ReturnType<typeof createWorkerResourceRuntime>['skillResources']>
  skills: readonly SkillDescriptor[]
  mcp: readonly McpStatus[]
  /**
   * The snapshot's MCP entries, each definition already schema-validated. With `mcpRows: true` this
   * is the only MCP output: the generation opened no connections, and the caller mounts one Host row
   * per server from these entries instead (`mcpServerRowsFromDefinitions`, @agnes/worker-runtime).
   */
  mcpEntries: readonly McpManagedInput[]
  revision: string
  discovery: Readonly<{
    candidates: readonly Readonly<{ descriptor: SkillDescriptor; capabilityHash: string }>[]
    failedRoots: readonly string[]
    /** Entries that looked like Skills but were skipped; the store keeps their prior records. */
    skippedResourceIds: readonly string[]
    roots: readonly SkillRootStatus[]
  }>
  runtime: ReturnType<typeof createWorkerResourceRuntime>
  /** Starts forwarding safe live MCP health only after the worker hello handshake. */
  reportMcpStatus(listener: (status: McpStatus) => void): void
}>

export type WorkerResourceBootstrapInput = Readonly<{
  env: NodeJS.ProcessEnv
  /** Explicit trusted workspace for a single-purpose resource worker. Shared workers omit it. */
  cwd?: string
  profile: ResourceProfile
  createBarrier(): ResourceActivationBarrier
  createSecrets(profile: ResourceProfile): ResolvedSecrets
  /**
   * Mirrors `createSecrets` above, for `secretBinding.kind === 'oauth'` (Task 6, spec §1.6/§3.2).
   * Optional and lazily invoked for the same reason `createSecrets`'s result is lazily memoized
   * below: a resource generation with no oauth-bound MCP servers must not require one configured.
   * Omitted (or a generation with no oauth-bound server), oauth-bound servers simply have no
   * `oauthCredentials` resolver reaching `createMcpResourceManager` and fail closed via
   * `resolvedConfig()`'s own `McpOAuthNeedsReconnectError`, not a crash here.
   */
  createOAuthCredentialStore?(profile: ResourceProfile): McpOAuthCredentialStore
  /**
   * The already-resolved Agnes home, for the one Agnes-owned Skill root among the five scanSkills
   * scans. This package cannot resolve it itself (see scanSkills's own comment on why), so a caller
   * that sits above both this package and @agnes/host in the dependency graph -- today, only
   * worker-runtime's bootstrap path -- computes it and passes it down. Omitted, scanSkills falls
   * back to its own OS-home-relative default, which stays correct as long as AGH_HOME is unset.
   */
  agnesHomeDir?: string
  /**
   * The shared session worker (stage 2b step 3, D107'): its MCP servers are Host rows, one per
   * server, each owning its own connection. This generation then connects nothing -- the manager gets
   * no MCP input -- and hands the validated entries back as `mcpEntries`. Omitted, the manager
   * connects them as before; dedicated resource-control service workers keep that path unchanged.
   */
  mcpRows?: boolean
}>

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Builds one immutable resource generation from the daemon-authored snapshot. This package owns the
 * worker-only interpretation of private Skill bodies, durable LKG and SecretRefs; callers receive
 * only the Host inputs and the safe hello observation needed by the supervisor control link.
 */
export async function bootstrapWorkerResources(
  input: WorkerResourceBootstrapInput,
): Promise<WorkerResourceState | undefined> {
  const resourceSnapshot = input.env.AGNES_RESOURCE_SNAPSHOT
  if (!resourceSnapshot || !existsSync(resourceSnapshot)) return undefined
  let parsed: unknown
  let snapshotText: string
  try {
    snapshotText = readFileSync(resourceSnapshot, 'utf8')
    parsed = JSON.parse(snapshotText)
  } catch {
    throw new Error('invalid worker resource snapshot')
  }
  const raw = parsed as {
    version?: unknown
    skills?: { control?: unknown }
    mcp?: unknown
    mcpAuthority?: unknown
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.version !== 1 ||
    !raw.skills?.control ||
    !Array.isArray(raw.mcp) ||
    raw.mcpAuthority !== 'resource-control'
  )
    throw new Error('invalid worker resource snapshot')

  for (const entry of raw.mcp) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !validateResourceControlData('McpServerDefinitionInput', entry.definition).ok
    )
      throw new Error('invalid worker resource snapshot')
  }

  // The validated daemon snapshot establishes managed authority even when no resources are
  // enabled. Keep an empty generation so ordinary chat workers cannot fall back to legacy MCP.
  const barrier = input.createBarrier()
  const registry = createSkillCandidateRegistry({ barrier })
  const skillControl = raw.skills.control
  // A resource generation with only `secretBinding: none` must not require a configured secret
  // backend. In particular, a failed or incomplete legacy secret adapter must not prevent an
  // otherwise safe stdio catalog from booting. Instantiate the resolver only at the sole point a
  // validated SecretRef is consumed; bindings that need one still fail closed there.
  let secrets: ResolvedSecrets | undefined
  let oauthCredentials: ReturnType<typeof createMcpOAuthCredentialResolver> | undefined
  let reportMcpStatus: ((status: McpStatus) => void) | undefined
  const mcpPolicy = deploymentMcpPolicy(input.env)
  // A Windows test worker is a separate process: rebuild the enabled server's native grant from
  // the daemon snapshot rather than assuming the session worker's process-local env reaches it.
  const selectedServer = input.env.AGNES_RESOURCE_TEST_SERVER ?? input.env.AGNES_RESOURCE_MCP_SERVER
  if (selectedServer && !input.mcpRows) {
    const selected = (raw.mcp as McpManagedInput[]).filter(
      (entry) => entry.definition.serverId === selectedServer,
    )
    const managedAllowed: string[] = []
    await syncManagedMcpExecutableAllowlist(
      selected,
      mcpPolicy.allowedExecutables,
      managedAllowed,
      input.env,
      input.env.AGNES_MCP_STDIO_ALLOWLIST === undefined,
    )
    mcpPolicy.allowedExecutables.push(...managedAllowed)
  }
  const manager = createMcpResourceManager({
    profile: input.profile.name,
    barrier,
    credentials: async (ref, signal) => {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      secrets ??= input.createSecrets(input.profile)
      return secrets.resolve(ref)
    },
    // Same lazy-construction discipline as `credentials` above: a generation with no oauth-bound
    // MCP server must not require `createOAuthCredentialStore` to be configured at all, and the
    // credential store itself (real implementation: file I/O under the Agnes home) is only built
    // the first time an oauth-bound server is actually resolved.
    ...(input.createOAuthCredentialStore
      ? {
          oauthCredentials: (
            serverId: string,
            signal: AbortSignal,
            serverUrl: URL,
            staticClientId: string | undefined,
          ) => {
            const buildStore = input.createOAuthCredentialStore
            if (!buildStore) throw new Error('unreachable: createOAuthCredentialStore checked above')
            oauthCredentials ??= createMcpOAuthCredentialResolver({
              credentialStore: buildStore(input.profile),
            })
            return oauthCredentials(serverId, signal, serverUrl, staticClientId)
          },
        }
      : {}),
    // Deployment-owned policy stays separate from resource definitions and durable state.
    stdioPolicy: { allowedExecutables: mcpPolicy.allowedExecutables },
    httpPolicy: { allowLoopbackHttp: mcpPolicy.allowLoopbackHttp, localDaemon: mcpPolicy.localDaemon },
    connect: async (config, options) =>
      connectMcp(config, undefined, {
        signal: options.signal,
        connectTimeoutMs: options.timeoutMs,
        // An HTTP redirect target gets the same HTTPS/loopback policy check the configured URL
        // already passed, so a compromised server cannot bounce the connection past it (SSRF).
        validateRedirectUrl: (url) =>
          validateManagedHttpUrl(url, {
            allowLoopbackHttp: mcpPolicy.allowLoopbackHttp,
            localDaemon: mcpPolicy.localDaemon,
          }),
      }),
    inspectCatalog: inspectRemoteCatalog,
    // Deliberately still a no-op, not the cross-worker notifier this docstring's function name might
    // suggest (@agnes/resource-control-runtime's `notifyLiveSessionWorkers`, resource-live-reload
    // Task 5). This function (bootstrapWorkerResources) always runs inside a spawned worker child
    // process (packages/daemon/src/supervisor/worker-pool.ts spawns `worker/main.js` via
    // node:child_process `spawn`, for every worker kind including `resourceControl` ones) - it has no
    // in-memory reference to the daemon's WorkerPool and cannot get one, since a live object reference
    // cannot cross an OS process boundary. The production notification instead lives entirely
    // daemon-side, wired directly at packages/daemon/src/supervisor/supervisor.ts's
    // `localResourceStore.setSuccessfulSnapshotHandler(...)` - the hook that already fires "only after
    // a successful effect's latest worker snapshot and terminal operation commit"
    // (resource-control-store/src/control-store.ts), i.e. exactly the "a real mutation durably
    // landed" moment this apply callback would otherwise need `applyActive`/`retireDisconnected`/
    // `close` to approximate from inside a single worker's own, possibly-non-mutating, bootstrap.
    apply: async () => undefined,
    onStatus: (status) => reportMcpStatus?.(status),
  })
  const runtime = createWorkerResourceRuntime({ profile: input.profile.name, skills: registry, mcp: manager })
  const scanned = await scanSkills(
    input.cwd,
    input.env.AGNES_PACKAGE_SKILL_SNAPSHOT,
    input.env.AGNES_RESOURCE_SKILL_LKG_DIR,
    input.env.HOME ?? input.env.USERPROFILE ?? homedir(),
    input.agnesHomeDir,
  )
  // A test/single-server candidate worker still needs its one server *staged* (createMcpResourceManager's
  // test()/tools() call verify(), which reads only from `staged`, populated by the manager's own
  // bootstrap reconcile over these entries - not by this file talking to it directly). But it must
  // never also be auto-*connected* by that same reconcile pass whenever it happens to already be
  // enabled and trusted: forcing `desired: 'disabled'` on the entry keeps `staged` populated while
  // leaving the explicit `resourceMcpTest` command (which opens its own transient connection via
  // `candidate()`, not `connectManaged()`) as this worker's only connection (single-resident-worker
  // design §3.4). AGNES_RESOURCE_MCP_SERVER: single-server management-plane candidates are retired
  // now that enable/disable/reconcile/reconnect go through the shared session worker's rows instead,
  // but the same staged-not-connected shape applies if anything still selects one.
  const managedMcp = input.mcpRows
    ? []
    : selectedServer
      ? (raw.mcp as Array<{ definition?: { serverId?: unknown }; desired?: unknown }>)
          .filter((item) => item.definition?.serverId === selectedServer)
          .map((item) => ({ ...item, desired: 'disabled' as const }))
      : raw.mcp
  const boot = await runtime.bootstrap(
    {
      mcpAuthority: 'resource-control',
      skills: {
        roots: scanned.roots,
        failedRoots: scanned.failedRoots as never,
        control: raw.skills.control as never,
      },
      mcp: managedMcp as never,
    },
    new AbortController().signal,
  )
  const capabilities = new Map<string, string>(
    scanned.roots.flatMap((root) =>
      root.candidates.map((candidate) => [candidate.resourceId, candidate.capabilityHash] as const),
    ),
  )
  return {
    removeSkill: (descriptor, validateOnly) =>
      removeFilesystemSkill({
        descriptor,
        validateOnly: validateOnly === true,
        stateDirectory: join(input.profile.dataDir, 'resource-control', 'skill-deletions'),
        cwd: input.cwd,
        osHomeDir: input.env.HOME ?? input.env.USERPROFILE ?? homedir(),
        agnesHomeDir: input.agnesHomeDir,
      }),
    skillResources: input.cwd
      ? boot.skillResources
      : workspaceSkills(boot.skillResources, async (root) => {
          const scoped = createSkillCandidateRegistry({ barrier: input.createBarrier() })
          scoped.shareRuntimeFrom(registry)
          const scan = await scanSkills(
            root,
            input.env.AGNES_PACKAGE_SKILL_SNAPSHOT,
            input.env.AGNES_RESOURCE_SKILL_LKG_DIR,
            input.env.HOME ?? input.env.USERPROFILE ?? homedir(),
            input.agnesHomeDir,
          )
          for (const item of scan.roots) {
            if (item.rootKey === 'package') scoped.replacePackage(item.candidates)
            else scoped.replaceRoot(item.rootKey, item.candidates)
          }
          for (const failed of scan.failedRoots) scoped.failRoot(failed, new Error('Skill scan failed'))
          scoped.setControl(skillControl as never)
          await scoped.activate('session-workspace-skills', async () => undefined)
          return scoped.snapshot()
        }),
    skills: boot.skillActual,
    mcp: boot.mcpActual,
    mcpEntries: Object.freeze([...(raw.mcp as McpManagedInput[])]),
    revision: digest(snapshotText),
    discovery: {
      candidates: boot.skillActual.map((descriptor) => ({
        descriptor,
        capabilityHash:
          capabilities.get(descriptor.resourceId) ??
          (() => {
            throw new Error('worker skill observation lacks discovery capability hash')
          })(),
      })),
      failedRoots: scanned.failedRoots,
      skippedResourceIds: scanned.skippedResourceIds,
      roots: scanned.rootStatuses,
    },
    runtime,
    reportMcpStatus(listener) {
      reportMcpStatus = listener
    },
  }
}

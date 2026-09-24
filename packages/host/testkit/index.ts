import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import {
  ecosystem as BASE_ECOSYSTEM,
  isolatedEcosystem as BASE_ISOLATED_ECOSYSTEM,
  operations as BASE_OPERATIONS,
  buildCompactionPlan,
} from '@agnes/base'
import type {
  ApprovalRequest,
  Provider,
  SandboxSeam,
  SeamImplementations,
  SeamWorkspace,
  Verdict,
} from '@agnes/core'
import { scanAll } from '@agnes/core'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import type { CapabilityLevel, PlatformBackend } from '../src/adapters/platform.js'
import { createPlatform } from '../src/adapters/platform.js'
import { MemoryPackageLoader, type PackageModule } from '../src/assemble/packages.js'
import type { ProviderBuildOptions } from '../src/assemble/provider.js'
import { ASSEMBLY_STEPS, type AssemblyStep } from '../src/assemble.js'
import { type AuditEvent, type AuditSink, createMemoryAudit } from '../src/audit.js'
import { createHost, type Host, type HostOptions, type HostSession } from '../src/host.js'
import type { PresetDoc } from '../src/presets/types.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { LockState, ProfileInputs, ResolvedProfile } from '../src/profile/types.js'
import type { SkillRuntimeInput } from '../src/resources/skills.js'
import type { SessionRecovery } from '../src/session.js'
import type { TrajectoryResolver } from '../src/trajectory-network.js'
import { attachTestSeamPlugins } from './cordis-seams.js'

export { attachTestSeamPlugins } from './cordis-seams.js'
export { ASSEMBLY_STEPS, type AssemblyStep }

const ROUTE: RouteDecl = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [
    {
      id: 'm1',
      name: 'm1',
      api: 'openai-completions',
      route: 'gw',
      baseUrl: 'http://127.0.0.1:1/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      toolCallFormats: ['native'],
      thinkingReplay: 'native',
      contract_id: null,
    },
  ],
}
const BASE_PRESET: PresetDoc = {
  name: 'base',
  tools: { core: ['read', 'write', 'edit', 'shell', 'grep', 'find', 'ls', 'todo'], timeout_ms: 120000 },
  approval: { on_unavailable: 'deny', timeout_ms: 60000, pending_ttl_ms: 86400000, command_policy: [] },
  budget: { preflight: 'estimate', per_request_cap: null, on_exceed: 'quote', max_steps: 50 },
  // Ordinary Host/CLI/Daemon fixtures stay uncapped, matching production base.yaml.
  // Subagent Host cases pass `treeBudgetCredits` so admission is explicit.
  subagent: {
    max_depth: 1,
    max_fan_out: 4,
    isolation: 'worktree',
    budget_inherit: 'aggregate',
  },
}

function scriptedModels(profile: ResolvedProfile): ModelRecord[] {
  const listed: ModelRecord[] = []
  for (const route of profile.provider.routes ?? []) {
    if (route.models) listed.push(...route.models)
  }
  return listed.length > 0 ? listed : (ROUTE.models ?? [])
}
const STANDARD_PRESET: PresetDoc = {
  name: 'standard',
  extends: 'base',
  disclosure: 'standard',
  model: { route: { primary: 'default' } },
}
const log = { debug() {}, info() {}, warn() {}, error() {} }
const SEAM_KEYS = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'harness',
] as const

// A backend built from the fields it needs, not spread from a real one: spreading copies methods
// that close over the original instance's private capability table, so which of them the overrides
// actually replace depends on details of the original that nothing here controls.
function fakePlatform(caps: Record<string, CapabilityLevel['level']>): PlatformBackend {
  const real = createPlatform()
  const level = (id: string): CapabilityLevel => ({
    level: caps[id] ?? 'full',
    scope: [],
    ...(caps[id] === 'unavailable' ? { reason: 'test' } : {}),
  })
  return {
    os: real.os,
    matches: () => true,
    shell: real.shell,
    fs: () => real.fs(),
    terminal: () => ({ color: false }),
    async probe() {},
    recordSandboxBackend() {},
    killTree() {},
    capability: level,
    snapshot: () => ({ os: real.os, arch: 'x64', capabilities: caps }),
  }
}

export type TestHostOptions = {
  /** Opt out of the production publisher view in tests that deliberately exercise raw Kernel ports. */
  currentRuntime?: import('@agnes/core').KernelOptions['currentRuntime']
  serviceAuthority?: import('../src/ext-host/service-invocation.js').ServiceAuthority
  dataDir: string
  /** Builtin template loaded by the real resolver; omitted uses local-dev. */
  template?: string
  /** Exact lock state; omitted supplies the test packages, never merged into an explicit lock. */
  lock?: LockState
  /** Real resolver layers. Explicit user fields override fixture conveniences; other layers retain resolver semantics. */
  profileInputs?: Omit<ProfileInputs, 'builtin' | 'lock'>
  /** Actual disk artifact configuration, validated before any provider factory. */
  contract?: NonNullable<ResolvedProfile['provider']['contract']>
  presets?: Record<string, PresetDoc>
  /** Explicit tree cap for subagent Host cases. Omitted keeps the ordinary fixture uncapped. */
  treeBudgetCredits?: number
  allowed?: string[]
  platformCaps?: Record<string, CapabilityLevel['level']>
  platform?: PlatformBackend
  seams?: Parameters<typeof fakeSeams>[0]
  /**
   * The model this host runs on. A function is handed the resolved profile and the pair host
   * resolved for the model layer - its logger and the deployment's credit rate - which is the only
   * way a case can assert on a number that travelled the delivery path rather than one it set
   * itself. A plain Provider is the same thing with those arguments ignored.
   */
  provider?: Provider | ((p: ResolvedProfile, o: ProviderBuildOptions) => Provider)
  /** Profile `limits` this host resolves with, e.g. the deployment's `cost.credits_per_usd`. */
  limits?: Record<string, number>
  script?: ConstructorParameters<typeof ScriptedProvider>[0]['scripts']
  // One argument, matching ApprovalSeam.ask. The brief wrote `(req, opts)`; core's seam takes the
  // request alone and carries the deadline on the request, so a two-argument override would have
  // been handed an undefined it then had to guess about.
  approval?: (req: ApprovalRequest) => Promise<Verdict>
  // Whoever is connected, from the assembly's point of view. It reaches a seam through
  // SeamAdapters.prompter, so it means nothing to the faked approval seam above - that one answers
  // on its own - and everything to a case that installs a real one. Without it, a real approval
  // seam runs with nobody connected, which is a different question from the one most cases ask.
  prompter?: (req: ApprovalRequest, opts: { signal: AbortSignal }) => Promise<Verdict>
  crashAt?: string
  closeTimeoutMs?: number
  hangSessionClose?: boolean
  env?: NodeJS.ProcessEnv
  trajectoryFetch?: typeof fetch
  trajectoryResolver?: TrajectoryResolver
  /** Private daemon-owned Skill view, for asserting the production Host request path. */
  mcpManage?: HostOptions['mcpManage']
  pluginManage?: HostOptions['pluginManage']
  skillResources?: SkillRuntimeInput
  // A seam with a close(), so a test can watch the teardown run instead of reading an audit line
  // that claims it did. It lands on the rollback stack like every other seam close.
  onSeamClose?: () => void
  fileAudit?: boolean
  // Where a package's files actually are. Only needed when the case is about something host reads
  // off disk - the bundled extensions a package declares - since the loader above is in memory.
  packageDirs?: Record<string, string>
  // Installed third-party snapshots a later runtime target may name, and the importer that serves them.
  runtimePluginCatalogue?: HostOptions['runtimePluginCatalogue']
  // Installed snapshots re-read before every target, the way a worker supplies them in production.
  runtimePluginSources?: HostOptions['runtimePluginSources']
  ordinaryStartTimeoutMs?: HostOptions['ordinaryStartTimeoutMs']
  extensionLoader?: HostOptions['extensionLoader']
  // Per-extension isolation policy and the services that stand in for the sandbox runtime.
  extensionIsolation?: HostOptions['extensionIsolation']
  extensionIsolationServices?: HostOptions['extensionIsolationServices']
  // Per-package overlays onto the modules the memory loader serves. The default @agnes/code module
  // carries an empty operations table, so a case about anything a package contributes to a request -
  // the assembled system prompt above all - has to hand the real table in, and until this option
  // existed there was no way to. Keyed by package id; an overlay replaces only the fields it names,
  // and the id is not overridable because the loader is keyed by it.
  packages?: Record<string, Omit<Partial<PackageModule>, 'id'>>
  /** Forwarded to `createHost` — see its own doc comment for why a case would set this. */
  disableSessionTitle?: boolean
}

export type TestHost = {
  host: Host
  audit: AuditSink & { events: AuditEvent[] }
  profile: ResolvedProfile
}

export async function createTestHost(o: TestHostOptions): Promise<TestHost> {
  const seamsImpl: SeamImplementations = fakeSeams(o.seams ?? {})
  // fakeSeams' sandbox reports workspaceRoot '/w'. core checks a tool's paths against that, not
  // against the FsOps host fenced at its own workspaceRoot, so a test host whose sandbox kept the
  // fake value would refuse every tool read for a reason no test is about.
  const configuredSandbox = o.seams?.sandbox
  // Keep the test seam's deterministic exec behavior after fitting it to a real workspace. Using
  // workspace.exec here would launch commands on the developer machine and turn replay fixtures
  // into environment tests; production fitting is exercised by the dedicated workspace suites.
  const testSandboxExec = seamsImpl.sandbox.exec.bind(seamsImpl.sandbox)
  const forWorkspace = async (workspace: SeamWorkspace): Promise<SandboxSeam> => {
    const backend = await workspace.readiness.ready(workspace.signal)
    const fitted: SandboxSeam = {
      forWorkspace,
      exec: (cmd, opts) => testSandboxExec(cmd, opts),
      confine: async (argv) => [...(await backend.confine({ argv, cwd: workspace.root }))],
      fsPolicy: () => workspace.policy,
      enforcement: configuredSandbox?.enforcement
        ? () => configuredSandbox.enforcement?.() ?? workspace.enforcement
        : () => ({
            level: workspace.enforcement.level,
            scope: [...workspace.enforcement.scope],
          }),
    }
    return Object.freeze(fitted)
  }
  seamsImpl.sandbox = {
    ...seamsImpl.sandbox,
    forWorkspace,
    ...(!configuredSandbox && {
      // The canonical root, resolved lazily: dataDir may not exist until the adapters open, and
      // the bound fence compares canonical spellings, so the policy must name the real one.
      fsPolicy: () => {
        const policy = testFsPolicy('/workspace')
        const workspaceRoot = realpathSync(o.dataDir)
        const rules = policy.rules.map((rule) => ({
          ...rule,
          path: join(workspaceRoot, ...rule.path.slice(policy.workspaceRoot.length).split('/')),
        }))
        const content = { ...policy, workspaceRoot, rules }
        return { ...content, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
      },
    }),
  }
  const approval = o.approval
  if (approval) seamsImpl.approval = { ...seamsImpl.approval, ask: (req) => approval(req) }
  const prompter = o.prompter ?? (async () => 'unavailable' as Verdict)
  if (o.onSeamClose)
    seamsImpl.harness = { ...seamsImpl.harness, close: o.onSeamClose } as SeamImplementations['harness']
  const base: PackageModule = {
    id: '@agnes/base',
    sandboxWorkspaceProbe: async () => ({
      name: 'bwrap',
      execBackend: 'l1',
      enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
      degraded: false,
      confine: ({ argv }) => argv,
    }),
    seams: Object.fromEntries(SEAM_KEYS.map((n) => [n, async () => seamsImpl[n]])),
    operations: BASE_OPERATIONS,
    presets: {
      base:
        o.treeBudgetCredits === undefined
          ? BASE_PRESET
          : {
              ...BASE_PRESET,
              subagent: { ...(BASE_PRESET.subagent ?? {}), tree_budget_credits: o.treeBudgetCredits },
            },
    },
    ecosystem: BASE_ECOSYSTEM,
    isolatedEcosystem: BASE_ISOLATED_ECOSYSTEM,
    buildCompactionPlan,
  }
  const code: PackageModule = {
    id: '@agnes/code',
    operations: {},
    presets: { standard: STANDARD_PRESET, ...(o.presets ?? {}) },
  }
  const ids = ['@agnes/ai', '@agnes/base', '@agnes/code']
  const packages = Object.fromEntries(
    ids.map((id) => [
      id,
      { version: '0.1.0', integrity: 'sha512-fixture', trust: 'builtin' as const, enabled: true },
    ]),
  )
  const template = o.template ?? 'local-dev'
  const profile = await resolveProfile(
    {
      ...o.profileInputs,
      builtin: template,
      lock: o.lock ?? { packages },
      user: {
        name: template,
        ...(o.allowed ? { presets: { allowed: o.allowed } } : {}),
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
        ...(o.limits ? { limits: o.limits } : {}),
        ...o.profileInputs?.user,
        ...(o.contract !== undefined
          ? {
              provider: {
                ...(o.profileInputs?.user?.provider ?? {
                  package: '@agnes/ai',
                  adapters: ['@agnes/ai'],
                  routes: [ROUTE],
                }),
                contract: o.contract,
              },
            }
          : {}),
      },
    },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: new Date().toISOString(),
    },
  )
  const audit = createMemoryAudit()
  const modules: Record<string, PackageModule> = {
    '@agnes/base': base,
    '@agnes/code': code,
    '@agnes/ai': { id: '@agnes/ai' },
  }
  for (const [id, over] of Object.entries(o.packages ?? {})) {
    // An overlay for an id the profile does not name would be loaded by nobody and would look like
    // it had been applied, so it is refused here rather than ignored.
    if (!modules[id]) throw new Error(`packages overlay names ${id}, which this test host does not load`)
    // `seams` merges by seam name rather than replacing the whole map. A case that wants one real
    // seam factory in an otherwise faked assembly would otherwise have to restate the other eight,
    // and a restated fake is one that drifts from the one every other case runs against.
    const seams = over.seams ? { ...modules[id]?.seams, ...over.seams } : modules[id]?.seams
    modules[id] = { ...(modules[id] as PackageModule), ...over, ...(seams ? { seams } : {}), id }
  }
  for (const module of Object.values(modules)) if (module.seams) attachTestSeamPlugins(module)
  const loader = new MemoryPackageLoader(modules)
  const host = await createHost(profile, {
    dataDir: o.dataDir,
    packageDirs: new Map(ids.map((id) => [id, o.packageDirs?.[id] ?? o.dataDir])),
    profileDir: `${o.dataDir}/profiles/${template}`,
    workspaceRoot: o.dataDir,
    homeDir: o.dataDir,
    hostRoot: process.cwd(),
    loader,
    log,
    platform: o.platform ?? fakePlatform(o.platformCaps ?? {}),
    agnesVersion: '0.1.0',
    env: o.env ?? { ...process.env },
    ...(o.serviceAuthority ? { serviceAuthority: o.serviceAuthority } : {}),
    ...(o.runtimePluginCatalogue ? { runtimePluginCatalogue: o.runtimePluginCatalogue } : {}),
    ...(o.runtimePluginSources ? { runtimePluginSources: o.runtimePluginSources } : {}),
    ...(o.ordinaryStartTimeoutMs === undefined ? {} : { ordinaryStartTimeoutMs: o.ordinaryStartTimeoutMs }),
    ...(o.extensionLoader ? { extensionLoader: o.extensionLoader } : {}),
    ...(o.extensionIsolation ? { extensionIsolation: o.extensionIsolation } : {}),
    ...(o.pluginManage ? { pluginManage: o.pluginManage } : {}),
    ...(o.mcpManage ? { mcpManage: o.mcpManage } : {}),
    ...(o.extensionIsolationServices ? { extensionIsolationServices: o.extensionIsolationServices } : {}),
    ...(o.skillResources ? { skillResources: o.skillResources } : {}),
    ...(o.trajectoryFetch ? { trajectoryFetch: o.trajectoryFetch } : {}),
    ...(o.trajectoryResolver ? { trajectoryResolver: o.trajectoryResolver } : {}),
    ...(o.disableSessionTitle ? { disableSessionTitle: true } : {}),
    ...(o.currentRuntime ? { currentRuntime: o.currentRuntime } : {}),
    // Omission exercises production buildProvider. A script explicitly requests the test model.
    ...(o.provider !== undefined || o.script !== undefined
      ? {
          providerFactory: (p: ResolvedProfile, built: ProviderBuildOptions) =>
            typeof o.provider === 'function'
              ? o.provider(p, built)
              : (o.provider ??
                new ScriptedProvider({
                  scripts: o.script ?? [],
                  ...(o.treeBudgetCredits !== undefined ? { models: scriptedModels(p) } : {}),
                })),
        }
      : {}),
    ...(o.prompter
      ? { prompter: { ask: (req: ApprovalRequest, opts: { signal: AbortSignal }) => prompter(req, opts) } }
      : {}),
    ...(o.fileAudit ? {} : { audit }),
    ...(o.crashAt ? { crashAt: o.crashAt } : {}),
    ...(o.closeTimeoutMs !== undefined ? { closeTimeoutMs: o.closeTimeoutMs } : {}),
  })
  if (!o.hangSessionClose) return { host, audit, profile }
  // The one thing a test cannot build from outside core: a session whose close() never settles,
  // which is what the forced-close path is about. close() is replaced on the instance rather than by
  // spreading it into a new object - a spread of a class instance keeps only its own properties and
  // drops every prototype method, handing the test a session that is broken in ways the case is not
  // about.
  const openWorkspaceSession = host.createSession.bind(host)
  const wrapped: Host = {
    ...host,
    createSession: async (opts) => {
      const s = await openWorkspaceSession(opts)
      ;(s as { close: () => Promise<void> }).close = () => new Promise<void>(() => {})
      return s
    },
  }
  return { host: wrapped, audit, profile }
}

/**
 * Runs one assembly per step and says, for each, whether the injected crash was the error that came
 * back. Three outcomes, not two: the old two-way split reported any error whose message lacked
 * `crash:<step>` as 'leaked', so a rollback bug and an import error were the same row in the report
 * the test asserts on.
 */
export async function crashAtEveryStep(
  run: (crashAt: string) => Promise<unknown>,
): Promise<Record<string, 'rolled-back' | 'leaked' | 'wrong-error'>> {
  const out: Record<string, 'rolled-back' | 'leaked' | 'wrong-error'> = {}
  for (const step of ASSEMBLY_STEPS) {
    try {
      await run(step)
      out[step] = 'leaked'
    } catch (e) {
      out[step] = e instanceof Error && e.message.includes(`crash:${step}`) ? 'rolled-back' : 'wrong-error'
    }
  }
  return out
}

/**
 * What one turn did, read back from the ledger rather than from the reply. The reply carries a stop
 * reason and nothing else; the tool names and the answer text are rows, and rows are what a fixture
 * can be written against.
 */
export type RunOnceResult = {
  reason: string
  /** Every tool the model called, in the order the kernel recorded them. */
  toolCalls: string[]
  /** The text half of the last assistant message. Thinking blocks are not the answer. */
  finalText: string
  events: Array<{ seq: number; type: string; data: unknown }>
}

/**
 * One prompt, one turn, one reading of what happened - against a host that was really assembled.
 *
 * It exists because there was no way to say "run this prompt and tell me what the system did"
 * without reimplementing daemon's session/prompt in every test that wanted it, and a test that
 * reimplements the driver can pass while the driver is broken. The order is daemon's: enqueue, run
 * to turn end, then scan, because the ledger is the only place the tool calls and the answer both
 * appear.
 */
export async function runOnce(host: Host, o: { prompt: string; cwd: string }): Promise<RunOnceResult> {
  const session = await host.createSession({ cwd: o.cwd })
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: o.prompt }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  return readTurn(session, await session.run({ until: 'turn-end', signal: new AbortController().signal }))
}

/**
 * Enqueues a prompt and leaves the turn running, handing back the session and a promise nobody has
 * to wait for. It is how a test stages a process that dies mid-turn: the caller closes the host
 * while the model is still out, and what stays on disk is what a kill leaves behind.
 */
export async function startTurn(
  host: Host,
  o: { prompt: string; cwd: string },
): Promise<{ session: HostSession; running: Promise<unknown> }> {
  const session = await host.createSession({ cwd: o.cwd })
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: o.prompt }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  const running = session
    .run({ until: 'turn-end', signal: new AbortController().signal })
    .catch(() => undefined)
  return { session, running }
}

/**
 * Picks a session back up on a ledger a previous process left open and carries its turn to the end.
 * The session is opened from the same host options and the same cwd, so it resolves the same key -
 * which is the only thing tying the second process to the first one's work.
 *
 * Nothing here asks for a recovery. Opening the session is the whole of it, and what recovery did is
 * read from the report the open handed back - so a case run through this driver goes red if that
 * wiring is cut, which is exactly what it could not do while the driver called `resume()` itself.
 */
export async function resumeTurn(
  host: Host,
  o: { cwd: string },
): Promise<RunOnceResult & { resumed: string }> {
  const seen: SessionRecovery[] = []
  const session = await host.createSession({
    cwd: o.cwd,
    onRecovered: (r) => {
      seen.push(r)
    },
  })
  const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
  return { ...(await readTurn(session, out)), resumed: recoveredActions(seen) }
}

const recoveredActions = (seen: SessionRecovery[]): string =>
  seen.flatMap((r) => r.actions.map((a) => a.action)).join(',')

/**
 * Opens a session on a ledger whose turn finished, and reports what that cost. `sealedAt` is the seq
 * the previous host left behind, so `appendedOnOpen` is the number of rows opening the session added
 * to a ledger that needed nothing - the measure of whether recovery-on-open stayed a read.
 */
export async function reopenSession(
  host: Host,
  o: { cwd: string; sealedAt: number },
): Promise<RunOnceResult & { resumed: string; appendedOnOpen: number }> {
  const seen: SessionRecovery[] = []
  const session = await host.createSession({
    cwd: o.cwd,
    onRecovered: (r) => {
      seen.push(r)
    },
  })
  const appendedOnOpen = session.lastSeq - o.sealedAt
  // Read off the ledger rather than from a run: nothing is run here, and the turn this session was
  // opened on top of ended before the previous host closed.
  const [ended] = await session.scan({
    fromSeq: 1,
    toSeq: session.lastSeq,
    type: 'turn/end',
    order: 'desc',
    limit: 1,
  })
  const reason = (ended?.data as { reason?: unknown } | null | undefined)?.reason
  return {
    ...(await readTurn(session, {
      reason: typeof reason === 'string' ? reason : 'none',
      lastSeq: session.lastSeq,
    })),
    resumed: recoveredActions(seen),
    appendedOnOpen,
  }
}

/** The ledger reading both drivers share: what a fixture is written against. */
async function readTurn(
  session: HostSession,
  out: { reason: string; lastSeq: number },
): Promise<RunOnceResult> {
  const events = (await scanAll((q) => session.scan(q), {
    fromSeq: 1,
    toSeq: out.lastSeq,
  })) as RunOnceResult['events']
  const toolCalls: string[] = []
  let finalText = ''
  for (const e of events) {
    if (e.type === 'tool/call') {
      const name = (e.data as { name?: unknown } | null)?.name
      if (typeof name === 'string') toolCalls.push(name)
    }
    if (e.type === 'assistant/message') {
      const content = (e.data as { content?: Array<{ type: string; text?: string }> } | null)?.content ?? []
      finalText = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    }
  }
  return { reason: out.reason, toolCalls, finalText, events }
}

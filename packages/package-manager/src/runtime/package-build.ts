import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import { validateRuntime, type RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import {
  type AcquiredPackage,
  inspectLockedPackage,
  type PackageBuildPlan,
  type PackageInspection,
} from './package-inspect.js'
import { digestJson, type PackageOutcome, readPackageTree, refuse } from './source-snapshot.js'

type Ownership = 'cooperative' | 'strong'
type Operation = 'approval' | 'create' | 'exec' | 'stop'

class BuildRefusal extends Error {
  constructor(
    readonly detailCode: string,
    readonly code: W['RuntimeError']['code'] = 'denied',
  ) {
    super(detailCode)
  }
}

/** Caller-owned, exclusively allocated build workspace. dispose releases the mount and removes
 * all staging bytes after draining its dedicated services, including on an uncertain stop. */
export interface PackageBuildWorkspace {
  readonly root: string
  readonly request: W['SandboxCreateRequest']
  readonly sandbox: {
    readonly binding: W['BindingRef']
    readonly features: readonly string[]
    create(input: W['SandboxCreateRequest'], context: CallContext): Promise<Outcome<W['SandboxCreateResult']>>
    stop(input: W['SandboxStopRequest'], context: CallContext): Promise<Outcome<W['SandboxStopResult']>>
  }
  readonly exec: {
    readonly binding: W['BindingRef']
    readonly features: readonly string[]
    run(input: W['ExecRequest'], context: CallContext): Promise<Outcome<W['ExecResult']>>
  }
  /** Supplies distinct authenticated invocation identities; stop must remain callable after cancel. */
  call(operation: Operation, signal?: AbortSignal): CallContext
  dispose(): Promise<void>
}

export interface PackageBuildInput {
  readonly plan: PackageBuildPlan
  readonly lock: W['PackageLockEntry']
  readonly limits: W['ResourceLimits']
  /** Cooperative ownership must be an explicit caller choice; it does not contain all hostile forks. */
  readonly minimumOwnership: Ownership
  readonly acquire: (signal?: AbortSignal) => Promise<PackageOutcome<AcquiredPackage>>
  /** Trusted current deployment approval reader, bound to the complete execution fingerprint.
   * Missing approval integration refuses execution. A session tool grant is insufficient. */
  readonly authorize?: (approvalDigest: string, context: CallContext) => Promise<boolean>
  readonly openWorkspace: (attempt: number, signal?: AbortSignal) => Promise<PackageBuildWorkspace>
  readonly signal?: AbortSignal
}

export interface PackageBuildIdentity {
  readonly packageDigest: string
  readonly manifestDigest: string
  readonly archiveIntegrity: string
}
export interface PackageBuildAudit {
  readonly sandbox: W['SandboxCreateResult']
  readonly execution: W['ExecResult']
}
export interface PackageBuildResult {
  readonly inspection: PackageInspection
  readonly archive: Buffer
  readonly approvalDigest: string
  readonly ownership: Ownership
  readonly audit: readonly [PackageBuildAudit, PackageBuildAudit]
  readonly reproducibility: {
    readonly verified: true
    readonly attempts: readonly [PackageBuildIdentity, PackageBuildIdentity]
  }
}

const fail = (detailCode: string, code: W['RuntimeError']['code'] = 'denied'): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Package build refused',
    diagnosticId: 'package-build',
    retryAdvice: { kind: 'never' },
  },
})
const same = (a: unknown, b: unknown): boolean => digestJson(a) === digestJson(b)
function executionFailed(value: W['ExecResult']): Outcome<never> {
  const outcome = fail('build_execution_failed')
  if (outcome.ok) return outcome
  return {
    ok: false,
    error: {
      ...outcome.error,
      safeDetail: {
        executionRef: value.executionRef,
        state: value.state,
        exitCode: value.exitCode,
        signal: value.signal,
        stdoutRef: value.stdoutRef,
        stderrRef: value.stderrRef,
      },
    },
  }
}
const inspectionFailure = (outcome: ReturnType<typeof refuse>): Outcome<never> =>
  fail(outcome.detailCode, outcome.code)

/** Local composition: binds approved inspect identity, resource ceilings, shell and output convention.
 * Does not extend the inspect plan or claim to implement the deployment approval service. */
export function packageBuildApprovalDigest(
  plan: PackageBuildPlan,
  limits: W['ResourceLimits'],
  minimumOwnership: Ownership,
): string {
  return digestJson({
    planDigest: plan.digest,
    limits,
    minimumOwnership,
    shell: '/bin/sh',
    source: ['source', 'source.archive'],
    output: 'artifact.tar',
    attempts: 2,
  })
}

function qualify(
  workspace: PackageBuildWorkspace,
  plan: PackageBuildPlan,
  limits: W['ResourceLimits'],
  ownership: Ownership,
): Outcome<never> | null {
  const s = workspace.sandbox,
    e = workspace.exec,
    request = workspace.request
  if (
    s.binding.contract !== 'agh.sandbox' ||
    e.binding.contract !== 'agh.exec' ||
    !['create', 'stop', 'closed-network', 'live-mount', 'seatbelt'].every((feature) =>
      s.features.includes(feature),
    ) ||
    !['run', 'owner-pipe', 'lifeline', ...Object.keys(limits)].every((feature) =>
      e.features.includes(feature),
    )
  )
    return fail('build_mechanism_unqualified', 'incompatible')
  // The delivered service advertises only cooperative ownership. Never infer strong ownership
  // from isolated-process, a PID, or the Linux native governor's separate cgroup CI evidence.
  if (ownership !== 'cooperative' || !e.features.includes('cooperative-ownership'))
    return fail('build_ownership_unqualified', 'incompatible')
  if (
    !validateRuntime('SandboxCreateRequest', request).ok ||
    request.mode !== 'isolated-process' ||
    !same(request.resourceLimits, limits)
  )
    return fail('build_sandbox_request')
  const policy = request.filesystemPolicy
  const { digest, ...body } = policy
  if (digestJson(body) !== digest) return fail('build_filesystem_policy')
  const step = plan.steps[0]
  // The qualified backend accepts complete four-operation rules only. Narrower permissions require
  // a qualified backend rather than silently broadening the source declaration.
  if (
    !step ||
    !same(step.readPaths, ['./']) ||
    !same(step.writePaths, ['./']) ||
    policy.rules.some((rule) => rule.effect === 'allow' && (rule.root !== 'workspace' || rule.path !== ''))
  )
    return fail('build_filesystem_unqualified', 'incompatible')
  if (
    !policy.rules.some(
      (rule) =>
        rule.root === 'workspace' &&
        rule.path === '' &&
        rule.effect === 'allow' &&
        ['read', 'write', 'stat', 'list'].every((access) => rule.access.includes(access as 'read')),
    )
  )
    return fail('build_filesystem_policy')
  return null
}

function checkProof(
  workspace: PackageBuildWorkspace,
  created: W['SandboxCreateResult'],
): Outcome<never> | null {
  if (!validateRuntime('SandboxCreateResult', created).ok) return fail('build_sandbox_proof')
  const proof = created.filesystemProof,
    { digest, ...body } = proof
  const floor = [
    ['workspace', '.git'],
    ...WORKSPACE_SECRET_DIRS.map((path) => ['workspace', path]),
    ['home', '.ssh'],
    ['data', 'secrets'],
  ]
  if (
    created.achievedIsolation !== 'isolated-process' ||
    !same(created.limits, workspace.request.resourceLimits) ||
    !same(created.sandboxRef.ownerBinding, workspace.sandbox.binding) ||
    !same(proof.provider, workspace.sandbox.binding) ||
    digestJson(body) !== digest ||
    proof.policyDigest !== workspace.request.filesystemPolicy.digest ||
    !same(proof.workspaceRoot.mount, workspace.request.workspaceRef) ||
    !same(proof.scope, workspace.request.filesystemPolicy.scope) ||
    proof.workspaceRoot.policyDecision !== 'allow' ||
    !proof.workspaceRoot.exists ||
    proof.authorityEpoch !== workspace.request.workspaceRef.lease.epoch ||
    floor.some(
      ([root, path]) =>
        !proof.probes.some(
          (probe) =>
            probe.root === root &&
            probe.path === path &&
            probe.decision === 'denied' &&
            probe.evidenceCode === 'E_FS_DENIED',
        ),
    )
  )
    return fail('build_sandbox_proof')
  return null
}

function artifact(root: string): Buffer {
  const path = join(root, 'artifact.tar')
  try {
    if (!lstatSync(path).isFile()) throw new BuildRefusal('build_artifact_invalid')
  } catch (error) {
    if (error instanceof BuildRefusal) throw error
    throw new BuildRefusal('build_artifact_missing')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new BuildRefusal('build_artifact_invalid')
    const bytes = readFileSync(fd)
    if (bytes.length !== stat.size) throw new BuildRefusal('build_artifact_invalid')
    return bytes
  } finally {
    closeSync(fd)
  }
}

type BuiltPackage = {
  inspection: PackageInspection
  archive: Buffer
  identity: PackageBuildIdentity
  audit: PackageBuildAudit
}

async function stageSource(
  workspace: PackageBuildWorkspace,
  source: AcquiredPackage,
  input: PackageBuildInput,
  plan: PackageBuildPlan,
): Promise<void> {
  if ('archive' in source.content) {
    writeFileSync(join(workspace.root, 'source.archive'), source.content.archive, { flag: 'wx', mode: 0o600 })
    return
  }
  const tree = readPackageTree(source.content.root)
  if (!tree.ok) throw new BuildRefusal(tree.detailCode, tree.code)
  const root = join(workspace.root, 'source')
  mkdirSync(root, { mode: 0o700 })
  for (const file of tree.value) {
    const target = join(root, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, file.bytes, { flag: 'wx', mode: file.mode === 'executable' ? 0o700 : 0o600 })
  }
  const staged = await inspectLockedPackage({
    lock: input.lock,
    ...(input.signal ? { signal: input.signal } : {}),
    acquire: async () => ({ ok: true, value: { ...source, content: { root } } }),
  })
  if (!staged.ok) throw new BuildRefusal(staged.detailCode, staged.code)
  if (!same(staged.value.buildPlan, plan)) throw new BuildRefusal('build_plan_changed')
}

async function runBuildAttempt(
  workspace: PackageBuildWorkspace,
  input: PackageBuildInput,
  source: AcquiredPackage,
  approvalDigest: string,
  rememberSandbox: (ref: W['SandboxRef'] | undefined) => void,
): Promise<Outcome<BuiltPackage>> {
  if (!lstatSync(workspace.root).isDirectory() || realpathSync(workspace.root) !== workspace.root)
    throw new BuildRefusal('build_workspace_invalid')
  for (const name of ['source', 'source.archive', 'artifact.tar']) {
    try {
      lstatSync(join(workspace.root, name))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    throw new BuildRefusal('build_workspace_not_empty')
  }
  const refused = qualify(workspace, input.plan, input.limits, input.minimumOwnership)
  if (refused) return refused
  if (!(await input.authorize?.(approvalDigest, workspace.call('approval', input.signal))))
    return fail('build_unapproved')
  await stageSource(workspace, source, input, input.plan)
  const created = await workspace.sandbox.create(workspace.request, workspace.call('create', input.signal))
  if (!created.ok) return created
  const sandboxRef = created.value.sandboxRef
  rememberSandbox(sandboxRef)
  const proofRefusal = checkProof(workspace, created.value)
  if (proofRefusal) return proofRefusal
  if (input.signal?.aborted) return fail('build_cancelled', 'cancelled')
  if (!(await input.authorize?.(approvalDigest, workspace.call('approval', input.signal))))
    return fail('build_unapproved')
  const step = input.plan.steps[0]
  if (!step) return fail('build_plan_changed')
  const executed = await workspace.exec.run(
    {
      sandboxRef,
      argv: ['/bin/sh', '-eu', '-c', step.script],
      cwd: { mount: workspace.request.workspaceRef, path: '' },
      env: [],
      stdinRef: null,
      limits: input.limits,
    },
    workspace.call('exec', input.signal),
  )
  if (!executed.ok) return executed
  if (!validateRuntime('ExecResult', executed.value).ok) return fail('build_execution_proof')
  if (
    executed.value.state !== 'exited' ||
    executed.value.exitCode !== 0 ||
    executed.value.signal !== null ||
    executed.value.outputTruncated ||
    executed.value.effectStatus !== 'confirmed'
  )
    return executionFailed(executed.value)
  const stopped = await workspace.sandbox.stop(
    { sandboxRef, reason: 'Build complete; verify drained artifact' },
    workspace.call('stop'),
  )
  if (
    !stopped.ok ||
    !validateRuntime('SandboxStopResult', stopped.value).ok ||
    stopped.value.effectStatus !== 'confirmed'
  )
    return fail('build_cleanup_unknown', 'unknown_effect')
  rememberSandbox(undefined)
  if (input.signal?.aborted) return fail('build_cancelled', 'cancelled')
  const archive = artifact(workspace.root)
  const inspected = await inspectLockedPackage({
    lock: input.lock,
    ...(input.signal ? { signal: input.signal } : {}),
    acquire: async () => ({ ok: true, value: { locator: source.locator, content: { archive } } }),
  })
  if (!inspected.ok) return inspectionFailure(inspected)
  const archiveIntegrity = inspected.value.archiveIntegrity
  if (!archiveIntegrity) return fail('archive_integrity_missing')
  return {
    ok: true,
    value: {
      inspection: inspected.value,
      archive,
      audit: { sandbox: created.value, execution: executed.value },
      identity: {
        packageDigest: inspected.value.packageDigest,
        manifestDigest: inspected.value.manifestDigest,
        archiveIntegrity,
      },
    },
  }
}

/** Rebuilds an already inspected, locked package twice. No entry is imported, no install lifecycle
 * is invoked, and every command, limit and tree harvest belongs to the injected Sandbox/Exec services. */
export async function buildLockedPackage(request: PackageBuildInput): Promise<Outcome<PackageBuildResult>> {
  // Freeze the checked inputs across acquisition, approval and the two independent executions.
  const input = {
    ...request,
    plan: structuredClone(request.plan),
    lock: structuredClone(request.lock),
    limits: structuredClone(request.limits),
  }
  const { plan, limits, minimumOwnership } = input
  const { digest, ...body } = plan
  if (digestJson(body) !== digest || plan.status !== 'approval-required' || plan.steps.length !== 1)
    return fail('build_plan_changed')
  if (plan.steps.some((step) => (step.secretEnv?.length ?? 0) > 0))
    return fail('secret_consumer_unavailable', 'incompatible')
  if (plan.steps.some((step) => step.network.length > 0))
    return fail('build_network_unqualified', 'incompatible')
  if (!validateRuntime('ResourceLimits', limits).ok || Object.values(limits).some((value) => value <= 0))
    return fail('build_limits_invalid', 'invalid_input')
  if (minimumOwnership !== 'cooperative') return fail('build_ownership_unqualified', 'incompatible')
  if (!input.authorize) return fail('build_unapproved')
  if (input.signal?.aborted) return fail('build_cancelled', 'cancelled')
  const approvalDigest = packageBuildApprovalDigest(plan, limits, minimumOwnership)
  let acquired: AcquiredPackage | undefined
  const checked = await inspectLockedPackage({
    lock: input.lock,
    ...(input.signal ? { signal: input.signal } : {}),
    acquire: async (signal) => {
      const result = await input.acquire(signal)
      if (!result.ok) return result
      if ('archive' in result.value.content && result.value.content.archive.length > 32 * 1024 * 1024)
        return refuse('denied', 'package_too_large', 'Package build refused')
      acquired = {
        ...result.value,
        locator: structuredClone(result.value.locator),
        ...(result.value.build ? { build: structuredClone(result.value.build) } : {}),
        content:
          'archive' in result.value.content
            ? { archive: Buffer.from(result.value.content.archive) }
            : { ...result.value.content },
      }
      return { ok: true, value: acquired }
    },
  })
  if (!checked.ok) return inspectionFailure(checked)
  if (!acquired || !same(checked.value.buildPlan, plan)) return fail('build_plan_changed')
  const outputs: BuiltPackage[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    let workspace: PackageBuildWorkspace | undefined, sandboxRef: W['SandboxRef'] | undefined
    let outcome: Outcome<BuiltPackage> = fail('build_unavailable', 'internal')
    let cleanup: Outcome<never> | undefined
    try {
      if (input.signal?.aborted) return fail('build_cancelled', 'cancelled')
      workspace = await input.openWorkspace(attempt, input.signal)
      outcome = await runBuildAttempt(workspace, input, acquired, approvalDigest, (ref) => {
        sandboxRef = ref
      })
    } catch (error) {
      outcome = fail(
        input.signal?.aborted
          ? 'build_cancelled'
          : error instanceof BuildRefusal
            ? error.detailCode
            : 'build_unavailable',
        input.signal?.aborted ? 'cancelled' : error instanceof BuildRefusal ? error.code : 'internal',
      )
    } finally {
      if (workspace) {
        try {
          if (sandboxRef) {
            const stopped = await workspace.sandbox.stop(
              { sandboxRef, reason: 'Build failed or interrupted' },
              workspace.call('stop'),
            )
            if (
              !stopped.ok ||
              !validateRuntime('SandboxStopResult', stopped.value).ok ||
              stopped.value.effectStatus !== 'confirmed'
            )
              cleanup = fail('build_cleanup_unknown', 'unknown_effect')
          }
        } catch {
          cleanup = fail('build_cleanup_unknown', 'unknown_effect')
        }
        try {
          await workspace.dispose()
        } catch {
          cleanup = fail('build_cleanup_unknown', 'unknown_effect')
        }
      }
    }
    if (cleanup && !cleanup.ok)
      return {
        ok: false,
        error: {
          ...cleanup.error,
          ...(outcome.ok
            ? {}
            : {
                retryAdvice: outcome.error.retryAdvice,
                safeDetail: {
                  priorDetailCode: outcome.error.detailCode ?? null,
                  execution: outcome.error.safeDetail ?? null,
                },
              }),
        },
      }
    if (!outcome.ok) return outcome
    outputs.push(outcome.value)
  }
  const [first, second] = outputs
  if (!first || !second) return fail('build_not_reproducible')
  // Transport metadata is not part of canonical tree reproducibility. Preserve both byte identities.
  if (
    first.identity.packageDigest !== second.identity.packageDigest ||
    first.identity.manifestDigest !== second.identity.manifestDigest
  )
    return fail('build_not_reproducible')
  return {
    ok: true,
    value: {
      inspection: first.inspection,
      archive: first.archive,
      approvalDigest,
      ownership: minimumOwnership,
      audit: [first.audit, second.audit],
      reproducibility: { verified: true, attempts: [first.identity, second.identity] },
    },
  }
}

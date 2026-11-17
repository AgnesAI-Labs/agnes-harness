import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createSkillInstaller, type SkillInstallInvocation } from '@agnes/host'
import { assertSkillSourceLocation, fetchSource, selectSkillSource } from '@agnes/package-manager'
import {
  jcs,
  type ResourceControlMethodName,
  type ResourcePermission,
  rpcError,
  type SkillImportParams,
  type SkillImportResult,
} from '@agnes/protocol'
import type { ResourceControlService } from '@agnes/resource-control-store'
import { createMcpImports } from './mcp-import.js'
import type { PackageAdminAuthority } from './permissions.js'
import { skillEnvironment } from './skill-environment.js'
import { createSkillImportChecks } from './skill-import-checks.js'

type ImportPlan = {
  owner: string
  invocation: SkillInstallInvocation
  result: SkillImportResult
  expires: number
  stage: string
}
const publicInstallResult = (
  result: Awaited<ReturnType<ReturnType<typeof createSkillInstaller>['request']>>,
): SkillImportResult => {
  const { files, ...rest } = result
  return { ...rest, ...(files ? { files: [...files] } : {}) }
}

const installerResourcePermissions: Partial<Record<ResourceControlMethodName, ResourcePermission[]>> = {
  '_agnes/v1/resources.list': ['resources.read'],
  '_agnes/v1/resources.get': ['resources.read'],
  '_agnes/v1/resources.operation.get': ['resources.read'],
  '_agnes/v1/skills.refresh': ['skills.refresh', 'resources.skills.write'],
  '_agnes/v1/skills.trust.set': ['skills.trust'],
  '_agnes/v1/resources.desired.set': ['resources.skills.write'],
}

/** Management and session imports share the Host installer and resource-governance effects. */
export function createSkillImportService(options: {
  directory: string
  home: string
  profile: string
  workspace: string
  discovery: Parameters<typeof createSkillInstaller>[1]
  resources: Pick<ResourceControlService, 'call'>
  environment?: typeof skillEnvironment
  mcpEnvironment?: typeof import('./mcp-import-environment.js').mcpEnvironment
}) {
  const installer = createSkillInstaller(join(options.directory, 'receipts'), options.discovery)
  const plans = new Map<string, ImportPlan>()
  const running = new Set<string>()
  let preparing = 0
  const removeStage = (stage: string) => {
    try {
      rmSync(stage, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
  const commands = new Map<string, { payload: string; task: Promise<SkillImportResult>; expires: number }>()
  const controller = new AbortController()
  const cleanup = () => {
    checks.cleanup()
    mcps.cleanup()
    for (const [key, command] of commands) if (command.expires < Date.now()) commands.delete(key)
    for (const [id, plan] of plans) {
      if (plan.expires > Date.now() || running.has(id)) continue
      if (removeStage(plan.stage)) plans.delete(id)
    }
  }
  const timer = setInterval(cleanup, 60_000)
  timer.unref()
  const execute = async (
    params: SkillImportParams,
    granted: PackageAdminAuthority,
    checkSignal?: AbortSignal,
    progress?: (phase: string) => void,
  ): Promise<SkillImportResult> => {
    cleanup()
    controller.signal.throwIfAborted()
    if (
      params.profile !== options.profile ||
      params.clientId !== granted.clientId ||
      granted.installer === 'agent'
    )
      throw rpcError('CAPABILITY_DENIED')
    const owner = jcs([granted.principalId, params.profile, options.workspace])
    const checked = await checks.handle(params, granted, owner)
    if (checked) return checked
    if (params.action === 'check') throw rpcError('INVALID_PARAMS')
    const mcpResult = await mcps.request(params, granted, owner)
    if (mcpResult) return mcpResult
    if (
      params.action !== 'prepare' &&
      params.action !== 'commit' &&
      params.action !== 'cancel' &&
      params.action !== 'status'
    )
      throw rpcError('INVALID_PARAMS')
    const authority: Parameters<ReturnType<typeof createSkillInstaller>['request']>[1] = {
      principalId: granted.principalId,
      profile: params.profile,
      workspaceRoot: options.workspace,
      agnesHome: options.home,
      assertActive: () => controller.signal.throwIfAborted(),
      background: (task) => {
        const id = params.proposalId
        if (!id) return
        running.add(id)
        void task
          .finally(() => {
            running.delete(id)
            const plan = plans.get(id)
            if (plan) removeStage(plan.stage)
          })
          .catch(() => undefined)
      },
      // This path is a server-authorized, explicit administrative prepare/commit, not a model tool.
      ask: async () => true,
      resources: async (method, data) => {
        // Same method allowlist as the session install path; permissions are the minimum per method.
        const needed = installerResourcePermissions[method]
        if (!needed) throw rpcError('CAPABILITY_DENIED')
        // Enabling (trust, or desired state other than the install's own `disabled` record) needs
        // the caller's own trust and activation rights, matching the `enable: true` commit gate.
        if (
          (method === '_agnes/v1/skills.trust.set' ||
            (method === '_agnes/v1/resources.desired.set' && data.state !== 'disabled')) &&
          !(
            granted.permissions.includes('packages.trust') &&
            granted.permissions.includes('packages.activate')
          )
        )
          throw rpcError('CAPABILITY_DENIED')
        return options.resources.call(
          method,
          { ...data, ...('commandId' in data ? { clientId: granted.clientId } : {}) },
          {
            audience: 'admin',
            principalId: granted.principalId,
            clientId: granted.clientId,
            permissions: needed,
          },
        )
      },
    }
    if (params.action !== 'prepare') {
      if (!params.proposalId) throw rpcError('INVALID_PARAMS')
      const plan = plans.get(params.proposalId)
      if (!plan && params.action === 'status') {
        return publicInstallResult(
          await installer.request(
            {
              packageId: 'administrative-skill-import',
              snapshotId: 'v1',
              rowId: 'management',
              leaseId: owner,
              sessionKey: `management:${granted.principalId}`,
              toolUseId: params.commandId,
              deniedPaths: [],
              input: { action: 'status', proposalId: params.proposalId },
            },
            authority,
            controller.signal,
          ),
        )
      }
      if (!plan || plan.owner !== owner)
        throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_PROPOSAL_UNAVAILABLE' })
      if (params.action === 'commit') {
        if (params.expectedDigest !== plan.result.digest)
          throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_SOURCE_CHANGED' })
        if (
          plan.invocation.input.action === 'prepare-bundle' &&
          plan.invocation.input.enable &&
          (!granted.permissions.includes('packages.trust') ||
            !granted.permissions.includes('packages.activate'))
        )
          throw rpcError('CAPABILITY_DENIED')
      }
      const result = await installer.request(
        { ...plan.invocation, input: { action: params.action, proposalId: params.proposalId } },
        authority,
        controller.signal,
      )
      plan.result = { ...plan.result, ...publicInstallResult(result) }
      if (['ready', 'installed', 'failed', 'cancelled', 'interrupted'].includes(result.state))
        removeStage(plan.stage)
      return plan.result
    }
    if (!params.source || params.proposalId || params.expectedDigest) throw rpcError('INVALID_PARAMS')
    if (plans.size + preparing >= 16 || preparing >= 4)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_INSTALL_BUSY' })
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    const stage = join(options.directory, `source-${randomUUID()}`)
    assertSkillSourceLocation(
      params.source,
      options.workspace,
      ['secrets', 'auth', 'profiles'].map((name) => join(options.home, name)),
    )
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(240_000),
      ...(checkSignal ? [checkSignal] : []),
    ])
    let retained = false
    preparing++
    try {
      const fetched = await fetchSource(params.source, stage, {
        cwd: options.workspace,
        contentOnly: true,
        signal,
      })
      progress?.('identifying')
      const origin = {
        sourceDigest: fetched.integrity,
        resolvedSource: (fetched.source ?? params.source) as NonNullable<SkillImportResult['resolvedSource']>,
      }
      if (!params.subdirectory) {
        const imported = await mcps.prepare({
          source: fetched.dir,
          integrity: fetched.integrity,
          params,
          granted,
          owner,
          origin,
          signal,
          ...(progress ? { progress } : {}),
        })
        if (imported) return imported
      }
      let selection = selectSkillSource(fetched.dir, params.subdirectory)
      if (!selection.reason && !selection.directory && selection.candidates.length === 1)
        selection = selectSkillSource(fetched.dir, selection.candidates[0])
      if (selection.reason) return { state: 'unsupported', message: selection.reason, ...origin }
      if (!selection.directory)
        return { state: 'selection_required', candidates: selection.candidates, ...origin }
      const invocation: SkillInstallInvocation = {
        packageId: 'administrative-skill-import',
        snapshotId: 'v1',
        rowId: 'management',
        leaseId: owner,
        sessionKey: `management:${granted.principalId}`,
        toolUseId: params.commandId,
        deniedPaths: [
          join(options.home, 'secrets'),
          join(options.home, 'auth'),
          join(options.home, 'profiles'),
        ],
        input: {
          action: 'prepare-bundle',
          sourceDirectory: selection.directory,
          scope: params.scope ?? 'user',
          enable: params.enable ?? false,
        },
      }
      progress?.('validating')
      const prepared = await installer.request(invocation, { ...authority, provenance: origin }, signal)
      progress?.('environment')
      const environment = await (options.environment ?? skillEnvironment)(
        selection.directory,
        prepared.files ?? [],
        options.home,
        signal,
      )
      const result: SkillImportResult = {
        ...publicInstallResult(prepared),
        ...origin,
        environment,
        warnings: ['SKILL_DYNAMIC_DEPENDENCIES_UNVERIFIED', 'SKILL_EXECUTION_USES_SESSION_POLICY'],
      }
      signal.throwIfAborted()
      plans.set(prepared.proposalId, { owner, invocation, result, expires: Date.now() + 10 * 60_000, stage })
      retained = true
      return result
    } finally {
      preparing--
      if (!retained) removeStage(stage)
    }
  }
  const checks = createSkillImportChecks(
    (params, granted, signal, progress) => execute(params, granted, signal, progress),
    (params, granted) => execute(params, granted),
  )
  const mcps = createMcpImports(options)
  return {
    async list(profile: string, granted: PackageAdminAuthority) {
      if (!granted.permissions.includes('packages.read') || granted.installer === 'agent')
        throw rpcError('CAPABILITY_DENIED')
      if (profile !== options.profile) return []
      return mcps.list(jcs([granted.principalId, profile, options.workspace]), granted)
    },
    async call(params: SkillImportParams, granted: PackageAdminAuthority): Promise<SkillImportResult> {
      cleanup()
      const key = jcs([granted.principalId, granted.clientId, params.commandId])
      const payload = jcs(params)
      const existing = commands.get(key)
      if (existing) {
        if (existing.payload !== payload)
          throw rpcError('SEMANTIC_REJECTED', { reason: 'COMMAND_ID_CONFLICT' })
        return existing.task
      }
      if (commands.size >= 64) throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_INSTALL_BUSY' })
      const task = execute(params, granted)
      // Status is live, never frozen by a prior read command.
      if (params.action !== 'status') commands.set(key, { payload, task, expires: Date.now() + 10 * 60_000 })
      return task
    },
    async close() {
      clearInterval(timer)
      controller.abort()
      checks.close()
      await mcps.close()
      for (const plan of plans.values()) removeStage(plan.stage)
      plans.clear()
      commands.clear()
    },
  }
}

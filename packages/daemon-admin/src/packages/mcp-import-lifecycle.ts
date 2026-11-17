import { randomUUID } from 'node:crypto'
import { mcpImportError } from '@agnes/package-manager'
import type { McpServerDefinitionInput, SkillImportParams, SkillImportResult } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { runtimeIntegrity } from './mcp-import-artifacts.js'
import type { mcpEnvironment } from './mcp-import-environment.js'
import { missingMcpEntry } from './mcp-import-environment.js'
import { importResourceEffect } from './mcp-import-operations.js'
import { type ImportResourcePort, importDigest, type McpPlan } from './mcp-import-state.js'
import type { PackageAdminAuthority } from './permissions.js'

type Preview = NonNullable<SkillImportResult['activation']>
type Member = Preview['resources'][number]
type Context = {
  port: ImportResourcePort
  granted: PackageAdminAuthority
  signal: AbortSignal
  environment: (
    definitions: McpServerDefinitionInput[],
    signal: AbortSignal,
  ) => ReturnType<typeof mcpEnvironment>
  save(): Promise<void>
}

const safeCode = (error: unknown) => {
  const value = error as { safeCode?: string; code?: string; data?: { code?: string; reason?: string } }
  const code = value.safeCode ?? value.data?.code ?? value.data?.reason ?? value.code
  return typeof code === 'string' &&
    /^(E_|MCP_|SKILL_|RESOURCE_|REVISION_|CAPABILITY_)[A-Z0-9_]{1,110}$/.test(code)
    ? code
    : 'MCP_OPERATION_FAILED'
}
// Issues express eligibility, not authorization to substitute a newly observed definition.
const binding = ({ issues: _issues, ...row }: Member) => importDigest(row)

async function review(plan: McpPlan, enable: boolean, context: Context): Promise<Preview> {
  const resources: Member[] = []
  const environment: Preview['environment'] = []
  const probes = new Map<string, Preview['environment']>()
  const artifactsChanged =
    enable &&
    plan.runtime?.ready &&
    plan.runtime.root &&
    (await runtimeIntegrity(plan.runtime.root, context.signal).catch(() => {
      context.signal.throwIfAborted()
      return ''
    })) !== plan.runtime.integrity
  const members = [
    ...plan.result
      .mcp!.servers.filter((row) => row.revision && row.state !== 'removed')
      .map((row) => ({
        kind: 'mcp' as const,
        resourceId: `mcp/${row.serverId}`,
        name: row.serverId,
        revision: row.revision!,
      })),
    ...plan.result
      .mcp!.skills.filter((row) => row.resourceId && row.revision && row.state !== 'removed')
      .map((row) => ({
        kind: 'skill' as const,
        resourceId: row.resourceId!,
        name: row.name,
        revision: row.revision!,
      })),
  ]
  for (const row of members) {
    context.signal.throwIfAborted()
    const member: Member = { ...row, trust: 'untrusted', desired: 'disabled', issues: [] }
    const issues = member.issues!
    try {
      const current = (await context.port('_agnes/v1/resources.get', { resourceId: row.resourceId })) as {
        revision: string
        trust: Member['trust']
        desired: Member['desired']
        stale?: boolean
        definition?: McpServerDefinitionInput
        resolution?: { winner?: boolean }
      }
      if (current.revision !== row.revision) issues.push('MCP_RESOURCE_CONFLICT')
      else {
        member.trust = current.trust ?? 'untrusted'
        member.desired = current.desired ?? 'disabled'
        if (enable && (current.stale || current.resolution?.winner === false))
          issues.push('MCP_SKILL_UNAVAILABLE')
        if (enable && member.trust !== 'trusted' && !context.granted.permissions.includes('packages.trust'))
          issues.push('MCP_TRUST_REQUIRED')
        if (row.kind === 'mcp') {
          const definition = current.definition
          if (!definition) issues.push('MCP_CONFIGURATION_REQUIRED')
          else {
            const transport = definition.transport
            member.launch =
              transport.kind === 'stdio'
                ? JSON.stringify([transport.executable, ...transport.args])
                : transport.url
            member.credentialKind = definition.secretBinding.kind
            if (
              enable &&
              member.credentialKind !== 'none' &&
              !context.granted.permissions.includes('credentials.read')
            )
              issues.push('MCP_CREDENTIAL_PERMISSION_REQUIRED')
            if (transport.kind === 'stdio') {
              if ('workspacePath' in definition && definition.workspacePath)
                member.cwd = definition.workspacePath
              if ('sandboxProfile' in definition && definition.sandboxProfile)
                member.sandboxProfile = definition.sandboxProfile
              if (enable) {
                if (artifactsChanged) issues.push('MCP_RUNTIME_CHANGED')
                if (await missingMcpEntry([definition])) issues.push('MCP_LOCAL_ENTRY_MISSING')
                let report = probes.get(transport.executable)
                if (!report) {
                  report = await context.environment([definition], context.signal)
                  probes.set(transport.executable, report)
                  for (const item of report)
                    if (!environment.some((existing) => importDigest(existing) === importDigest(item)))
                      environment.push(item)
                }
                if (report.some((item) => item.state === 'missing' || item.state === 'unsupported'))
                  issues.push('MCP_ENVIRONMENT_BLOCKED')
              }
            }
          }
        }
      }
    } catch (error) {
      context.signal.throwIfAborted()
      const code = safeCode(error)
      issues.push(
        ['RESOURCE_NOT_FOUND', 'MCP_NOT_FOUND'].includes(code)
          ? 'MCP_CAPABILITY_MISSING'
          : 'MCP_RESOURCE_UNAVAILABLE',
      )
    }
    resources.push(member)
  }
  const snapshot = {
    enable,
    resources,
    environment: environment.slice(0, 32),
    issues: resources.length ? [] : ['MCP_CAPABILITY_MISSING'],
    warnings: [],
  }
  return {
    ...snapshot,
    digest: importDigest(snapshot),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }
}

async function apply(preview: Preview, context: Context, save: () => Promise<void>) {
  const effect = (method: Parameters<ImportResourcePort>[0], data: Record<string, unknown>) =>
    importResourceEffect(
      context.port,
      method,
      { ...data, commandId: `package-state-${randomUUID()}` },
      context.signal,
    )
  const rows = [...preview.resources].sort((a, b) =>
    preview.enable
      ? Number(a.kind === 'skill') - Number(b.kind === 'skill')
      : Number(a.kind === 'mcp') - Number(b.kind === 'mcp'),
  )
  for (const row of rows) {
    context.signal.throwIfAborted()
    const outcome: NonNullable<Preview['outcomes']>[number] = {
      resourceId: row.resourceId,
      status: 'skipped',
    }
    if (row.issues?.length) outcome.code = row.issues[0]!
    else {
      try {
        const current = (await context.port('_agnes/v1/resources.get', { resourceId: row.resourceId })) as {
          revision: string
          desired: Member['desired']
          trust: Member['trust']
          actual: string
        }
        if (
          current.revision !== row.revision ||
          current.desired !== row.desired ||
          current.trust !== row.trust
        )
          mcpImportError('MCP_ACTIVATION_CHANGED')
        const desired = preview.enable ? 'enabled' : 'disabled'
        const actual = preview.enable ? 'ready' : 'disabled'
        if (
          current.desired !== desired ||
          current.actual !== actual ||
          (preview.enable && current.trust !== 'trusted')
        ) {
          const identity =
            row.kind === 'mcp' ? { serverId: row.resourceId.slice(4) } : { resourceId: row.resourceId }
          if (preview.enable && row.trust !== 'trusted')
            await effect(
              row.kind === 'mcp' ? '_agnes/v1/mcp.servers.trust.set' : '_agnes/v1/skills.trust.set',
              {
                ...identity,
                expectedRevision: row.revision,
                trust: 'trusted',
              },
            )
          if (row.kind === 'mcp')
            await effect(
              !preview.enable
                ? '_agnes/v1/mcp.servers.disable'
                : current.desired === 'enabled' && current.trust === 'trusted'
                  ? '_agnes/v1/mcp.servers.reconnect'
                  : '_agnes/v1/mcp.servers.enable',
              {
                ...identity,
                expectedRevision: row.revision,
              },
            )
          else
            await effect('_agnes/v1/resources.desired.set', {
              ...identity,
              expectedRevision: row.revision,
              state: desired,
            })
          const updated = (await context.port('_agnes/v1/resources.get', {
            resourceId: row.resourceId,
          })) as typeof current
          if (updated.revision !== row.revision) mcpImportError('MCP_RESOURCE_CONFLICT')
          if (updated.desired !== desired || updated.actual !== actual)
            mcpImportError('MCP_CAPABILITY_NOT_READY')
        }
        outcome.status = 'succeeded'
      } catch (error) {
        context.signal.throwIfAborted()
        outcome.status = 'failed'
        outcome.code = safeCode(error)
      }
    }
    preview.outcomes!.push(outcome)
    if (outcome.status === 'succeeded') preview.completed!.push(row.resourceId)
    // Persistence errors stop the group; do not hide uncertain writes as a member failure.
    await save()
  }
}

/** Group coordination uses existing revision-checked resource operations; it owns no second trust store. */
export async function requestMcpLifecycle(plan: McpPlan, params: SkillImportParams, context: Context) {
  if (
    !context.granted.permissions.includes('packages.install') ||
    !context.granted.permissions.includes('packages.activate')
  )
    throw rpcError('CAPABILITY_DENIED')
  // Retained only to refuse requests from older clients; AGH no longer prepares external runtimes.
  if (params.action === 'runtime-prepare') return mcpImportError('MCP_RUNTIME_MANUAL_REQUIRED')
  if (plan.running) {
    if (plan.result.state === 'running') return structuredClone(plan.result)
    await plan.running
  }
  if (plan.uncertain) return mcpImportError('MCP_RECOVERY_REVIEW_REQUIRED')
  if (params.expectedDigest !== plan.result.digest) return mcpImportError('SKILL_SOURCE_CHANGED')
  if (!plan.result.mcp || ['prepared', 'cancelled'].includes(plan.result.state))
    return mcpImportError('MCP_IMPORT_INTERRUPTED')
  const checking = params.action === 'activation-check'
  if (checking && typeof params.enable !== 'boolean') throw rpcError('INVALID_PARAMS')
  const preview = plan.result.activation,
    enable = checking ? params.enable! : params.action === 'enable'
  if (!checking && preview?.outcomes) return mcpImportError('MCP_ACTIVATION_CHANGED')
  if (
    !checking &&
    (!preview ||
      preview.enable !== enable ||
      preview.digest !== params.expectedActivationDigest ||
      !Number.isFinite(Date.parse(preview.expiresAt)) ||
      Date.parse(preview.expiresAt) < Date.now())
  )
    return mcpImportError('MCP_ACTIVATION_CHANGED')
  const cancellation = new AbortController(),
    signal = AbortSignal.any([context.signal, cancellation.signal])
  plan.controller = cancellation
  delete plan.result.message
  if (checking) delete plan.result.activation
  plan.result = {
    ...plan.result,
    state: 'running',
    phase: checking ? 'checking-activation' : enable ? 'enabling' : 'disabling',
  }
  plan.running = (async () => {
    try {
      await context.save()
      const fresh = await review(plan, enable, { ...context, signal })
      if (checking) {
        plan.result = { ...plan.result, state: 'installed', phase: 'activation-reviewed', activation: fresh }
        return
      }
      if (fresh.issues.length) return mcpImportError(fresh.issues[0]!)
      fresh.resources = preview!.resources.map((row) => {
        const current = fresh.resources.find((item) => item.resourceId === row.resourceId)
        const issues = row.issues?.length
          ? row.issues
          : !current || binding(current) !== binding(row)
            ? ['MCP_ACTIVATION_CHANGED']
            : (current.issues ?? [])
        return {
          ...row,
          issues:
            enable && row.trust !== 'trusted' && !params.trustResources
              ? [...issues, 'MCP_TRUST_REQUIRED']
              : issues,
        }
      })
      fresh.completed = []
      fresh.outcomes = []
      plan.result.activation = fresh
      await context.save()
      await apply(fresh, { ...context, signal }, context.save)
      const successes = fresh.completed.length
      const complete = successes === fresh.resources.length
      plan.result = {
        ...plan.result,
        state: successes ? 'installed' : 'failed',
        phase: complete
          ? enable
            ? 'enabled'
            : 'disabled'
          : successes
            ? enable
              ? 'partially-enabled'
              : 'partially-disabled'
            : enable
              ? 'enable-failed'
              : 'disable-failed',
        ...(!successes ? { message: 'MCP_NO_CAPABILITY_APPLIED' } : {}),
      }
    } catch (error) {
      const code = (error as { code?: string }).code,
        safeCode = (error as { safeCode?: string }).safeCode
      if (safeCode && /^[A-Z][A-Z0-9_]{0,127}$/.test(safeCode) && plan.result.activation)
        plan.result.activation.errorCode = safeCode
      plan.result = {
        ...plan.result,
        state: signal.aborted ? 'interrupted' : 'failed',
        message: code && /^(MCP_|SKILL_)[A-Z_]+$/.test(code) ? code : 'MCP_OPERATION_FAILED',
      }
    } finally {
      try {
        await context.save()
      } finally {
        delete plan.running
        delete plan.controller
      }
    }
  })()
  void plan.running.catch(() => undefined)
  return structuredClone(plan.result)
}

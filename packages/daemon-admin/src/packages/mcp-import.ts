import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createSkillInstaller, type SkillInstallInvocation } from '@agnes/host'
import { hashDirectoryAsync, mcpImportError, readImportJson, readMcpImport } from '@agnes/package-manager'
import {
  jcs,
  rpcError,
  type SkillImportParams,
  type SkillImportResult,
  validatePackageAdminCall,
} from '@agnes/protocol'
import type { ResourceControlService } from '@agnes/resource-control-store'
import { replaceFileAtomicSync } from '@agnes/system-node'
import { runtimeBase } from './mcp-import-artifacts.js'
import { mcpEnvironment } from './mcp-import-environment.js'
import { importPackageName, readMcpInventory } from './mcp-import-inventory.js'
import { requestMcpLifecycle } from './mcp-import-lifecycle.js'
import { commitMcpPlan, type ImportSkillPort, rollbackMcpPlan } from './mcp-import-operations.js'
import {
  checkMcpSourceBudget,
  importDigest,
  type McpPlan,
  type McpPreview,
  resourcePort,
} from './mcp-import-state.js'
import type { PackageAdminAuthority } from './permissions.js'

export function createMcpImports(options: {
  directory: string
  home: string
  profile: string
  workspace: string
  resources: Pick<ResourceControlService, 'call'>
  discovery: Parameters<typeof createSkillInstaller>[1]
  mcpEnvironment?: typeof mcpEnvironment
}) {
  const directory = join(options.directory, 'mcp'),
    receipts = join(directory, 'receipts')
  const installer = createSkillInstaller(join(directory, 'skill-receipts'), options.discovery)
  const plans = new Map<string, McpPlan>()
  const controller = new AbortController()
  const rootFor = (id: string) => join(directory, 'sources', id)
  const save = async (plan: McpPlan) => {
    await mkdir(receipts, { recursive: true, mode: 0o700 })
    replaceFileAtomicSync(
      join(receipts, `${plan.id}.json`),
      JSON.stringify({
        owner: plan.owner,
        result: plan.result,
        integrity: plan.integrity,
        uncertain: plan.uncertain ?? false,
        ...(plan.runtime ? { runtime: plan.runtime } : {}),
        ...(plan.metadata ? { metadata: plan.metadata } : {}),
      }),
    )
  }
  const skillPort = (granted: PackageAdminAuthority): ImportSkillPort => ({
    request: (invocation, signal) =>
      installer.request(
        invocation,
        {
          principalId: granted.principalId,
          profile: options.profile,
          agnesHome: options.home,
          workspaceRoot: options.workspace,
          assertActive: () => controller.signal.throwIfAborted(),
          ask: async () => true,
          background: (task) => {
            void task.catch(() => undefined)
          },
          resources: resourcePort(options.resources, options.profile, granted),
        },
        signal,
      ),
  })
  const load = async (id: string, owner: string) => {
    let plan = plans.get(id)
    if (!plan) {
      try {
        const file = join(receipts, `${id}.json`),
          stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          throw new Error('invalid receipt')
        const stored = JSON.parse(await readFile(file, 'utf8'))
        if (
          stored.owner !== owner ||
          !validatePackageAdminCall('_agnes/v1/packages.skillImport', 'result', stored.result).ok ||
          stored.result.proposalId !== id ||
          stored.result.kind !== 'mcp'
        )
          throw new Error('invalid receipt')
        plan = {
          id,
          owner,
          root: rootFor(id),
          integrity: stored.integrity,
          expires: Date.now() + 600_000,
          result: stored.result,
          definitions: [],
          skills: new Map(),
          uncertain: stored.uncertain === true,
          ...(stored.metadata ? { metadata: stored.metadata } : {}),
        }
        if (stored.runtime) {
          const runtime = stored.runtime
          if (
            !Array.isArray(runtime.attempts) ||
            runtime.attempts.length > 4 ||
            runtime.attempts.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) ||
            typeof runtime.ready !== 'boolean'
          )
            throw new Error('invalid runtime receipt')
          const expected = join(runtimeBase(plan), runtime.attempts.at(-1) ?? '', 'payload')
          if (runtime.root && runtime.root !== expected) throw new Error('invalid runtime root')
          if (runtime.ready && (!runtime.root || !/^[a-f0-9]{64}$/.test(runtime.integrity)))
            throw new Error('invalid runtime digest')
          plan.runtime = runtime
        }
        if (['prepared', 'running'].includes(plan.result.state))
          plan.result = { ...plan.result, state: 'interrupted', message: 'MCP_IMPORT_INTERRUPTED' }
        plans.set(id, plan)
      } catch {
        throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_PROPOSAL_UNAVAILABLE' })
      }
    }
    if (plan.owner !== owner) throw rpcError('CAPABILITY_DENIED')
    return plan
  }
  const previewSkill = async (
    plan: McpPlan,
    path: string,
    granted: PackageAdminAuthority,
    signal: AbortSignal,
  ) => {
    const invocation: SkillInstallInvocation = {
      packageId: 'administrative-mcp-import',
      snapshotId: 'v1',
      // Each bounded companion is a distinct Host installation row. Sharing one row would
      // exhaust its two-proposal quota before a multi-Skill package can be reviewed.
      rowId: `${plan.id}:${path}`,
      leaseId: plan.owner,
      sessionKey: `management:${granted.principalId}`,
      toolUseId: randomUUID(),
      deniedPaths: ['secrets', 'auth', 'profiles'].map((name) => join(options.home, name)),
      input: {
        action: 'prepare-bundle',
        sourceDirectory: join(plan.root, path),
        scope: 'user',
        enable: false,
        exclusive: true,
      },
    }
    try {
      const prepared = await skillPort(granted).request(invocation, signal)
      if (existsSync(join(options.home, 'skills', prepared.name ?? ''))) {
        await skillPort(granted).request(
          { ...invocation, input: { action: 'cancel', proposalId: prepared.proposalId } },
          signal,
        )
        return { path, name: prepared.name ?? basename(path), state: 'unsupported' as const }
      }
      plan.skills.set(path, { invocation, proposalId: prepared.proposalId })
      return {
        path,
        name: prepared.name ?? basename(path),
        state: 'prepared' as const,
        fileCount: prepared.fileCount ?? 0,
        ...(prepared.digest ? { digest: prepared.digest } : {}),
        ...(prepared.revision ? { revision: prepared.revision } : {}),
      }
    } catch {
      signal.throwIfAborted()
      return { path, name: basename(path), state: 'unsupported' as const }
    }
  }
  return {
    list(owner: string, granted: PackageAdminAuthority) {
      return readMcpInventory(
        receipts,
        owner,
        resourcePort(options.resources, options.profile, granted),
        new Set([...plans.values()].filter((plan) => plan.running).map((plan) => plan.id)),
      )
    },
    async prepare(input: {
      source: string
      integrity: string
      params: SkillImportParams
      granted: PackageAdminAuthority
      owner: string
      origin: Pick<SkillImportResult, 'sourceDigest' | 'resolvedSource'>
      signal: AbortSignal
      progress?: (phase: string) => void
    }) {
      const { source, integrity, params, granted, owner, signal, origin } = input
      const pkg = await readImportJson(source, 'package.json')
      if (pkg && Object.hasOwn(pkg, 'agnes')) return undefined
      const id = `mcp-import-${randomUUID()}`,
        root = rootFor(id)
      const parsed = await readMcpImport(source, root, params.credentialBindings)
      if (!parsed) return undefined
      const selected = new Set(params.mcpServers ?? [])
      if ([...selected].some((id) => !parsed.definitions.some((row) => row.serverId === id)))
        return mcpImportError('MCP_SELECTION_INVALID')
      const selectedDefinitions = parsed.definitions.filter((row) => selected.has(row.serverId))
      for (const definition of parsed.definitions)
        if ('sandboxProfile' in definition && definition.transport.kind === 'stdio')
          definition.sandboxProfile = params.mcpSandboxProfile ?? 'strict'
      if (params.enable || params.scope === 'workspace') return mcpImportError('MCP_CONFIG_UNSUPPORTED')
      if (plans.size >= 16) return mcpImportError('SKILL_INSTALL_BUSY')
      await checkMcpSourceBudget(source, signal)
      await mkdir(join(directory, 'sources'), { recursive: true, mode: 0o700 })
      await rename(source, root)
      const preview: McpPreview = {
        servers: parsed.definitions.map((definition) => ({
          serverId: definition.serverId,
          transport: definition.transport.kind,
          state: 'planned',
          selected: selected.has(definition.serverId),
          requiredCredentials: parsed.requiredCredentialsByServer[definition.serverId] ?? [],
          credentialKind: definition.secretBinding.kind,
          ...('sandboxProfile' in definition && definition.sandboxProfile
            ? { sandboxProfile: definition.sandboxProfile }
            : {}),
          ...(definition.transport.kind === 'stdio'
            ? {
                command: definition.transport.executable,
                args: definition.transport.args,
                ...('workspacePath' in definition && definition.workspacePath
                  ? { cwd: definition.workspacePath }
                  : {}),
              }
            : { url: definition.transport.url }),
        })),
        skills: [],
        requiredCredentials: parsed.definitions
          .filter((row) => selected.has(row.serverId))
          .flatMap((row) => parsed.requiredCredentialsByServer[row.serverId] ?? []),
        configurationFiles: parsed.configurationFiles,
        issues: [],
      }
      const plan: McpPlan = {
        metadata: {
          name: importPackageName(origin.resolvedSource ?? { type: 'path', ref: source }),
          ...(typeof pkg?.version === 'string' && pkg.version.length <= 64 ? { version: pkg.version } : {}),
          ...(typeof pkg?.description === 'string' && pkg.description.length <= 1024
            ? { description: pkg.description }
            : {}),
        },
        id,
        owner,
        root,
        integrity,
        expires: Date.now() + 600_000,
        result: { kind: 'mcp', state: 'prepared', proposalId: id, mcp: preview, ...origin },
        definitions: parsed.definitions,
        skills: new Map(),
      }
      try {
        input.progress?.('validating')
        for (const path of parsed.skills) preview.skills.push(await previewSkill(plan, path, granted, signal))
        input.progress?.('environment')
        plan.result.environment = selectedDefinitions.length
          ? await (options.mcpEnvironment ?? mcpEnvironment)(root, selectedDefinitions, options.home, signal)
          : []
        const port = resourcePort(options.resources, options.profile, granted)
        const current = await Promise.allSettled(
          preview.servers
            .filter((server) => server.selected)
            .map((server) => port('_agnes/v1/mcp.servers.get', { serverId: server.serverId })),
        )
        for (const row of current) {
          if (row.status === 'fulfilled') {
            if (!preview.issues.includes('MCP_SERVER_CONFLICT')) preview.issues.push('MCP_SERVER_CONFLICT')
          } else if ((row.reason as { data?: { code?: string } })?.data?.code !== 'MCP_NOT_FOUND')
            throw row.reason
        }
        plan.result.warnings = parsed.warnings
        plan.result.digest = importDigest({
          integrity,
          definitions: parsed.definitions,
          selectedServers: [...selected].sort(),
          skills: preview.skills,
        })
        signal.throwIfAborted()
        plans.set(id, plan)
        await save(plan)
        return structuredClone(plan.result)
      } catch (error) {
        await rm(root, { recursive: true, force: true })
        throw error
      }
    },
    async request(params: SkillImportParams, granted: PackageAdminAuthority, owner: string) {
      const id = params.proposalId
      if (!id?.startsWith('mcp-import-')) return undefined
      if (!/^mcp-import-[a-f0-9-]{36}$/.test(id)) throw rpcError('INVALID_PARAMS')
      const plan = await load(id, owner),
        port = resourcePort(options.resources, options.profile, granted)
      if (params.action === 'status') {
        if (plan.running && plan.result.state !== 'running') await plan.running
        return structuredClone(plan.result)
      }
      if (['activation-check', 'enable', 'disable', 'runtime-prepare'].includes(params.action))
        return requestMcpLifecycle(plan, params, {
          port,
          granted,
          signal: controller.signal,
          save: () => save(plan),
          environment: (definitions, signal) =>
            (options.mcpEnvironment ?? mcpEnvironment)(plan.root, definitions, options.home, signal),
        })
      if (params.action === 'cancel') {
        if (plan.running) {
          plan.controller?.abort()
          await plan.running
          return structuredClone(plan.result)
        }
        if (plan.result.state === 'prepared') {
          for (const entry of plan.skills.values())
            await skillPort(granted).request(
              { ...entry.invocation, input: { action: 'cancel', proposalId: entry.proposalId } },
              controller.signal,
            )
          plan.result = { ...plan.result, state: 'cancelled' }
          await save(plan)
          await rm(plan.root, { recursive: true, force: true })
        }
        return structuredClone(plan.result)
      }
      if (!['commit', 'rollback', 'uninstall'].includes(params.action)) throw rpcError('INVALID_PARAMS')
      if (plan.running) return structuredClone(plan.result)
      if (plan.uncertain) {
        plan.result = { ...plan.result, state: 'interrupted', message: 'MCP_RECOVERY_REVIEW_REQUIRED' }
        await save(plan)
        return structuredClone(plan.result)
      }
      if (params.expectedDigest !== plan.result.digest)
        throw rpcError('SEMANTIC_REJECTED', { reason: 'SKILL_SOURCE_CHANGED' })
      if (!granted.permissions.includes('packages.install')) throw rpcError('CAPABILITY_DENIED')
      if (params.action === 'uninstall' && !granted.permissions.includes('packages.remove'))
        throw rpcError('CAPABILITY_DENIED')
      if (params.action === 'commit') {
        const chosen = params.mcpServers ?? []
        const checked = plan.result.mcp!.servers.filter((row) => row.selected).map((row) => row.serverId)
        if (chosen.some((id) => !plan.result.mcp!.servers.some((row) => row.serverId === id)))
          return mcpImportError('MCP_SELECTION_INVALID')
        if (jcs([...chosen].sort()) !== jcs(checked.sort())) return mcpImportError('MCP_SELECTION_CHANGED')
        if (!chosen.length && !params.skillDirectories?.length)
          return mcpImportError('MCP_SELECTION_REQUIRED')
        if (params.testConnection && !chosen.length) return mcpImportError('MCP_SELECTION_REQUIRED')

        if (
          params.testConnection &&
          plan.definitions.some(
            (definition) => chosen.includes(definition.serverId) && definition.secretBinding.kind !== 'none',
          ) &&
          !granted.permissions.includes('credentials.read')
        )
          throw rpcError('CAPABILITY_DENIED')
        if (plan.result.state !== 'prepared' || Date.now() > plan.expires)
          return mcpImportError('MCP_IMPORT_INTERRUPTED')
        if (plan.result.mcp!.requiredCredentials.length || plan.result.mcp!.issues.length)
          return mcpImportError('MCP_CONFIGURATION_REQUIRED')
        if ((params.skillDirectories ?? []).some((path) => !plan.skills.has(path)))
          return mcpImportError('MCP_SKILL_UNAVAILABLE')
        if (
          params.testConnection &&
          (!granted.permissions.includes('packages.trust') ||
            !granted.permissions.includes('packages.activate'))
        )
          throw rpcError('CAPABILITY_DENIED')
        if (
          params.testConnection &&
          plan.result.environment?.some((item) => item.state === 'missing' || item.state === 'unsupported')
        )
          return mcpImportError('MCP_ENVIRONMENT_BLOCKED')
      }
      const cancellation = new AbortController(),
        signal = AbortSignal.any([controller.signal, cancellation.signal])
      plan.controller = cancellation
      if (params.action === 'commit' && plan.metadata && !plan.metadata.installedAt)
        plan.metadata.installedAt = new Date().toISOString()
      delete plan.result.message
      plan.result = {
        ...plan.result,
        state: 'running',
        phase: params.action === 'commit' ? 'registering' : 'rolling-back',
      }
      await save(plan)
      plan.running = (async () => {
        try {
          if (params.action === 'commit') {
            if ((await hashDirectoryAsync(plan.root, { signal })) !== plan.integrity)
              return mcpImportError('SKILL_SOURCE_CHANGED')
            await commitMcpPlan(plan, params, port, skillPort(granted), () => save(plan), signal)
            plan.result = { ...plan.result, state: 'installed', phase: 'complete' }
          } else {
            await rollbackMcpPlan(plan, port, () => save(plan), signal)
            for (const [path, entry] of plan.skills)
              if (plan.result.mcp?.skills.find((skill) => skill.path === path)?.state === 'prepared')
                await skillPort(granted).request(
                  { ...entry.invocation, input: { action: 'cancel', proposalId: entry.proposalId } },
                  signal,
                )
            plan.result = { ...plan.result, state: 'cancelled', phase: 'rolled-back' }
            await rm(plan.root, { recursive: true, force: true })
            await rm(runtimeBase(plan), { recursive: true, force: true })
          }
        } catch (error) {
          const code = (error as { code?: string }).code
          plan.result = {
            ...plan.result,
            state: signal.aborted ? 'interrupted' : 'failed',
            message:
              typeof code === 'string' && /^(?:MCP_|SKILL_)[A-Z_]+$/.test(code)
                ? code
                : 'MCP_OPERATION_FAILED',
          }
        } finally {
          try {
            await save(plan)
          } finally {
            delete plan.running
            delete plan.controller
          }
        }
      })()
      void plan.running.catch(() => undefined)
      return structuredClone(plan.result)
    },
    cleanup() {
      for (const [id, plan] of plans)
        if (!plan.running && plan.expires < Date.now()) {
          plans.delete(id)
          if (plan.result.state === 'prepared')
            void rm(plan.root, { recursive: true, force: true }).catch(() => undefined)
        }
    },
    async close() {
      controller.abort()
      await Promise.allSettled([...plans.values()].flatMap((plan) => (plan.running ? [plan.running] : [])))
      for (const plan of plans.values())
        if (plan.result.state === 'prepared') {
          plan.result = { ...plan.result, state: 'interrupted', message: 'MCP_IMPORT_INTERRUPTED' }
          await save(plan)
          await rm(plan.root, { recursive: true, force: true })
        }
    },
  }
}

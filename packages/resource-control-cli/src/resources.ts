import { randomUUID } from 'node:crypto'
import type { McpServerDefinitionInput, ResourceDescriptor, ResourceOperation } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'

/** Resource parser failures remain typed without importing the outer CLI command layer. */
export class ResourceUsageError extends Error {
  override readonly name = 'UsageError'
}
const UsageError = ResourceUsageError

/** A resource operation reached a safe terminal failure; callers must not render a stack trace. */
export class ResourceOperationFailure extends Error {
  override readonly name = 'ResourceOperationFailure'
  readonly code: string
  constructor(
    readonly operationId: string,
    readonly state: Extract<ResourceOperation['state'], 'failed' | 'cancelled'>,
    safeError: ResourceOperation['lastSafeError'],
    /** `waitForOperation` has already emitted the terminal operation and its safe error. */
    readonly outputRendered = false,
  ) {
    const fallback = state === 'cancelled' ? '资源操作已取消' : '资源操作未能安全完成'
    super(safeError?.message ?? fallback)
    this.code =
      safeError?.code ??
      (state === 'cancelled' ? 'RESOURCE_OPERATION_CANCELLED' : 'RESOURCE_OPERATION_FAILED')
  }
}

/** The backend accepted a receipt but did not finish before the bounded CLI wait elapsed. */
export class ResourceOperationTimeout extends Error {
  override readonly name = 'ResourceOperationTimeout'
  readonly code = 'RESOURCE_OPERATION_TIMEOUT'
  constructor(readonly operationId: string) {
    super('资源操作仍在执行；请查询状态或取消该操作')
  }
}

export function isResourceOperationFailure(
  error: unknown,
): error is ResourceOperationFailure | ResourceOperationTimeout {
  return error instanceof ResourceOperationFailure || error instanceof ResourceOperationTimeout
}

/** Avoid making the outer CLI renderer print a terminal operation's safe error twice. */
export function resourceOperationFailureWasRendered(error: unknown): boolean {
  return error instanceof ResourceOperationFailure && error.outputRendered
}

export type ResourceCommandKind = 'resources' | 'skills' | 'mcp'
export type TuiResourceController = Readonly<{
  execute(
    kind: ResourceCommandKind,
    profile: string,
    args: readonly string[],
  ): Promise<Readonly<{ text: string; unsupported?: boolean }>>
}>

export type ResourceCommandIO = { write(text: string): void; confirm?: (summary: string) => Promise<boolean> }
type Parsed = { action: string; positional: string[]; flags: Map<string, string[]> }

/** Only a missing method is compatible with an older daemon; authorization and policy errors stay visible. */
export function resourceCapabilityMissing(error: unknown): boolean {
  const value = error as { kind?: unknown; data?: { code?: unknown } } | null
  const code = value?.data?.code ?? value?.kind
  return code === 'METHOD_NOT_FOUND' || code === 'RESOURCE_METHOD_UNAVAILABLE' || code === 'unsupported'
}

/** Node bootstrap adapter for the UI-facing resource-management port. */
export function createResourceController(client: NodeClient): TuiResourceController {
  return {
    async execute(kind, profile, args) {
      let text = ''
      try {
        await runResourceCommand(kind, ['--profile', profile, ...args], client, {
          write: (value) => {
            text += value
          },
          confirm: async () => true,
        })
      } catch (error) {
        if (resourceCapabilityMissing(error)) return { text: '', unsupported: true }
        throw error
      }
      return { text: text || 'resource operation accepted' }
    },
  }
}

const VALUE_FLAGS = new Set([
  '--profile',
  '--cursor',
  '--kind',
  '--expected-revision',
  '--root-key',
  '--name',
  '--stdio',
  '--http',
  '--sse',
  '--arg',
  '--secret-env',
  '--bearer-ref',
  '--header-ref',
  '--allow-tool',
  '--workspace-id',
])
const FORBIDDEN_SECRET_FLAGS = new Set([
  '--env',
  '--token',
  '--header',
  '--authorization',
  '--secret',
  '--api-key',
])

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i] as string
    if (FORBIDDEN_SECRET_FLAGS.has(value))
      throw new UsageError(`${value} is not accepted; use a secret:// reference flag instead`)
    if (value.startsWith('-')) {
      if (!VALUE_FLAGS.has(value)) throw new UsageError(`unknown resource command flag ${value}`)
      const next = argv[++i]
      // A stdio argument may itself begin with a dash (`--arg -y`). It is still parsed as data,
      // while known resource flags cannot accidentally be swallowed. Shell execution switches are
      // rejected later with the same managed-transport policy as Host.
      if (
        !next ||
        (next.startsWith('-') &&
          (value !== '--arg' || VALUE_FLAGS.has(next) || FORBIDDEN_SECRET_FLAGS.has(next)))
      )
        throw new UsageError(`${value} needs a value`)
      const values = flags.get(value) ?? []
      values.push(next)
      flags.set(value, values)
      continue
    }
    positional.push(value)
  }
  return { action: positional.shift() ?? '', positional, flags }
}

function one(parsed: Parsed, flag: string): string | undefined {
  const values = parsed.flags.get(flag)
  if (!values) return undefined
  if (values.length !== 1) throw new UsageError(`${flag} may be given once`)
  return values[0]
}
function many(parsed: Parsed, flag: string): readonly string[] {
  return parsed.flags.get(flag) ?? []
}
function need(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(`usage: ${usage}`)
  return value
}
function noExtra(parsed: Parsed, usage: string): void {
  if (parsed.positional.length) throw new UsageError(`usage: ${usage}`)
}
function onlyFlags(parsed: Parsed, allowed: readonly string[], usage: string): void {
  for (const flag of parsed.flags.keys())
    if (!allowed.includes(flag))
      throw new UsageError(`usage: ${usage}; ${flag} does not apply to this action`)
}
function valid(value: string, expression: RegExp, label: string): string {
  if (!expression.test(value)) throw new UsageError(`invalid ${label}`)
  return value
}
const PROFILE = /^[a-z][a-z0-9._-]{0,127}$/
const SERVER = /^[a-z][a-z0-9._-]{0,127}$/
const REVISION = /^[a-f0-9]{64}$/
const SKILL_ID = /^skill\/[a-z0-9][a-z0-9._/-]{0,255}$/
const TOOL = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/
const SKILL_ROOTS = [
  'workspace-agnes',
  'user-agnes',
  'user-agents',
  'user-claude',
  'user-codex',
  'package',
] as const
function isSkillRoot(value: string): value is (typeof SKILL_ROOTS)[number] {
  return (SKILL_ROOTS as readonly string[]).includes(value)
}
function commandId(kind: string): string {
  return `${kind}-${randomUUID().replaceAll('-', '')}`
}
function profile(parsed: Parsed): string {
  return valid(one(parsed, '--profile') ?? 'local-dev', PROFILE, 'profile')
}
function expected(parsed: Parsed, usage: string): string {
  return valid(need(one(parsed, '--expected-revision'), usage), REVISION, 'expected revision')
}

function resourceLine(resource: ResourceDescriptor): string {
  if (resource.kind === 'skill') {
    const resolution = resource.resolution.winner ? 'winner' : 'shadowed'
    const error = resource.lastSafeError
      ? ` ${resource.lastSafeError.code}:${resource.lastSafeError.message}`
      : ''
    return `${resource.resourceId} name=${resource.name} revision=${resource.revision} trust=${resource.trust} desired=${resource.desired} actual=${resource.actual} ${resolution} source=${resource.sourceIdentity.scope}/${resource.sourceIdentity.rootKey}${resource.stale ? ' stale=true' : ''}${error}`
  }
  return `${resource.serverId} revision=${resource.revision} trust=${resource.trust} desired=${resource.desired} actual=${resource.actual} transport=${resource.transportKind}`
}
function operationLine(operation: ResourceOperation): string {
  const result = operation.result
  return [
    `${operation.kind} ${operation.state} target=${operation.target} revision=${operation.revision}`,
    ...(result
      ? [
          `safe result toolCount=${result.toolCount ?? 0}${result.catalogRevision ? ` catalogRevision=${result.catalogRevision}` : ''}`,
        ]
      : []),
    ...(operation.lastSafeError
      ? [`${operation.lastSafeError.code}: ${operation.lastSafeError.message}`]
      : []),
  ].join('\n')
}
function receiptLine(operationId: string, state: string): string {
  return `operation ${operationId} ${state}`
}
const TERMINAL = new Set<ResourceOperation['state']>(['succeeded', 'failed', 'cancelled'])
const MAX_OPERATION_POLLS = 300
async function confirm(io: ResourceCommandIO, summary: string): Promise<void> {
  if (!(await (io.confirm?.(summary) ?? Promise.resolve(false))))
    throw new UsageError('operation cancelled; rerun and confirm the displayed revision and trust change')
}
async function waitForOperation(
  client: NodeClient,
  profile: string,
  receipt: { operationId: string; state: string },
  io: ResourceCommandIO,
): Promise<void> {
  io.write(`${receiptLine(receipt.operationId, receipt.state)}\n`)
  for (let poll = 0; poll < MAX_OPERATION_POLLS; poll++) {
    const operation = await client.resources.operation.get({ profile, operationId: receipt.operationId })
    if (TERMINAL.has(operation.state)) {
      io.write(`${operationLine(operation)}\n`)
      if (operation.state === 'failed' || operation.state === 'cancelled')
        throw new ResourceOperationFailure(
          receipt.operationId,
          operation.state,
          operation.lastSafeError,
          true,
        )
      io.write(
        'control plane updated; idle sessions use the new snapshot on the next request; in-flight turns keep the old snapshot until the turn ends\n',
      )
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new ResourceOperationTimeout(receipt.operationId)
}

function secretRef(value: string, flag: string): string {
  if (!/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(value))
    throw new UsageError(`${flag} must use secret://<id>; raw secret values are rejected`)
  return value
}
function buildDefinition(parsed: Parsed, serverId: string): McpServerDefinitionInput {
  const stdio = one(parsed, '--stdio')
  const http = one(parsed, '--http')
  const sse = one(parsed, '--sse')
  // Count how many transport flags were provided
  const transportCount = [stdio, http, sse].filter((v) => v !== undefined).length
  if (transportCount !== 1)
    throw new UsageError(
      'choose exactly one transport: --stdio <executable>, --http <https-url|local-loopback-http-url>, or --sse <url>',
    )
  const displayName = need(
    one(parsed, '--name'),
    'agh mcp add <serverId> --name <displayName> (--stdio <executable> | --http <url> | --sse <url>)',
  )
  const secretEnv = many(parsed, '--secret-env')
  const bearer = one(parsed, '--bearer-ref')
  const header = one(parsed, '--header-ref')
  for (const tool of many(parsed, '--allow-tool')) valid(tool, TOOL, 'tool allowlist entry')
  if (stdio) {
    if (bearer || header) throw new UsageError('stdio only accepts --secret-env NAME=secret://<id>')
    const env: Record<string, string> = {}
    for (const item of secretEnv) {
      const at = item.indexOf('=')
      const name = item.slice(0, at)
      const value = item.slice(at + 1)
      if (
        at < 1 ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
        ['PATH', 'HOME', 'SHELL', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(name)
      )
        throw new UsageError('--secret-env name must be a permitted uppercase environment name')
      env[name] = secretRef(value, '--secret-env')
    }
    const args = [...many(parsed, '--arg')]
    if (args.some((arg) => /^(?:-c|\/c)$/i.test(arg)))
      throw new UsageError('--arg may not use a shell command switch')
    return {
      serverId,
      displayName,
      transport: { kind: 'stdio', executable: stdio, args },
      secretBinding: secretEnv.length ? { kind: 'stdio-env', env } : { kind: 'none' },
      ...(many(parsed, '--allow-tool').length
        ? { toolPolicy: { allow: [...many(parsed, '--allow-tool')] } }
        : {}),
    }
  }
  if (secretEnv.length || (bearer && header))
    throw new UsageError(
      'HTTP/SSE accepts one of --bearer-ref, --header-ref x-api-key|x-api-token=secret://<id>, or no credential',
    )
  let secretBinding: McpServerDefinitionInput['secretBinding'] = { kind: 'none' }
  if (bearer) secretBinding = { kind: 'http-bearer', credentialRef: secretRef(bearer, '--bearer-ref') }
  if (header) {
    const at = header.indexOf('=')
    const headerName = header.slice(0, at)
    if ((headerName !== 'x-api-key' && headerName !== 'x-api-token') || at < 1)
      throw new UsageError('--header-ref must be x-api-key=secret://<id> or x-api-token=secret://<id>')
    secretBinding = {
      kind: 'http-header',
      headerName,
      credentialRef: secretRef(header.slice(at + 1), '--header-ref'),
    }
  }
  if (http) {
    return {
      serverId,
      displayName,
      transport: { kind: 'http', url: http },
      secretBinding,
      ...(many(parsed, '--allow-tool').length
        ? { toolPolicy: { allow: [...many(parsed, '--allow-tool')] } }
        : {}),
    }
  }
  // sse must be defined at this point (we checked exactly one transport is defined)
  return {
    serverId,
    displayName,
    transport: { kind: 'sse', url: sse as string },
    secretBinding,
    ...(many(parsed, '--allow-tool').length
      ? { toolPolicy: { allow: [...many(parsed, '--allow-tool')] } }
      : {}),
  }
}

export function resourceCommandProfile(argv: readonly string[]): string | undefined {
  return one(parse(argv), '--profile')
}

export async function runResourceCommand(
  kind: 'resources' | 'skills' | 'mcp',
  argv: readonly string[],
  client: NodeClient,
  io: ResourceCommandIO,
): Promise<void> {
  const parsed = parse(argv)
  const p = profile(parsed)
  if (kind === 'resources') {
    if (parsed.action === 'list') {
      onlyFlags(
        parsed,
        ['--profile', '--kind', '--cursor', '--workspace-id'],
        'agh resources list [--kind skill|mcp] [--cursor <cursor>] [--workspace-id <id>]',
      )
      noExtra(parsed, 'agh resources list [--kind skill|mcp] [--cursor <cursor>] [--workspace-id <id>]')
      const kind = one(parsed, '--kind') as 'skill' | 'mcp' | undefined
      if (kind !== undefined && kind !== 'skill' && kind !== 'mcp')
        throw new UsageError('--kind must be skill or mcp')
      const cursor = one(parsed, '--cursor')
      const workspaceId = one(parsed, '--workspace-id')
      if (workspaceId !== undefined && !/^[a-f0-9]{64}$/.test(workspaceId))
        throw new UsageError('--workspace-id must be a 64-character hex workspace id')
      const page = await client.resources.list({
        profile: p,
        ...(kind ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      })
      if (kind !== 'mcp' && page.skillRoots?.length)
        io.write(
          `${page.skillRoots.map((root) => `${root.scope}/${root.rootKey} ${root.state}`).join('\n')}\n`,
        )
      io.write(
        page.items.length
          ? page.items.map(resourceLine).join('\n')
          : kind === 'mcp'
            ? 'No resources found.'
            : [
                'No resources found.',
                'Skill files are scanned from these templates only:',
                '<workspace>/.agh/skills/<name>/SKILL.md',
                '~/.agh/skills/<name>/SKILL.md',
                '~/.agents/skills/<name>/SKILL.md',
                '~/.claude/skills/<name>/SKILL.md',
                '~/.codex/skills/<name>/SKILL.md',
                'Only immediate child directories of those roots. Ordinary skills/ folders are ignored.',
              ].join('\n'),
      )
      if (page.nextCursor) io.write(`\nnextCursor ${page.nextCursor}`)
      return
    }
    if (parsed.action === 'get') {
      onlyFlags(parsed, ['--profile'], 'agh resources get <resourceId>')
      noExtra({ ...parsed, positional: parsed.positional.slice(1) }, 'agh resources get <resourceId>')
      const resourceId = valid(
        need(parsed.positional[0], 'agh resources get <resourceId>'),
        /^(?:skill|mcp)\//,
        'resource id',
      )
      io.write(resourceLine(await client.resources.get({ profile: p, resourceId })))
      return
    }
    if (parsed.action === 'operation') {
      onlyFlags(parsed, ['--profile'], 'agh resources operation <operationId>')
      noExtra({ ...parsed, positional: parsed.positional.slice(1) }, 'agh resources operation <operationId>')
      const operationId = need(parsed.positional[0], 'agh resources operation <operationId>')
      io.write(operationLine(await client.resources.operation.get({ profile: p, operationId })))
      return
    }
    if (parsed.action === 'cancel') {
      onlyFlags(parsed, ['--profile'], 'agh resources cancel <operationId>')
      noExtra({ ...parsed, positional: parsed.positional.slice(1) }, 'agh resources cancel <operationId>')
      const operationId = need(parsed.positional[0], 'agh resources cancel <operationId>')
      await confirm(io, `cancel resource operation ${operationId}`)
      const receipt = await client.resources.operation.cancel({
        profile: p,
        operationId,
        clientId: await client.clientId(),
        commandId: commandId('resource-cancel'),
      })
      await waitForOperation(client, p, receipt, io)
      return
    }
    if (parsed.action === 'enable' || parsed.action === 'disable') {
      onlyFlags(
        parsed,
        ['--profile', '--expected-revision'],
        `agh resources ${parsed.action} <skillResourceId> --expected-revision <revision>`,
      )
      noExtra(
        { ...parsed, positional: parsed.positional.slice(1) },
        `agh resources ${parsed.action} <skillResourceId> --expected-revision <revision>`,
      )
      const resourceId = valid(
        need(
          parsed.positional[0],
          `agh resources ${parsed.action} <skillResourceId> --expected-revision <revision>`,
        ),
        SKILL_ID,
        'skill resource id',
      )
      const revision = expected(
        parsed,
        `agh resources ${parsed.action} <skillResourceId> --expected-revision <revision>`,
      )
      await confirm(io, `${parsed.action} ${resourceId} at revision ${revision}`)
      const receipt = await client.resources.desiredSet({
        profile: p,
        resourceId,
        state: parsed.action === 'enable' ? 'enabled' : 'disabled',
        expectedRevision: revision,
        config: { kind: 'none' },
        clientId: await client.clientId(),
        commandId: commandId(`resource-${parsed.action}`),
      })
      await waitForOperation(client, p, receipt, io)
      return
    }
    throw new UsageError('usage: agh resources list|get|operation|cancel|enable|disable ...')
  }
  if (kind === 'skills') {
    if (parsed.action === 'refresh') {
      onlyFlags(
        parsed,
        ['--profile', '--root-key', '--workspace-id'],
        'agh skills refresh [--root-key <key>] [--workspace-id <id>]',
      )
      noExtra(parsed, 'agh skills refresh [--root-key <key>] [--workspace-id <id>]')
      const requestedRoot = one(parsed, '--root-key')
      if (requestedRoot !== undefined && !isSkillRoot(requestedRoot))
        throw new UsageError('invalid skill root key')
      const rootKey = requestedRoot
      const workspaceId = one(parsed, '--workspace-id')
      if (workspaceId !== undefined && !/^[a-f0-9]{64}$/.test(workspaceId))
        throw new UsageError('--workspace-id must be a 64-character hex workspace id')
      await confirm(io, `refresh skills${rootKey ? ` from ${rootKey}` : ''}`)
      const receipt = await client.skills.refresh({
        profile: p,
        ...(rootKey ? { rootKey } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        clientId: await client.clientId(),
        commandId: commandId('skill-refresh'),
      })
      await waitForOperation(client, p, receipt, io)
      return
    }
    if (parsed.action === 'trust') {
      onlyFlags(parsed, ['--profile'], 'agh skills trust <skillResourceId> <revision> [trusted|rejected]')
      if (parsed.positional.length < 2 || parsed.positional.length > 3)
        throw new UsageError('usage: agh skills trust <skillResourceId> <revision> [trusted|rejected]')
      const resourceId = valid(
        need(parsed.positional[0], 'agh skills trust <skillResourceId> <revision> [trusted|rejected]'),
        SKILL_ID,
        'skill resource id',
      )
      const revision = valid(
        need(parsed.positional[1], 'agh skills trust <skillResourceId> <revision> [trusted|rejected]'),
        REVISION,
        'revision',
      )
      const trust = (parsed.positional[2] ?? 'trusted') as 'trusted' | 'rejected'
      if (trust !== 'trusted' && trust !== 'rejected')
        throw new UsageError('skill trust must be trusted or rejected')
      await confirm(io, `set Skill ${resourceId} revision ${revision} trust=${trust}`)
      const receipt = await client.skills.trustSet({
        profile: p,
        resourceId,
        expectedRevision: revision,
        trust,
        clientId: await client.clientId(),
        commandId: commandId('skill-trust'),
      })
      await waitForOperation(client, p, receipt, io)
      return
    }
    throw new UsageError('usage: agh skills refresh|trust ...')
  }
  const serverId = parsed.positional[0]
  const effect = async (action: 'remove' | 'test' | 'enable' | 'disable' | 'reconnect' | 'trust') => {
    onlyFlags(
      parsed,
      ['--profile', '--expected-revision'],
      `agh mcp ${action} <serverId> --expected-revision <revision>`,
    )
    if (parsed.positional.length !== 1 && !(action === 'trust' && parsed.positional.length === 2))
      throw new UsageError(
        `usage: agh mcp ${action} <serverId> --expected-revision <revision>${action === 'trust' ? ' [trusted|rejected]' : ''}`,
      )
    const id = valid(
      need(serverId, `agh mcp ${action} <serverId> --expected-revision <revision>`),
      SERVER,
      'server id',
    )
    const revision = expected(parsed, `agh mcp ${action} <serverId> --expected-revision <revision>`)
    const trust = action === 'trust' ? (parsed.positional[1] ?? 'trusted') : undefined
    if (trust !== undefined && trust !== 'trusted' && trust !== 'rejected')
      throw new UsageError('MCP trust must be trusted or rejected')
    await confirm(io, `${action} MCP ${id} at revision ${revision}${trust ? ` trust=${trust}` : ''}`)
    const common = {
      profile: p,
      serverId: id,
      expectedRevision: revision,
      clientId: await client.clientId(),
      commandId: commandId(`mcp-${action}`),
    }
    const receipt =
      action === 'remove'
        ? await client.mcp.servers.remove(common)
        : action === 'test'
          ? await client.mcp.servers.test(common)
          : action === 'enable'
            ? await client.mcp.servers.enable(common)
            : action === 'disable'
              ? await client.mcp.servers.disable(common)
              : action === 'reconnect'
                ? await client.mcp.servers.reconnect(common)
                : await client.mcp.servers.trustSet({
                    ...common,
                    trust: (parsed.positional[1] ?? 'trusted') as 'trusted' | 'rejected',
                  })
    await waitForOperation(client, p, receipt, io)
  }
  switch (parsed.action) {
    case 'list': {
      onlyFlags(parsed, ['--profile', '--cursor'], 'agh mcp list [--cursor <cursor>]')
      noExtra(parsed, 'agh mcp list [--cursor <cursor>]')
      const cursor = one(parsed, '--cursor')
      const page = await client.mcp.servers.list({ profile: p, ...(cursor ? { cursor } : {}) })
      io.write(page.items.length ? page.items.map(resourceLine).join('\n') : 'No MCP servers found.')
      if (page.nextCursor) io.write(`\nnextCursor ${page.nextCursor}`)
      return
    }
    case 'get':
      onlyFlags(parsed, ['--profile'], 'agh mcp get <serverId>')
      if (parsed.positional.length !== 1) throw new UsageError('usage: agh mcp get <serverId>')
      io.write(
        resourceLine(
          await client.mcp.servers.get({
            profile: p,
            serverId: valid(need(serverId, 'agh mcp get <serverId>'), SERVER, 'server id'),
          }),
        ),
      )
      return
    case 'status':
      onlyFlags(parsed, ['--profile'], 'agh mcp status <serverId>')
      if (parsed.positional.length !== 1) throw new UsageError('usage: agh mcp status <serverId>')
      {
        const value = await client.mcp.servers.status({
          profile: p,
          serverId: valid(need(serverId, 'agh mcp status <serverId>'), SERVER, 'server id'),
        })
        io.write(
          `${value.serverId} connection=${value.connectionState} revision=${value.observedRevision ?? 'none'} catalog=${value.catalogRevision ?? 'none'} tools=${value.toolCount}${value.lastSafeError ? `\n${value.lastSafeError.code}: ${value.lastSafeError.message}` : ''}`,
        )
        return
      }
    case 'tools': {
      onlyFlags(parsed, ['--profile', '--cursor'], 'agh mcp tools <serverId> [--cursor <cursor>]')
      if (parsed.positional.length !== 1)
        throw new UsageError('usage: agh mcp tools <serverId> [--cursor <cursor>]')
      const cursor = one(parsed, '--cursor')
      const page = await client.mcp.servers.tools.list({
        profile: p,
        serverId: valid(need(serverId, 'agh mcp tools <serverId> [--cursor <cursor>]'), SERVER, 'server id'),
        ...(cursor ? { cursor } : {}),
      })
      io.write(
        page.items
          .map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
          .join('\n') || 'No tools found.',
      )
      if (page.nextCursor) io.write(`\nnextCursor ${page.nextCursor}`)
      return
    }
    case 'add': {
      onlyFlags(
        parsed,
        [
          '--profile',
          '--name',
          '--stdio',
          '--http',
          '--sse',
          '--arg',
          '--secret-env',
          '--bearer-ref',
          '--header-ref',
          '--allow-tool',
        ],
        'agh mcp add <serverId> ...',
      )
      if (parsed.positional.length !== 1) throw new UsageError('usage: agh mcp add <serverId> ...')
      const id = valid(
        need(
          serverId,
          'agh mcp add <serverId> --name <name> (--stdio <executable> | --http <url> | --sse <url>)',
        ),
        SERVER,
        'server id',
      )
      const definition = buildDefinition(parsed, id)
      await confirm(io, `add MCP ${id} (${definition.transport.kind}) with trust=untrusted`)
      const receipt = await client.mcp.servers.create({
        profile: p,
        definition,
        clientId: await client.clientId(),
        commandId: commandId('mcp-add'),
      })
      await waitForOperation(client, p, receipt, io)
      io.write(
        `MCP ${id} 已创建，但尚未可用（trust=untrusted, desired=disabled）：先执行 /mcp trust ${id} --expected-revision <revision> 完成信任审核，再执行 /mcp enable ${id} --expected-revision <revision> 启用后才能被调用（<revision> 见上方 revision=…）\n`,
      )
      return
    }
    case 'update': {
      onlyFlags(
        parsed,
        [
          '--profile',
          '--expected-revision',
          '--name',
          '--stdio',
          '--http',
          '--sse',
          '--arg',
          '--secret-env',
          '--bearer-ref',
          '--header-ref',
          '--allow-tool',
        ],
        'agh mcp update <serverId> ...',
      )
      if (parsed.positional.length !== 1) throw new UsageError('usage: agh mcp update <serverId> ...')
      const id = valid(
        need(
          serverId,
          'agh mcp update <serverId> --expected-revision <revision> --name <name> (--stdio <executable> | --http <url> | --sse <url>)',
        ),
        SERVER,
        'server id',
      )
      const revision = expected(parsed, 'agh mcp update <serverId> --expected-revision <revision> ...')
      const definition = buildDefinition(parsed, id)
      await confirm(io, `update MCP ${id} at revision ${revision}; trust will need review`)
      const receipt = await client.mcp.servers.update({
        profile: p,
        serverId: id,
        expectedRevision: revision,
        definition,
        clientId: await client.clientId(),
        commandId: commandId('mcp-update'),
      })
      await waitForOperation(client, p, receipt, io)
      return
    }
    case 'remove':
    case 'test':
    case 'enable':
    case 'disable':
    case 'reconnect':
    case 'trust':
      await effect(parsed.action)
      return
    default:
      throw new UsageError(
        'usage: agh mcp list|get|add|update|remove|test|enable|disable|status|reconnect|tools ...',
      )
  }
}

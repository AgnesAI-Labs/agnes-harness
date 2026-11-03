import {
  createRefinementSkillInstallers,
  type RefinementSkillInstaller,
  type RefinementSkillInstallers,
  refinementSkillRefusal,
} from '@agnes/host'
import type { ResourceControlMethodName } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import type { ResourceAuthority, ResourceControlService } from '@agnes/resource-control-store'
import { discoverSkillRoot, skillRoots } from '@agnes/resource-control-worker'

type SkillDraft = Parameters<RefinementSkillInstaller['install']>[0]

/**
 * The installer's own principal. It may read skills, refresh their folders, trust and enable them, and
 * remove them; nothing else (no MCP, no secrets). Every call it makes is further limited to the methods
 * listed in `METHODS`.
 */
const AUTHORITY: ResourceAuthority = Object.freeze({
  audience: 'admin',
  principalId: 'system:refinement',
  clientId: 'refinement',
  permissions: Object.freeze([
    'resources.read',
    'resources.skills.write',
    'skills.refresh',
    'skills.trust',
  ] as const),
})
const METHODS: ReadonlySet<ResourceControlMethodName> = new Set([
  '_agnes/v1/skills.refresh',
  '_agnes/v1/resources.get',
  '_agnes/v1/skills.trust.set',
  '_agnes/v1/resources.desired.set',
  '_agnes/v1/skills.remove',
  // Reading how an operation ended, and the listing that tells an existing skill of the same name.
  '_agnes/v1/resources.operation.get',
  '_agnes/v1/resources.list',
])
const MAX_INFLIGHT = 8
const MAX_FILES = 33
const MAX_CONTENT = 256 * 1024
const REVISION = /^[a-f0-9]{64}$/

type Raw = Record<string, unknown>
const plain = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const only = (value: Raw, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const text = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

function draftOf(value: unknown): SkillDraft {
  if (
    !plain(value) ||
    !only(value, ['name', 'class', 'files']) ||
    !text(value.name) ||
    value.class !== 'instructions' ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > MAX_FILES ||
    !value.files.every(
      (file) =>
        plain(file) &&
        only(file, ['path', 'content']) &&
        text(file.path, 640) &&
        typeof file.content === 'string' &&
        file.content.length <= MAX_CONTENT,
    )
  )
    throw rpcError('INVALID_PARAMS')
  return structuredClone(value) as SkillDraft
}
/** `enable` turns a skill the review switched off back on with an update or rollback. */
const enableOf = (value: unknown): { enable?: boolean } => {
  if (value === undefined) return {}
  if (typeof value !== 'boolean') throw rpcError('INVALID_PARAMS')
  return { enable: value }
}

type Run = (installer: RefinementSkillInstaller, workspaceRoot: string) => Promise<unknown>

/** Checks a request completely before anything runs; a malformed one is an error, not a refusal. */
function parse(input: Raw): Run {
  switch (input.op) {
    case 'install': {
      if (!only(input, ['op', 'draft', 'receiptId', 'source']) || !text(input.receiptId))
        throw rpcError('INVALID_PARAMS')
      const draft = draftOf(input.draft)
      const receiptId = input.receiptId
      const source = structuredClone(input.source) as never
      return (installer, workspaceRoot) =>
        installer.install(draft, {
          workspaceRoot,
          receiptId,
          source,
        })
    }
    case 'update': {
      if (
        !only(input, ['op', 'name', 'draft', 'expectedRevision', 'enable']) ||
        !text(input.name) ||
        typeof input.expectedRevision !== 'string' ||
        !REVISION.test(input.expectedRevision)
      )
        throw rpcError('INVALID_PARAMS')
      const { name, expectedRevision } = input
      const draft = draftOf(input.draft)
      const options = enableOf(input.enable)
      return (installer) => installer.update(name, draft, { revision: expectedRevision }, options)
    }
    case 'rollback':
      if (
        !only(input, ['op', 'name', 'toRevision', 'enable']) ||
        !text(input.name) ||
        typeof input.toRevision !== 'string' ||
        !REVISION.test(input.toRevision)
      )
        throw rpcError('INVALID_PARAMS')
      {
        const { name, toRevision } = input
        const options = enableOf(input.enable)
        return (installer) => installer.rollback(name, toRevision, options)
      }
    case 'disable':
      if (
        !only(input, ['op', 'name', 'expectedRevision']) ||
        !text(input.name) ||
        typeof input.expectedRevision !== 'string' ||
        !REVISION.test(input.expectedRevision)
      )
        throw rpcError('INVALID_PARAMS')
      {
        const { name, expectedRevision } = input
        return async (installer) => {
          await installer.disable(name, { revision: expectedRevision })
          return {}
        }
      }
    case 'uninstall':
      if (!only(input, ['op', 'name']) || !text(input.name)) throw rpcError('INVALID_PARAMS')
      {
        const { name } = input
        return async (installer) => {
          await installer.uninstall(name)
          return {}
        }
      }
    case 'recover':
      if (!only(input, ['op'])) throw rpcError('INVALID_PARAMS')
      return async (installer) => ({ finished: await installer.recover() })
    default:
      throw rpcError('INVALID_PARAMS')
  }
}

/**
 * The installers for saved skills, bound to their own principal and method list. One set per daemon:
 * every user of it shares the queue each skill name has.
 */
export function savedSkillInstallers(options: {
  dataDir: string
  profile: string
  agnesHome: string
  service: ResourceControlService
  clock?: () => number
  pollMs?: number
}): RefinementSkillInstallers {
  return createRefinementSkillInstallers({
    dataDir: options.dataDir,
    profile: options.profile,
    agnesHome: options.agnesHome,
    discovery: { roots: skillRoots, discover: discoverSkillRoot },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    resources: async (method, params) => {
      if (!METHODS.has(method)) throw rpcError('CAPABILITY_DENIED')
      return options.service.call(
        method,
        { ...params, ...('commandId' in params ? { clientId: AUTHORITY.clientId } : {}) },
        AUTHORITY,
      )
    },
  })
}

/**
 * The skill side of saving refined task experience into a workspace, run here because resource control
 * lives here. Reached only over the authenticated worker channel. The requesting session must be live:
 * a save does not outlive its session. The workspace is always the one that session is bound to, never
 * one named in the request, and nothing happens while refinement is switched off. Refusals come back
 * as a save refusal reason, never as a partial effect.
 */
export function createRefinementSkillRequests(options: {
  dataDir: string
  profile: string
  agnesHome: string
  service: ResourceControlService
  /** The daemon's shared installers; made here when not given. */
  installers?: RefinementSkillInstallers
  workspace(sessionKey: string): string | undefined
  /** Who holds the session now; only a live session may save, like every other session-scoped effect. */
  owner(sessionKey: string): { active: boolean } | undefined
  /** Read again for every request: the refinement switch. */
  enabled(): boolean
  pollMs?: number
}) {
  const installers = options.installers ?? savedSkillInstallers(options)
  let inflight = 0
  return async (sessionKey: string, params: unknown): Promise<unknown> => {
    if (!plain(params)) throw rpcError('INVALID_PARAMS')
    const work = parse(params)
    if (!options.enabled()) return { ok: false, reason: 'refinement-off' }
    const workspace = options.owner(sessionKey)?.active ? options.workspace(sessionKey) : undefined
    if (!workspace) return { ok: false, reason: 'unavailable', code: 'SKILL_WORKSPACE_UNAVAILABLE' }
    if (inflight >= MAX_INFLIGHT) return { ok: false, reason: 'unavailable', code: 'SKILL_INSTALL_BUSY' }
    inflight++
    try {
      const result = await work(installers(workspace), workspace)
      return { ok: true, ...(result as object) }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const reason = (error as { reason?: unknown }).reason
      return {
        ok: false,
        reason: refinementSkillRefusal(error),
        ...(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? { code } : {}),
        ...(typeof reason === 'string' ? { detail: reason.slice(0, 500) } : {}),
      }
    } finally {
      inflight--
    }
  }
}

import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { PresetView } from '@agnes/core-common/step/preset'
import type { SandboxSeam } from '@agnes/core-effects/effects/seams'
import type { ChildRole, ToolPolicy } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import type { SessionOptions } from '../kernel.js'
import type { RegistrySnapshot } from '../registry/tools.js'
import type { SessionImpl } from '../step/session.js'
import { roleAuthority } from './role-authority.js'

export const ROLE_DELEGATION = 'x/core/role-delegation'
export const ROLE_APPROVAL_REFUSAL =
  'Role subagents cannot approve operations or sign business actions. Return the findings and hand this action back to the main assistant.'

/** Plain backend-captured data, recorded on the child's own ledger, never accepted from tool JSON. */
export type RoleDelegation = {
  role: ChildRole
  parentKey: string
  actor: Actor
  tools: string[]
  /** Literal resource allowlists; empty means deny, unlike composition default selections. */
  resources?: { mcp: string[]; skills: string[] }
  generationLimit: number
  maxFanOut: number
  permission: 'read-only' | 'workspace-write'
  approvalPolicy: 'never'
  parentPolicy: string
  /** Captured before admission awaits; absent legacy evidence is conservatively tainted. */
  parentTainted?: boolean
  commandTable?: PresetView['approval']['commandTable']
  /** Retained ancestor floors for nested roles; each table keeps its own decision order. */
  policyCeilings?: Array<{ policy: string; commandTable?: PresetView['approval']['commandTable'] }>
  sandboxRequired: boolean
  /** Opaque seam snapshot: Core persists it; the Host filesystem enforces it. */
  filesystem: ReturnType<SandboxSeam['fsPolicy']>
}

/** Host resolves an adopted application's role; Core still owns child identity and lifecycle. */
export type ResolvedChildRole = {
  role: ChildRole
  open(key: string, options: SessionOptions): Promise<SessionImpl>
}
export type ChildRolePort = {
  list(parent: SessionImpl): Promise<readonly ChildRole[]>
  resolve(parent: SessionImpl, ref: string): Promise<ResolvedChildRole>
}

/** Read only a Core-written register; user/assistant prose is never role attribution. */
export async function recordedChildRole(
  parent: SessionImpl,
  childKey: string,
): Promise<ChildRole | undefined> {
  const [row] = await parent.d.log.storage.scan(childKey, { type: ROLE_DELEGATION, limit: 1 })
  if (row?.origin !== 'system' || row.trust !== 'trusted') return undefined
  const data = row.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const role = data.role
  if (!role || typeof role !== 'object' || Array.isArray(role) || typeof role.ref !== 'string')
    return undefined
  const title = role.title
  if (!title || typeof title !== 'object' || Array.isArray(title) || typeof title.en !== 'string')
    return undefined
  return {
    ref: role.ref,
    title: { en: title.en, ...(typeof title['zh-CN'] === 'string' ? { 'zh-CN': title['zh-CN'] } : {}) },
  }
}

/** Session-local descriptions; shared ToolDefs and their execution fingerprints stay unchanged. */
export function roleToolSnapshot(snapshot: RegistrySnapshot, roles: readonly ChildRole[]): RegistrySnapshot {
  const original = snapshot.byName.get('subagent_spawn')
  if (!original || !roles.length) return snapshot
  let description = `${original.description}
Available application roles (choose role by exact ref). A role starts fresh with its own persona and tools. Do not combine role with model or fork. Approval/signature actions must return to the main assistant:`
  const room = Math.max(
    0,
    Math.floor(
      (3800 - description.length - roles.reduce((size, role) => size + role.ref.length + 5, 0)) /
        roles.length,
    ),
  )
  const localized = (value: ChildRole['title'] | undefined, limit: number) => {
    if (!value) return ''
    const half = value['zh-CN'] ? Math.max(0, Math.floor((limit - 3) / 2)) : limit
    return [value.en.slice(0, half), value['zh-CN']?.slice(0, half)].filter(Boolean).join(' / ')
  }
  for (const role of roles) {
    const titleLimit = Math.min(100, Math.floor(room / 2))
    const title = localized(role.title, titleLimit)
    const purpose = localized(role.description, Math.min(160, room - titleLimit))
    description += `
${role.ref}: ${title}. ${purpose}`.replace(/[\r\t]/g, ' ')
  }
  const tool = Object.freeze({
    ...original,
    description,
    meta: Object.freeze({ ...original.meta, deferLoading: false }),
  })
  const byName = new Map(snapshot.byName)
  byName.set(tool.name, tool)
  const defs = Object.freeze(snapshot.defs.map((def) => (def.name === tool.name ? tool : def)))
  return Object.freeze({
    ...snapshot,
    defs,
    byName,
    hash: sha256Hex(
      canonicalJson(defs.map(({ name, description, parameters }) => ({ name, description, parameters }))),
    ),
  })
}

/** Kept at the role contract for callers; the normalized authority owns policy composition. */
export function intersectRoleToolPolicy(
  own: ToolPolicy,
  parent: ToolPolicy,
  captured: RoleDelegation,
): ToolPolicy {
  return roleAuthority(captured).toolPolicy(own, parent)
}

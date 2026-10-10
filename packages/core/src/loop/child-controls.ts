import { externalChild } from '@agnes/core-child-control/child/directory'
import { hasChildControl } from '@agnes/core-child-control/child/store'
import { CoreError } from '@agnes/core-common/types'
import type { ChildAgentListing } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import { IN_PROCESS_CHILD_PROVIDER_ID } from '../child/provider.js'
import { childBackend } from '../child/sessions.js'
import type { SessionImpl } from '../step/session.js'

const TERMINAL_CHILD = new Set(['completed', 'failed', 'cancelled'])

type ResolvedChild =
  | { kind: 'core'; row: SessionControlledChild }
  | { kind: 'loop'; listing: ChildAgentListing }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

/** Resolve by recorded ownership, never by a client-supplied key prefix or the newest generation. */
export async function controlledChildTree(s: SessionImpl): Promise<SessionControlledChild[]> {
  const rows: SessionControlledChild[] = []
  const visited = new Set<string>()
  async function visit(parentId: string) {
    if (visited.has(parentId)) return
    visited.add(parentId)
    const backend = childBackend(parentId)
    for (const child of (await backend?.list()) ?? []) {
      rows.push(await backend!.humanControlState(child.id))
      await visit(child.id)
    }
  }
  if (hasChildControl(s.d.log.storage)) await visit(s.key)
  for (const child of (await s.loopChildrenPort()?.list()) ?? []) {
    if (rows.some((row) => row.id === child.id)) continue
    rows.push({
      id: child.id,
      parentId: s.key,
      providerId: child.providerId,
      status: child.status,
      controls: {
        stop:
          child.interrupt === true &&
          s.d.loopFactory.controls?.interrupt === true &&
          child.status === 'running',
        continue: child.continuable && s.d.loopFactory.controls?.steer === true,
      },
      durationMs: child.durationMs ?? null,
      totalTokens: child.totalTokens ?? null,
    })
  }
  return rows
}

/**
 * `childBackend(parentId)` is bound for every Kernel session, so it is not ownership.
 * The core store and the external directory are different backends; an id in both is refused.
 * An in-process loop listing is the core facade echoing its own children, not a second owner.
 */
async function resolveControlledChild(s: SessionImpl, id: string): Promise<ResolvedChild> {
  const row = await coreControlledChild(s, id)
  const listing = (await s.loopChildrenPort()?.list())?.find((child) => child.id === id)
  const tracked = externalChild(s.key, id)
  const external =
    tracked !== undefined || (listing !== undefined && listing.providerId !== IN_PROCESS_CHILD_PROVIDER_ID)
  if (row && external) return { kind: 'ambiguous' }
  if (row) return { kind: 'core', row }
  if (listing) return { kind: 'loop', listing }
  if (tracked) return { kind: 'loop', listing: tracked.listing }
  return { kind: 'missing' }
}

async function coreControlledChild(s: SessionImpl, id: string): Promise<SessionControlledChild | undefined> {
  if (!hasChildControl(s.d.log.storage)) return undefined
  const visited = new Set<string>()
  async function visit(parentId: string): Promise<SessionControlledChild | undefined> {
    if (visited.has(parentId)) return undefined
    visited.add(parentId)
    const backend = childBackend(parentId)
    for (const child of (await backend?.list()) ?? []) {
      if (child.id === id) return backend!.humanControlState(id)
      const nested = await visit(child.id)
      if (nested) return nested
    }
    return undefined
  }
  return visit(s.key)
}

async function refuse(
  s: SessionImpl,
  name: string,
  actor: Actor,
  admissionId: string,
  childId: string,
  reason: string,
): Promise<void> {
  await s.d.log.append([s.controls.fact(name, 'refused', actor, { admissionId, childId, reason })])
}

function loopRefusal(
  action: 'stop' | 'continue',
  listing: ChildAgentListing,
): 'CONTROL_NOT_RUNNING' | 'LOOP_CONTROL_UNSUPPORTED' | undefined {
  const finished = TERMINAL_CHILD.has(listing.status)
  if (action === 'stop') {
    if (listing.interrupt !== true) return 'LOOP_CONTROL_UNSUPPORTED'
    if (listing.status !== 'running') return 'CONTROL_NOT_RUNNING'
    return undefined
  }
  if (finished) return 'CONTROL_NOT_RUNNING'
  if (!listing.continuable) return 'LOOP_CONTROL_UNSUPPORTED'
  return undefined
}

export async function applyChildControl(
  s: SessionImpl,
  id: string,
  action: 'stop' | 'continue',
  actor: Actor,
  admissionId: string,
  text?: string,
): Promise<number> {
  if (action === 'continue' && !text?.trim()) throw new CoreError('E_ENVELOPE', 'Continue requires a message')
  const name = action === 'stop' ? 'child-stop' : 'child-continue'
  const resolved = await resolveControlledChild(s, id)
  if (resolved.kind === 'ambiguous') {
    await refuse(s, name, actor, admissionId, id, 'CHILD_OWNERSHIP_AMBIGUOUS')
    throw new CoreError('E_CHILD_CONFLICT', 'Child id is owned by more than one control store', {
      control: action,
      reason: 'CHILD_OWNERSHIP_AMBIGUOUS',
    })
  }
  if (resolved.kind === 'missing' || (resolved.kind === 'core' && !resolved.row.controls[action])) {
    await refuse(s, name, actor, admissionId, id, 'LOOP_CONTROL_UNSUPPORTED')
    throw new CoreError('E_UNSUPPORTED', 'Child does not support this control', {
      control: action,
      reason: 'LOOP_CONTROL_UNSUPPORTED',
    })
  }
  if (resolved.kind === 'loop') {
    // Loop capability is recorded as interrupt/steer. A finished child is a separate refusal.
    await s.controls.require(action === 'stop' ? 'interrupt' : 'steer', actor)
    const reason = loopRefusal(action, resolved.listing)
    if (reason === 'CONTROL_NOT_RUNNING') {
      await refuse(s, name, actor, admissionId, id, reason)
      throw new CoreError('E_RELATION', 'Child is no longer running', { reason, control: action })
    }
    if (reason === 'LOOP_CONTROL_UNSUPPORTED') {
      await refuse(s, name, actor, admissionId, id, reason)
      throw new CoreError('E_UNSUPPORTED', 'Child does not support this control', {
        control: action,
        reason,
      })
    }
  }
  const result = await s.d.log.append([
    s.controls.fact(name, 'requested', actor, { admissionId, childId: id }),
  ])
  try {
    if (resolved.kind === 'core') {
      const backend = childBackend(resolved.row.parentId)
      if (!backend) throw new CoreError('E_CHILD_NOT_FOUND', 'Child backend is not bound', { childId: id })
      await backend.humanControl(id, action, actor, admissionId, text)
    } else {
      const port = s.loopChildrenPort()
      if (!port)
        throw new CoreError('E_UNSUPPORTED', 'Child does not support this control', {
          control: action,
          reason: 'LOOP_CONTROL_UNSUPPORTED',
        })
      if (action === 'stop') {
        if (!(await port.interrupt(id)).accepted)
          throw new CoreError('E_RELATION', 'Child is no longer running', { reason: 'CONTROL_NOT_RUNNING' })
      } else await port.sendMessage(id, text ?? '', new AbortController().signal)
    }
    await s.d.log.append([s.controls.fact(name, 'applied', actor, { admissionId, childId: id })])
  } catch (error) {
    await s.d.log.append([
      s.controls.fact(
        name,
        error instanceof CoreError &&
          ['E_UNSUPPORTED', 'E_RELATION', 'E_CHILD_NOT_FOUND', 'E_CHILD_CONFLICT', 'E_ENVELOPE'].includes(
            error.code,
          )
          ? 'refused'
          : 'uncertain',
        actor,
        {
          admissionId,
          childId: id,
          reason: error instanceof CoreError ? (error.detail?.reason ?? error.code) : 'CONTROL_FAILED',
        },
      ),
    ])
    throw error
  }
  return result.firstSeq
}

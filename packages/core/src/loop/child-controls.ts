import { externalChild } from '@agnes/core-child-control/child/directory'
import { hasChildControl } from '@agnes/core-child-control/child/store'
import { CoreError } from '@agnes/core-common/types'
import type { ChildAgentListing, ChildTaskRecord } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import { readHumanChildState } from '../child/human-control.js'
import { IN_PROCESS_CHILD_PROVIDER_ID } from '../child/provider.js'
import { childBackend, ownedChildTree } from '../child/sessions.js'
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
  const storage = s.d.log.storage
  if (hasChildControl(storage))
    for await (const record of ownedChildTree(storage, s.key)) rows.push(await readControlledChild(s, record))
  for (const child of (await s.loopChildrenPort()?.list()) ?? []) {
    if (rows.some((row) => row.id === child.id)) continue
    rows.push({
      id: child.id,
      parentId: s.key,
      providerId: child.providerId,
      ...(child.label ? { label: child.label } : {}),
      status: child.status,
      controls: {
        stop:
          child.interrupt === true &&
          s.d.loopFactory.controls?.interrupt === true &&
          child.status === 'running',
        continue:
          !TERMINAL_CHILD.has(child.status) && child.continuable && s.d.loopFactory.controls?.steer === true,
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

async function readControlledChild(s: SessionImpl, record: ChildTaskRecord) {
  const backend = childBackend(record.parentKey)
  return backend
    ? backend.humanControlState(record.childKey)
    : readHumanChildState(s, record.childKey, (row) => row.parentKey === record.parentKey, undefined, false)
}

async function ownedChildPath(s: SessionImpl, id: string) {
  const store = s.d.log.storage
  if (!hasChildControl(store) || id === s.key) return undefined
  const seen = new Set([s.key])
  const path: ChildTaskRecord[] = []
  for (let key = id; !seen.has(key); ) {
    seen.add(key)
    const record = await store.lookupByKey(key)
    if (!record) return undefined
    path.unshift(record)
    if (record.parentKey === s.key) return path
    key = record.parentKey
  }
  return undefined
}

async function coreControlledChild(s: SessionImpl, id: string) {
  const record = (await ownedChildPath(s, id))?.at(-1)
  return record && readControlledChild(s, record)
}

async function resolveCoreBackend(s: SessionImpl, row: SessionControlledChild) {
  const live = childBackend(row.parentId)
  if (live) return live
  const path = await ownedChildPath(s, row.id)
  let backend = childBackend(s.key)
  for (const ancestor of path?.slice(0, -1) ?? []) {
    if (!backend) break
    backend = childBackend(ancestor.childKey) ?? (await backend.reopenControlOwner(ancestor))
  }
  return path && childBackend(row.parentId)
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

export type ChildControlAction = 'stop' | 'continue' | 'pause' | 'resume' | 'close' | 'retain'

function loopRefusal(
  action: ChildControlAction,
  listing: ChildAgentListing,
): 'CONTROL_NOT_RUNNING' | 'LOOP_CONTROL_UNSUPPORTED' | undefined {
  const finished = TERMINAL_CHILD.has(listing.status)
  if (action === 'pause' || action === 'resume' || action === 'close' || action === 'retain')
    return 'LOOP_CONTROL_UNSUPPORTED'
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
  action: ChildControlAction,
  actor: Actor,
  admissionId: string,
  text?: string,
): Promise<number> {
  if (action === 'continue' && !text?.trim()) throw new CoreError('E_ENVELOPE', 'Continue requires a message')
  const name = `child-${action}`
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
      const backend = await resolveCoreBackend(s, resolved.row)
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

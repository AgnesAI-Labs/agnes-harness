import { hasChildControl } from '@agnes/core-child-control/child/store'
import { CoreError } from '@agnes/core-common/types'
import type { Actor } from '@agnes/protocol'
import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import { childBackend } from '../child/sessions.js'
import type { SessionImpl } from '../step/session.js'

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

export async function applyChildControl(
  s: SessionImpl,
  id: string,
  action: 'stop' | 'continue',
  actor: Actor,
  admissionId: string,
  text?: string,
): Promise<number> {
  if (action === 'continue' && !text?.trim()) throw new CoreError('E_ENVELOPE', 'Continue requires a message')
  const child = (await controlledChildTree(s)).find((child) => child.id === id)
  const name = action === 'stop' ? 'child-stop' : 'child-continue'
  if (!child || !child.controls[action]) {
    await s.d.log.append([
      s.controls.fact(name, 'refused', actor, {
        admissionId,
        childId: id,
        reason: 'LOOP_CONTROL_UNSUPPORTED',
      }),
    ])
    throw new CoreError('E_UNSUPPORTED', 'Child does not support this control', {
      control: action,
      reason: 'LOOP_CONTROL_UNSUPPORTED',
    })
  }
  const backend = childBackend(child.parentId)
  if (!backend) await s.controls.require(action === 'stop' ? 'interrupt' : 'steer', actor)
  const result = await s.d.log.append([
    s.controls.fact(name, 'requested', actor, { admissionId, childId: id }),
  ])
  try {
    if (backend) await backend.humanControl(id, action, actor, admissionId, text)
    else {
      const port = s.loopChildrenPort()!
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
          ['E_UNSUPPORTED', 'E_RELATION', 'E_CHILD_NOT_FOUND', 'E_ENVELOPE'].includes(error.code)
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

import type { ProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity'
import { defaultProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity-default'
import type { JsonValue } from '@agnes/protocol'

export type ProcessQuery = (pid: number) => Promise<ProcessIdentity>

/** A failed or stalled OS probe is uncertainty, never proof that a resource stopped. */
async function query(pid: number, probe: ProcessQuery): Promise<ProcessIdentity> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const found = await Promise.race([
      Promise.resolve().then(() => probe(pid)),
      new Promise<ProcessIdentity>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown', reason: 'identity deadline' }), 3000)
      }),
    ])
    if (found?.state === 'dead') return found
    if (found?.state === 'alive' && validStartId(found.startId)) return found
    return { state: 'unknown', reason: 'invalid identity' }
  } catch {
    return { state: 'unknown', reason: 'identity unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

function validStartId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
}

export async function managedProcessOwner(pid: number, probe: ProcessQuery = defaultProcessIdentity) {
  const identity = await query(pid, probe)
  return { pid, startId: identity.state === 'alive' && identity.startId ? identity.startId : null }
}

/** In-process resources die with their worker. A reused PID does not identify that worker. */
export async function managedProcessState(
  value: JsonValue | undefined,
  probe: ProcessQuery = defaultProcessIdentity,
): Promise<'dead' | 'alive' | 'unknown'> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !validStartId(value.startId)
  )
    return 'unknown'
  const identity = await query(value.pid, probe)
  if (identity.state === 'dead') return 'dead'
  if (identity.state === 'alive') return identity.startId === value.startId ? 'alive' : 'dead'
  return 'unknown'
}

export async function managedProcessGone(value: JsonValue | undefined, probe?: ProcessQuery) {
  return (await managedProcessState(value, probe)) === 'dead'
}

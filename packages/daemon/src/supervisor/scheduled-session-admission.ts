import type { ScheduleTarget } from '@agnes/base/schedule'
import { dispatchMarkOf, type JobsRepo } from '@agnes/daemon-foundation/jobs/repo'

export type ScheduledSessionAdmission = Readonly<{
  runId: string
  jobKey: string
  taskId: string
  revision: number
  sessionKey: string
  root: string
}>
export type ScheduledBindingAuthority = {
  scheduleEligible(taskId: string, root: string): boolean
  reserveScheduledBinding(input: ScheduledSessionAdmission): void
  commitScheduledBinding(sessionKey: string): void
  interruptScheduledBinding(runId: string): void
}

/** Tokens never cross the daemon boundary. Their shape alone conveys no authority. */
export function createScheduledSessionAdmission(input: {
  repo: Pick<JobsRepo, 'get'>
  authority: ScheduledBindingAuthority
  clock(): number
  targetOf(
    key: string,
  ): { id: string; revision: number; jobKey: string; title: string; target: ScheduleTarget } | undefined
}) {
  const issued = new WeakSet<ScheduledSessionAdmission>()
  const runs = new Set<string>()
  const consumed = new WeakSet<ScheduledSessionAdmission>()
  const committed = new WeakSet<ScheduledSessionAdmission>()
  return {
    async admitLegacyRun(
      identity: { jobKey: string; runId: string; sessionKey: string },
      signal: AbortSignal,
    ): Promise<ScheduledSessionAdmission> {
      signal.throwIfAborted()
      const job = input.repo.get(identity.jobKey)
      if (job?.status !== 'active' || !job.leaseOwner || (job.leaseUntil ?? 0) < input.clock())
        throw new Error('scheduled run lease unavailable')
      const mark = dispatchMarkOf(job)
      if (mark?.runId !== identity.runId || mark.sessionKey !== identity.sessionKey)
        throw new Error('scheduled run identity mismatch')
      if (runs.has(identity.runId)) throw new Error('scheduled run admission already issued')
      const task = input.targetOf(identity.jobKey)
      if (
        !task ||
        task.jobKey !== identity.jobKey ||
        task.target.kind !== 'new-session' ||
        !input.authority.scheduleEligible(task.id, task.target.cwd)
      )
        throw new Error('legacy schedule unavailable')
      const admission = Object.freeze({
        ...identity,
        taskId: task.id,
        revision: task.revision,
        root: task.target.cwd,
      })
      // This synchronous write is the linearization point shared with task edits.
      input.authority.reserveScheduledBinding(admission)
      runs.add(identity.runId)
      issued.add(admission)
      return admission
    },
    consume(admission: ScheduledSessionAdmission, cwd: string, sessionKey: string): void {
      if (
        !issued.has(admission) ||
        consumed.has(admission) ||
        admission.root !== cwd ||
        admission.sessionKey !== sessionKey
      )
        throw new Error('scheduled session admission unavailable')
      consumed.add(admission)
    },
    commit(admission: ScheduledSessionAdmission, sessionKey: string): void {
      if (
        !issued.has(admission) ||
        !consumed.has(admission) ||
        committed.has(admission) ||
        admission.sessionKey !== sessionKey
      )
        throw new Error('scheduled session admission unavailable')
      input.authority.commitScheduledBinding(sessionKey)
      committed.add(admission)
    },
    interrupted(runId: string): void {
      input.authority.interruptScheduledBinding(runId)
    },
  }
}

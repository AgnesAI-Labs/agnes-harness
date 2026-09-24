import type { ArtifactJob, JobSpec } from '@agnes/core'
import type { SeamInitContext } from '../../../src/seam-init.js'

export type JobRunner = {
  submit(spec: Omit<JobSpec, 'sessionKey'>): Promise<string>
  poll(jobId: string): Promise<ArtifactJob>
  cancel(jobId: string): Promise<void>
}

/**
 * The job half of the artifacts seam, not yet built. It refuses rather than returning something
 * plausible: a submit that answered with an id nothing is running would have the kernel waiting on
 * a job that does not exist, and the wait is where that would surface - long after the call.
 */
export function createJobRunner(_ctx: SeamInitContext): JobRunner {
  const nope = (): Promise<never> =>
    Promise.reject(new Error('artifact jobs are not implemented in this build'))
  return { submit: nope, poll: nope, cancel: nope }
}

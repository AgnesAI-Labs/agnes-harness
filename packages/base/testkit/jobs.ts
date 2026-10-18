import { ShellJobs } from '../extensions/jobs/src/registry.js'
import { createJobsServices } from '../extensions/jobs/src/services.js'

/** Real registry and service handlers, with process ports supplied by the test. */
export function createJobsServiceFixture() {
  const jobs = new ShellJobs()
  return { jobs, services: createJobsServices(jobs) }
}

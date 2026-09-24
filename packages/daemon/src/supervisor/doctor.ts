import type { Scheduler } from '../jobs/scheduler.js'
import { countExpiredWithTurn } from '../lease/lease.js'
import type { Tables } from '../storage/table.js'
import { type DaemonStatusOptions, daemonStatus } from './control.js'

export type DaemonDoctorSection = {
  name: 'lock' | 'socket' | 'leases' | 'jobs'
  status: 'ok' | 'warn' | 'fail'
  detail: unknown
}

export async function daemonDoctor(options: {
  dataDir: string
  tables?: Pick<Tables, 'table'>
  scheduler?: Pick<Scheduler, 'doctor'>
  clock: () => number
  status?: DaemonStatusOptions
}): Promise<{ sections: DaemonDoctorSection[] }> {
  const state = await daemonStatus(options.dataDir, options.status)
  const sections: DaemonDoctorSection[] = [
    {
      name: 'lock',
      status: state.running ? 'ok' : 'warn',
      detail: state.owner ?? 'no owner',
    },
    {
      name: 'socket',
      status: state.socketReachable ? 'ok' : 'warn',
      detail: state.owner?.socketPath ?? null,
    },
  ]
  if (options.tables) {
    // A lapsed lease with no turn open is how an idle session looks; one with a turn open is a
    // writer that died mid-turn and has not been reclaimed yet.
    const expired = countExpiredWithTurn(options.tables.table('writer_claims'), options.clock())
    sections.push({
      name: 'leases',
      status: expired ? 'warn' : 'ok',
      detail: { expired },
    })
  }
  if (options.scheduler) {
    const jobs = options.scheduler.doctor()
    sections.push({
      name: 'jobs',
      status: jobs.stalledForever.length ? 'fail' : jobs.waitingDepth.length ? 'warn' : 'ok',
      detail: jobs,
    })
  }
  return { sections }
}

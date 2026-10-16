import { execFileSync } from 'node:child_process'

/** Called at leader exit, before inherited pipes can keep close pending forever. */
export function stopProcessGroup(pid: number): number | undefined {
  try {
    process.kill(-pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 0
    throw error
  }
  let count: number | undefined
  try {
    // Only numeric identities/state are requested, never command lines or environments.
    const table = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    })
    count = table.split('\n').filter((row) => {
      const [member, group, state] = row.trim().split(/\s+/)
      return Number(group) === pid && Number(member) !== pid && !state?.startsWith('Z')
    }).length
  } catch {
    /* Counting is optional; cleanup is mandatory even if ps is unavailable. */
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 0
    throw error
  }
  return count
}

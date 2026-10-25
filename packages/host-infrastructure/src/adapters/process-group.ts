import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

/** Called at leader exit, before inherited pipes can keep close pending forever. */
export function stopProcessGroup(pid: number): number | undefined {
  try {
    process.kill(-pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 0
    throw error
  }
  // Counting is optional; cleanup is mandatory even if no process table can be read.
  const count = countGroupMembers(pid)
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 0
    throw error
  }
  return count
}

/**
 * Live (non-zombie) members of process group `pid`, other than the leader. A Linux-format `/proc`
 * is read directly: minimal container images (Debian/Ubuntu slim, distroless) ship no `ps`, and a
 * missing count would silently drop the "stopped N descendant process(es)" note the model relies
 * on. Without a readable `/proc` (macOS), `ps` is used.
 */
function countGroupMembers(pid: number): number | undefined {
  const count = countFromProc(pid)
  if (count !== undefined) return count
  try {
    // Only numeric identities/state are requested, never command lines or environments.
    const table = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return table.split('\n').filter((row) => {
      const [member, group, state] = row.trim().split(/\s+/)
      return Number(group) === pid && Number(member) !== pid && !state?.startsWith('Z')
    }).length
  } catch {
    return undefined
  }
}

function countFromProc(pid: number): number | undefined {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return undefined
  }
  let count = 0
  let parsed = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === pid) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // exited between the listing and the read
    }
    // `pid (comm) state ppid pgrp ...`; comm may itself contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const [state, , group] = fields
    if (!state || group === undefined || !/^\d+$/.test(group)) continue
    parsed = true
    if (Number(group) === pid && state !== 'Z' && state !== 'X') count++
  }
  // Our own daemon is always listed, so a table with no parseable row is not a measurement.
  return parsed ? count : undefined
}

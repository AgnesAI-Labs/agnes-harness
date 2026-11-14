import { type ChildProcess, execFileSync } from 'node:child_process'

// Bookkeeping for every process a fixture starts. Processes are stopped by pid (the child handle, plus the
// descendants found in the process table below it), never by name or pattern.
const started = new Set<number>()
const roots = new Set<number>()

/** Every pid this module has been asked to track: spawned children and the descendants seen below them. */
export const startedPids = (): number[] => [...started]

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pids below `pid` in the process table, from a snapshot taken now. */
export function descendants(pid: number): number[] {
  let table: string
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child === undefined || parent === undefined || Number.isNaN(child) || Number.isNaN(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  for (let queue = [pid]; queue.length > 0; ) {
    const next = (children.get(queue.shift() as number) ?? []).filter((child) => !found.includes(child))
    found.push(...next)
    queue.push(...next)
  }
  return found
}

export function trackRoot(child: ChildProcess): void {
  if (child.pid === undefined) return
  started.add(child.pid)
  roots.add(child.pid)
}

/**
 * Stops `child` with `signal`, escalating to SIGKILL by the same handle after `graceMs`, then SIGKILLs by pid any
 * process that was below it when the call began and is still alive (a SIGKILLed daemon does not stop its workers).
 */
export async function killTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  graceMs = 60_000,
): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  const below = descendants(pid)
  for (const each of below) started.add(each)
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill(signal)
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    await exited
    clearTimeout(timer)
  }
  for (const each of below)
    if (isAlive(each)) {
      try {
        process.kill(each, 'SIGKILL')
      } catch {
        /* gone between the check and the kill */
      }
    }
  roots.delete(pid)
}

// A last resort for a runner that exits while a fixture process is still alive: kill by pid, synchronously.
process.once('exit', () => {
  for (const pid of roots) {
    for (const each of [pid, ...descendants(pid)]) {
      try {
        process.kill(each, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
})

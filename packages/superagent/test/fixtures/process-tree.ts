import { type ChildProcess, execFileSync } from 'node:child_process'

// Bookkeeping for every process a fixture starts. Processes are stopped by pid (the child handle, plus the
// descendants found in the process table below it), never by name or pattern. A pid is only ever signalled while
// the process that held it when it was recorded is still the one holding it: a child that has exited is not walked
// (its pid may already belong to someone else), and a descendant is re-identified by its start time before SIGKILL.
const started = new Set<number>()
const roots = new Map<number, ChildProcess>()

type Entry = { ppid: number; start: string }
/** The process table, and the signal sender: injectable so a test can prove what is (not) touched. */
export interface ProcessIo {
  table(): Map<number, Entry>
  kill(pid: number, signal: NodeJS.Signals | 0): void
}

const realIo: ProcessIo = {
  table() {
    const rows = new Map<number, Entry>()
    let text: string
    try {
      text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
    } catch {
      return rows
    }
    for (const line of text.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), start: match[3] as string })
    }
    return rows
  },
  kill: (pid, signal) => process.kill(pid, signal),
}

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

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

/** The processes below `pid` in `table`, with the identity (start time and parent) they have in it. */
function below(pid: number, table: Map<number, Entry>): Map<number, Entry> {
  const found = new Map<number, Entry>()
  for (let queue = [pid]; queue.length > 0; ) {
    const parent = queue.shift() as number
    for (const [child, entry] of table)
      if (entry.ppid === parent && !found.has(child)) {
        found.set(child, entry)
        queue.push(child)
      }
  }
  return found
}

export function trackRoot(child: ChildProcess): void {
  if (child.pid === undefined) return
  started.add(child.pid)
  if (!running(child)) return
  const pid = child.pid
  roots.set(pid, child)
  child.once('exit', () => roots.delete(pid))
}

/**
 * Stops `child` with `signal`, escalating to SIGKILL by the same handle after `graceMs`, then SIGKILLs by pid any
 * process that was below it when the call began and is still the same process (a SIGKILLed daemon does not stop its
 * workers). A child that has already exited is left alone: nothing is walked and nothing is signalled.
 */
export async function killTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  graceMs = 60_000,
  io: ProcessIo = realIo,
): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (!running(child)) {
    roots.delete(pid)
    return
  }
  const snapshot = below(pid, io.table())
  for (const each of snapshot.keys()) started.add(each)
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill(signal)
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
  await exited
  clearTimeout(timer)
  roots.delete(pid)
  const now = io.table()
  for (const [each, before] of snapshot) {
    const current = now.get(each)
    // The same process: same start time, and still under its old parent, a snapshot member, the root or init.
    if (!current || current.start !== before.start) continue
    if (
      !(
        current.ppid === before.ppid ||
        current.ppid === 1 ||
        current.ppid === pid ||
        snapshot.has(current.ppid)
      )
    )
      continue
    try {
      io.kill(each, 'SIGKILL')
    } catch {
      /* gone between the check and the kill */
    }
  }
}

// A last resort for a runner that exits while a fixture process is still alive: kill by pid, synchronously.
// Only roots whose process is still running are touched (an exited one is dropped from `roots` on its 'exit').
process.once('exit', () => {
  for (const [pid, child] of roots) {
    if (!running(child)) continue
    const table = realIo.table()
    for (const each of [pid, ...below(pid, table).keys()]) {
      try {
        process.kill(each, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
})

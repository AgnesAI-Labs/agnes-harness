/**
 * V8 flags every AGH Node process starts with: the CLI (SEA `execArgv`, npm launcher), the daemon
 * and the worker (their spawn arguments).
 *
 * `--max-semi-space-size=2` caps V8's young generation, which start-up otherwise grows and keeps
 * committed in each process. On a 60-step `agh -p` run (linux-arm64) it cut the peak memory of the
 * three processes clearly, at about +6% worker CPU (more scavenges). Measure again before changing
 * the size: 1 MB saved a little more memory at a little more CPU.
 *
 * Always on the command line, never through NODE_OPTIONS: that variable reaches every Node
 * program the task itself starts from a shell tool. Children started with `spawn` do not see it.
 * It does show in `process.execArgv` of the CLI, daemon and worker, and so reaches code that
 * forwards that array, including plugin code running in the worker:
 * - `new Worker(file, { execArgv: process.execArgv })` throws ERR_WORKER_INVALID_EXEC_ARGV. Leave
 *   `execArgv` unset: the thread shares the process's V8 settings anyway.
 * - `child_process.fork()` defaults to `process.execArgv`, so a forked child inherits the flag
 *   unless it is given its own `execArgv`.
 */
export const NODE_MEMORY_FLAGS = Object.freeze(['--max-semi-space-size=2'])

const flagName = (argument) => argument.split('=')[0].replaceAll('_', '-')

/** `execArgv` with NODE_MEMORY_FLAGS in front, except a flag the caller already sets. */
export function withNodeMemoryFlags(execArgv = []) {
  const present = new Set(execArgv.map(flagName))
  return [...NODE_MEMORY_FLAGS.filter((flag) => !present.has(flagName(flag))), ...execArgv]
}

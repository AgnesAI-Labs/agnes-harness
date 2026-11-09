/**
 * V8 flags every AGH Node process starts with: the CLI (SEA `execArgv`, npm launcher), the daemon
 * and the worker (their spawn arguments).
 *
 * `--max-semi-space-size=2` caps V8's young generation. Without it each process keeps the large
 * young generation start-up grew committed (70-150 MB each). Measured on a 60-step `agh -p` run:
 * 265-318 MB less at peak over the three processes, worker CPU within run-to-run spread.
 *
 * Always on the command line, never through NODE_OPTIONS: that variable reaches every Node
 * program the task itself starts from a shell tool.
 */
export const NODE_MEMORY_FLAGS = Object.freeze(['--max-semi-space-size=2'])

const flagName = (argument) => argument.split('=')[0].replaceAll('_', '-')

/** `execArgv` with NODE_MEMORY_FLAGS in front, except a flag the caller already sets. */
export function withNodeMemoryFlags(execArgv = []) {
  const present = new Set(execArgv.map(flagName))
  return [...NODE_MEMORY_FLAGS.filter((flag) => !present.has(flagName(flag))), ...execArgv]
}

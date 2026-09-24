import type { ExecAdapter, ExecResult } from '../../src/adapters/exec.js'

type ExecOptions = Parameters<ExecAdapter['run']>[1]

// Some test runners execute through an Electron helper rather than a standalone node binary.
// process.execPath remains the authoritative executable, but that helper needs Node mode preserved.
// Keep the bridge to that one standard variable so the exec adapter's environment-isolation tests
// still prove that arbitrary host variables are not inherited.
const runtimeEnvironment = process.env.ELECTRON_RUN_AS_NODE
  ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }
  : {}

export function runTestNode(
  exec: Pick<ExecAdapter, 'run'>,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return exec.run([process.execPath, ...args], {
    ...options,
    env: { ...runtimeEnvironment, ...(options.env ?? {}) },
  })
}

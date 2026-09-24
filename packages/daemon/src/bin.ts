#!/usr/bin/env node
import { parseArgs } from './config.js'
import { runDaemonControl } from './supervisor/control.js'
import { runAgnesd } from './supervisor/supervisor.js'

/**
 * `agnesd`'s entry point. `runAgnesd` (Task 18, `./supervisor/supervisor.ts`) resolves the profile,
 * builds the daemon config, and starts the supervisor, keeping the process alive until SIGTERM/SIGINT.
 * Control commands deliberately stop before profile resolution: they only need the data directory's
 * strictly parsed owner record and Host's process-identity adapter.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  // Workers inherit this process's environment and resolve their home from it, as the packaged entry does.
  if (args.home !== undefined) process.env.AGH_HOME = args.home
  const controlExit = await runDaemonControl(args)
  if (controlExit !== null) {
    process.exitCode = controlExit
    return
  }
  await runAgnesd(args)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(2)
})

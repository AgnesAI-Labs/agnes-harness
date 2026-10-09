/**
 * Optional: builds the AgnesHub plugin and installs it into the running Agnes through the normal
 * package flow. Agnes works without it; install it only to connect devices.
 *
 *   pnpm --filter @agnes/mhs plugin:install
 *
 * The install shows a preview and asks for confirmation, which needs a terminal: without one the
 * install is cancelled. Like every package, it then starts
 * disabled; enable it in Web under Settings → Plugin management, which reviews its integrity and capabilities.
 * AGNES_CLI overrides the CLI entry (default: the source build, packages/cli/dist/local/agnes.mjs).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = process.env.AGNES_CLI ?? `${root}packages/cli/dist/local/agnes.mjs`
// Agnes accepts only relative file: sources and resolves them against the daemon's workspace, which
// is the repository root when the daemon was started from here (the CLI starts it on first use).
const plugin = 'file:./packages/mhs/plugin'

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./build-plugin.ts', import.meta.url))])
if (!existsSync(cli)) {
  console.error(`Agnes CLI not found at ${cli}. Build Agnes first (docs/guide/install.md) or set AGNES_CLI.`)
  process.exit(1)
}
run(process.execPath, [cli, 'install', plugin])
// A declined or unanswered confirmation still exits 0; the package list tells whether it went in.
const status = spawnSync(process.execPath, [cli, 'package', 'status'], { cwd: root, encoding: 'utf8' })
if (!status.stdout?.includes('@agnes/mhs@')) {
  console.error('Not installed. Run it again in a terminal and confirm the install.')
  process.exit(1)
}
console.log(
  [
    '',
    'Installed, disabled. To turn it on: Web → Settings → Plugin management → the switch of @agnes/mhs → Confirm enable.',
    'AgnesHub then listens on AGNES_HUB_LISTEN (default 127.0.0.1:4180). Start the web server with',
    'AGNES_HUB_ORIGIN=http://127.0.0.1:4180 so the workbench may connect to it.',
  ].join('\n'),
)

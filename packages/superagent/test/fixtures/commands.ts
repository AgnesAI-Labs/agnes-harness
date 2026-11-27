/**
 * Fake commands for tests on every platform: the command's logic is a Node script (`<path>.mjs`), and a launcher runs it
 * with the caller's arguments, as a shell or AGH finds it on PATH. On POSIX the launcher is `<path>`, a `#!/bin/sh`
 * script made executable; on Windows it is `<path>.cmd`, which PATHEXT finds. Each returns the launcher's path.
 */
import { chmodSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const windows = process.platform === 'win32'
const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url))
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** The launcher path a fake command at `path` has on this platform. */
export const commandPath = (path: string): string => (windows ? `${path}.cmd` : path)

/**
 * A command at `path` that runs `source`, a Node module, with the command's arguments in `process.argv.slice(2)` and its
 * exit code as the command's.
 */
export function nodeCommand(path: string, source: string): string {
  const script = `${path}.mjs`
  writeFileSync(script, source)
  const launcher = commandPath(path)
  if (windows) writeFileSync(launcher, `@"${process.execPath}" "${script}" %*\r\n`)
  else {
    writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`)
    chmodSync(launcher, 0o755)
  }
  return launcher
}

/**
 * The scripted fake `gh` (see `fake-gh.mjs`) at `path`, which names its script (a file, or inline JSON) and log itself,
 * since a session's command inherits only PATH and HOME. `before` runs first, such as to set `GH_CONFIG_DIR` or log a run.
 */
export function fakeGhCommand(
  path: string,
  options: { script: string; log?: string; before?: string },
): string {
  return nodeCommand(
    path,
    [
      options.before ?? '',
      `process.env.FAKE_GH_SCRIPT = ${JSON.stringify(options.script)}`,
      options.log === undefined ? '' : `process.env.FAKE_GH_LOG = ${JSON.stringify(options.log)}`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_GH).href)})`,
      '',
    ].join('\n'),
  )
}

/**
 * A prepare command that runs a fixture module with the known Node executable.
 */
export function nodePrepare(path: string, source: string): string {
  const script = `${path}.mjs`
  writeFileSync(script, source)
  const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`
  return windows
    ? `& ${psQuote(process.execPath)} ${psQuote(script)}`
    : `exec ${shellQuote(process.execPath)} ${shellQuote(script)}`
}

/** A command at `path` that prints `text` and exits with 0. */
export const printCommand = (path: string, text: string): string =>
  nodeCommand(path, `process.stdout.write(${JSON.stringify(`${text}\n`)})\n`)

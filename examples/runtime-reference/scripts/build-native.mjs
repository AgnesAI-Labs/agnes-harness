// Build the standalone execution reference without coupling installed Host packages to examples.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  const directory = fileURLToPath(new URL('../dist/native/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  execFileSync(
    'cc',
    [
      '-O2',
      '-Wall',
      '-Wextra',
      '-o',
      `${directory}execution-owner`,
      fileURLToPath(new URL('../native/execution-owner.c', import.meta.url)),
    ],
    { stdio: 'inherit' },
  )
}

#!/usr/bin/env node
// Compatibility entry delegates native products to their source owners.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
for (const owner of ['host-infrastructure', 'host-computer-use']) {
  execFileSync(
    process.execPath,
    [join(here, '..', '..', owner, 'scripts/build-native.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
}

// Run with: pnpm exec tsx tools/bench-native-realpath.mjs <installed-package-dir> [...]
// Add --js-realpath for a process-local control using the previous JS resolver.
// Read-only microbenchmark, not a CI gate. Use identical installed trees for before/after runs.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const control = process.argv.includes('--js-realpath')
const directories = process.argv
  .slice(2)
  .filter((arg) => arg !== '--js-realpath')
  .map((dir) => resolve(dir))
if (!directories.length) throw new Error('Pass installed example/package directories (not their parent)')
const original = fs.realpathSync
const originalNative = original.native
let jsCalls = 0
let nativeCalls = 0
fs.realpathSync = Object.assign(
  (...args) => {
    jsCalls++
    return original(...args)
  },
  {
    native: (...args) => {
      if (control) {
        jsCalls++
        return original(...args)
      }
      nativeCalls++
      return originalNative(...args)
    },
  },
)
syncBuiltinESMExports()
try {
  const { hashDirectory } = await import('../packages/package-manager/src/sources.ts')
  const rounds = []
  let expected
  for (let round = 0; round < 7; round++) {
    jsCalls = nativeCalls = 0
    const start = performance.now()
    const digests = directories.map((dir) => hashDirectory(dir))
    const ms = performance.now() - start
    if (expected && JSON.stringify(expected) !== JSON.stringify(digests))
      throw new Error('Package bytes changed during the benchmark')
    expected = digests
    rounds.push({ ms, jsCalls, nativeCalls })
  }
  console.log(
    JSON.stringify({ node: process.version, control, directories, digests: expected, rounds }, null, 2),
  )
} finally {
  fs.realpathSync = original
  syncBuiltinESMExports()
}

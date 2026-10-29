// Opt-in measurement only. Start the isolated daemon with NODE_OPTIONS="--import=<this file>"
// and AGH_VERIFICATION_TRACE=<absolute NDJSON file>. Workers inherit both. No product cache/hooks.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const trace = process.env.AGH_VERIFICATION_TRACE
if (trace) {
  let asyncEntry
  function record(path, asynchronous) {
    const directory = path instanceof URL ? fileURLToPath(path) : String(path)
    // Avoid a stack capture for every file in a tree. Include installed trees, runtime snapshots
    // and retained generation copies. Source/fetch staging is not part of query measurements.
    const normalized = directory.replaceAll('\\', '/')
    if (
      !/\/profiles\/[^/]+\/packages\/[^/]+$|\/\.runtime-snapshots\/sha256-[a-f0-9]+$|\/\.runtime-generations\/[^/]+\/\d+$/.test(
        normalized,
      )
    )
      return
    const caller = new Error().stack?.split('\n')[3] ?? ''
    if (!/\bhashDirectory(?:Async)?\b/.test(caller)) return
    // Async hashing rechecks the root after reading. Count its entry callsite once per walk.
    if (asynchronous) {
      asyncEntry ??= caller
      if (caller !== asyncEntry) return
    }
    fs.appendFileSync(
      trace,
      `${JSON.stringify({ pid: process.pid, asynchronous, directory, at: Date.now() })}\n`,
    )
  }
  const sync = fs.lstatSync
  fs.lstatSync = function (path, ...args) {
    record(path, false)
    return sync.call(this, path, ...args)
  }
  const asynchronous = fs.promises.lstat
  fs.promises.lstat = function (path, ...args) {
    record(path, true)
    return asynchronous.call(this, path, ...args)
  }
  syncBuiltinESMExports()
}

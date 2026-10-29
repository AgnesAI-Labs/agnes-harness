// Smoke-only preload: preserve the detached daemon's stderr in the isolated smoke directory.
import childProcess from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const spawn = childProcess.spawn
childProcess.spawn = (command, args, options) => {
  const log = process.env.AGH_SMOKE_DAEMON_STDERR
  if (!log || options?.stdio !== 'ignore' || !args?.some((arg) => basename(arg) === 'daemon.mjs'))
    return spawn(command, args, options)
  const fd = openSync(log, 'a', 0o600)
  try {
    return spawn(command, args, { ...options, stdio: ['ignore', 'ignore', fd] })
  } finally {
    closeSync(fd)
  }
}
syncBuiltinESMExports()

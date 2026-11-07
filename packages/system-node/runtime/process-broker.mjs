import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { windowsCommand } from './windows-command.mjs'

// No command is read from argv, environment or disk. Only our parent can release this gate.
const send = (message, after) => {
  if (!process.connected || !process.send) return process.exit(1)
  process.send(message, (error) => {
    if (error) process.exit(1)
    else after?.()
  })
}
const fail = (error) => send({ type: 'error', code: error.code ?? 'EIO' }, () => process.exit(1))
const unavailable = (message) => Object.assign(new Error(message), { code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
const native = () => {
  const binding = createRequire(import.meta.url)('@agnes/system-node/native')
  // A build with failure injection exists for tests only and never launches commands.
  if (binding.testFaults !== undefined) throw unavailable('Test build of the native artifact')
  return binding
}
const text = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0')

// A restricted target created but not resumed yet; it must never outlive this gate.
let suspended
process.on('disconnect', () => {
  suspended?.close()
  process.exit(1)
})

function run(message) {
  if (
    message?.type !== 'run' ||
    !Array.isArray(message.argv) ||
    message.argv.length === 0 ||
    message.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    typeof message.cwd !== 'string' ||
    !['script', 'argv-proxy'].includes(message.windowsBatch) ||
    !message.env ||
    typeof message.env !== 'object' ||
    Object.entries(message.env).some(
      ([key, value]) =>
        !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'),
    )
  )
    return process.exit(1)
  try {
    const binding = native()
    if (typeof binding.spawnInherited !== 'function') throw unavailable('Rebuild native artifact')
    const command = windowsCommand(message.argv, message.cwd, message.env, message.windowsBatch)
    const pid = binding.spawnInherited(
      command.argv,
      message.cwd,
      Object.entries(message.env).map(([key, value]) => `${key}=${value}`),
      (code, signal) => {
        const name =
          signal === 0
            ? null
            : Object.keys(constants.signals).find((key) => constants.signals[key] === signal)
        if (name === undefined) return send({ type: 'error', code: 'EIO' }, () => process.exit(1))
        send({ type: 'exit', code, signal: name }, () => process.exit(code ?? 1))
      },
      command.verbatim,
    )
    send({ type: 'started', pid })
  } catch (error) {
    fail(error)
  }
}

// The Host resolved and encoded the command. The target is created suspended inside this gate's
// Job, and the Host checks that membership itself before it sends `resume`.
function runRestricted(message) {
  if (
    !text(message.application) ||
    !text(message.commandLine) ||
    !text(message.cwd) ||
    typeof message.environment !== 'string' ||
    !Array.isArray(message.writeSids) ||
    message.writeSids.length > 2 ||
    !message.writeSids.every(text) ||
    !text(message.isolationSid) ||
    typeof message.readOnly !== 'boolean'
  )
    return process.exit(1)
  let target
  try {
    const binding = native()
    if (typeof binding.spawnRestricted !== 'function')
      throw unavailable('Rebuild native artifact for restricted launches')
    target = binding.spawnRestricted(
      message.application,
      message.commandLine,
      message.cwd,
      message.environment,
      message.writeSids,
      message.readOnly,
      message.isolationSid,
    )
  } catch (error) {
    return fail(error)
  }
  suspended = target
  process.once('message', (next) => {
    suspended = undefined
    if (next?.type !== 'resume') {
      target.close()
      return process.exit(1)
    }
    try {
      target.resume()
    } catch (error) {
      target.close()
      return fail(error)
    }
    send({ type: 'started', pid: target.pid })
    // Polled without blocking, so the gate keeps serving its IPC channel while the target runs.
    const poll = setInterval(() => {
      let code
      try {
        code = target.exitCode()
      } catch (error) {
        clearInterval(poll)
        return fail(error)
      }
      if (code === null) return
      clearInterval(poll)
      target.close()
      send({ type: 'exit', code, signal: null }, () => process.exit(0))
    }, 10)
  })
  send({ type: 'created', pid: target.pid, start: target.startTime })
}

process.once('message', (message) =>
  message?.type === 'run-restricted' ? runRestricted(message) : run(message),
)
send({ type: 'ready', version: 1 })

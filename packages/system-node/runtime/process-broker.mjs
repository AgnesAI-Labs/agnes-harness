import { createRequire } from 'node:module'

// Also used when an IPC send fails before the Host can observe the target identity.
let suspended
const abandon = () => {
  suspended?.close()
  process.exit(1)
}

// No command is read from argv, environment or disk. Only our parent can release this gate.
const send = (message, after) => {
  if (!process.connected || !process.send) return abandon()
  process.send(message, (error) => {
    if (error) abandon()
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

// A target created but not resumed yet must never outlive this gate.
process.on('disconnect', abandon)

// The Host resolved and encoded the command. The target is created suspended inside this gate's
// Job, and the Host checks that membership itself before it sends `resume`.
function run(message) {
  const restricted = message?.type === 'run-restricted'
  if (
    (!restricted && message?.type !== 'run') ||
    !text(message.application) ||
    !text(message.commandLine) ||
    !text(message.cwd) ||
    typeof message.environment !== 'string' ||
    (restricted &&
      (!Array.isArray(message.writeSids) ||
        message.writeSids.length > 2 ||
        !message.writeSids.every(text) ||
        !text(message.isolationSid) ||
        typeof message.readOnly !== 'boolean'))
  )
    return process.exit(1)
  let target
  try {
    const binding = native()
    const launch = restricted ? binding.spawnRestricted : binding.spawnSuspended
    if (typeof launch !== 'function') throw unavailable('Rebuild native artifact for suspended launches')
    target = launch(
      message.application,
      message.commandLine,
      message.cwd,
      message.environment,
      ...(restricted ? [message.writeSids, message.readOnly, message.isolationSid] : []),
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

process.once('message', run)
send({ type: 'ready', version: 1 })

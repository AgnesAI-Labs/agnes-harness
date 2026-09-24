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
process.on('disconnect', () => process.exit(1))
process.once('message', (message) => {
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
    const native = createRequire(import.meta.url)('@agnes/system-node/native')
    if (typeof native.spawnInherited !== 'function')
      throw Object.assign(new Error('Rebuild native artifact'), { code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
    const command = windowsCommand(message.argv, message.cwd, message.env, message.windowsBatch)
    const pid = native.spawnInherited(
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
    send({ type: 'error', code: error.code ?? 'EIO' }, () => process.exit(1))
  }
})
send({ type: 'ready', version: 1 })

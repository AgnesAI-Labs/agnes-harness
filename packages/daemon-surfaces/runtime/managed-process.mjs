// POSIX group guardian: plugin exit cannot orphan descendants, and parent IPC loss kills the group.
import { spawn } from 'node:child_process'

let stopping = false
const killGroup = (signal) => {
  try {
    process.kill(-process.pid, signal)
  } catch {
    process.exit(1)
  }
}
process.on('SIGTERM', () => {})
process.on('disconnect', () => killGroup('SIGKILL'))
process.on('message', (message) => {
  if (message?.type !== 'stop' || stopping) return
  stopping = true
  killGroup('SIGTERM')
})
const child = spawn(process.execPath, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'ignore',
  detached: false,
})
child.once('error', () => {
  process.send?.({ type: 'exit', code: 1, signal: null }, () => killGroup('SIGKILL'))
})
child.once('exit', (code, signal) => {
  process.send?.({ type: 'exit', code, signal }, () => killGroup('SIGKILL'))
})

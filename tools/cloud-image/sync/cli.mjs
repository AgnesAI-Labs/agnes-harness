import { request } from 'node:http'
import { join } from 'node:path'
import { privateJson } from './private-files.mjs'

const run = process.env.AGH_SYNC_DIR ?? '/run/agh-sync'
if (process.argv[2] === 'health') {
  let status
  try {
    status = await privateJson(join(run, 'health.json'))
  } catch {}
  const stale = status && Date.now() - Date.parse(status.observed_at) > 20000
  const value = status
    ? {
        backup_status: stale ? 'degraded' : status.backup_status,
        last_sync_at: status.last_sync_at,
        last_error: stale ? 'SYNC_STATUS_STALE' : status.last_error,
      }
    : { backup_status: 'starting', last_sync_at: null, last_error: null }
  process.stdout.write(`${JSON.stringify(value)}\n`)
} else if (process.argv[2] === 'stop') {
  await new Promise((resolve) => {
    const call = request(
      {
        socketPath: join(run, 'control.sock'),
        path: '/stop',
        method: 'POST',
        headers: { 'content-length': '0' },
      },
      (response) => {
        response.resume()
        response.on('end', () => {
          process.exitCode = response.statusCode === 200 ? 0 : 1
          resolve()
        })
      },
    )
    const timeout = setTimeout(() => call.destroy(), 29000)
    call.once('close', () => clearTimeout(timeout))
    call.once('error', () => {
      process.stderr.write('SYNC_STOP_UNAVAILABLE\n')
      process.exitCode = 1
      resolve()
    })
    call.end()
  })
} else {
  process.stderr.write('Expected health or stop\n')
  process.exitCode = 64
}

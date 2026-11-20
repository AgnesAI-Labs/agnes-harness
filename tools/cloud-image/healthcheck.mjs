import { join } from 'node:path'
import { privateJson } from './sync/private-files.mjs'
import { cloudKey } from './sync/runtime.mjs'

try {
  const state = await privateJson(join(process.env.AGH_SYNC_DIR ?? '/run/agh-sync', 'health.json'))
  if (state?.backup_status !== 'healthy' || Date.now() - Date.parse(state.observed_at) > 20000)
    throw Error('backup not ready')
  const key = await cloudKey({ home: process.env.AGH_HOME ?? '/data/agh' })
  const origin = 'http://127.0.0.1:8443',
    signal = AbortSignal.timeout(3000)
  const response = await fetch(`${origin}/_agnes/remote-frontend/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
    redirect: 'error',
    signal,
  })
  if (!response.ok) throw Error('auth not ready')
  const { token } = await response.json()
  if (typeof token !== 'string' || !/^[a-z0-9]+\.[\w-]+\.[\w-]+$/u.test(token))
    throw Error('invalid capability')
  const metadata = await fetch(`${origin}/_agnes/remote-access/${token}/_agnes/remote-frontend`, {
    redirect: 'error',
    signal,
  })
  if (!metadata.ok || (await metadata.json()).access !== 'key-owner') throw Error('publication not ready')
  process.stdout.write('AGH and backup ready\n')
} catch {
  process.stderr.write('AGH or backup not ready\n')
  process.exitCode = 1
}

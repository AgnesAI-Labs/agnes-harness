import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AssemblyLifetime } from '../../../packages/daemon/src/supervisor/assembly-lifetime.js'
import { acquireOwnerLock } from '../../../packages/daemon/src/supervisor/owner-lock.js'
import { watchWindowsStopRequest } from '../../../packages/daemon/src/supervisor/stop-request.js'
import { defaultProcessIdentity } from '../../../packages/host/src/index.js'
import { initializeHome } from '../../../packages/host-common/src/home-initialize.js'

// A real owned daemon generation and shutdown ladder; only its 21s draining resource is synthetic.
const home = process.argv[2]
if (!home) throw new Error('Isolated home required')
initializeHome(home)
const lock = await acquireOwnerLock(home, {
  socketPath: join(home, 'owned.sock'),
  processIdentity: defaultProcessIdentity,
})
const lifetime = new AssemblyLifetime(30_000)
lifetime.own({
  async drain() {
    await writeFile(join(home, 'drain-start'), String(Date.now()))
    await new Promise((done) => setTimeout(done, 21_000))
    await writeFile(join(home, 'drain-complete'), String(Date.now()))
  },
  dispose: () => lock.release(),
})
const keep = setInterval(() => {}, 1000)
let closing = false
const close = () => {
  if (closing) return
  closing = true
  void lifetime.close(30_000).then(
    () => {
      clearInterval(keep)
      process.exit(0)
    },
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
}
process.on('SIGTERM', close)
const windows = process.platform === 'win32' // guards-allow-platform: this owned process fixture uses the native graceful-stop channel.
if (windows) watchWindowsStopRequest(home, lock.owner, close)
process.stdout.write('READY\n')

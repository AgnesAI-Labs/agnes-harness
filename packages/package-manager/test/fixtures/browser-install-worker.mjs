import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLauncher } from './plugin/src/launcher.mjs'

const runtime = {
  enabled: true,
  epoch: 0,
  state: 'stopped',
  guard() {},
  notify() {
    if (this.state === 'preparing') return
    process.send({ state: this.state, error: this.error })
  },
}
let resume
const launcher = createLauncher({
  cacheRoot: join(import.meta.dirname, 'cache'),
  fetchArchive: async () => {
    appendFileSync(join(import.meta.dirname, 'downloads'), 'download\n')
    return {
      ok: true,
      body: (async function* () {
        const payload = readFileSync(join(import.meta.dirname, 'payload'))
        yield payload.subarray(0, 4)
        await new Promise((resolve) => {
          resume = resolve
          process.send({ downloading: true })
        })
        yield payload.subarray(4)
      })(),
    }
  },
})
process.on('message', (message) => {
  if (message === 'unknown-liveness')
    process.kill = () => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' })
    }
  if (message === 'prepare') launcher.prepare(runtime)
  if (message === 'continue') resume?.()
  if (message === 'replace-lock') {
    const info = JSON.parse(readFileSync(join(import.meta.dirname, 'plugin/src/browser-artifacts.json')))
    const artifact = Object.values(info)[0]
    writeFileSync(
      join(
        import.meta.dirname,
        'cache',
        artifact.revision + '-' + process.platform + '-' + process.arch + '.lock',
      ),
      JSON.stringify({ pid: process.pid, token: 'replacement' }),
    )
    resume?.()
  }
})
process.send({ ready: true })

// One command to try the world: fetches assets, starts a hub and the world, opens the browser.
//   pnpm --filter @agnes/mars-world start
// The hub is the dev hub of @agnes/mhs (type `help` in this terminal); Ctrl-C stops everything.
import { spawn } from 'node:child_process'

const root = new URL('.', import.meta.url).pathname
const hub = process.env.AGNES_HUB_LISTEN ?? '127.0.0.1:4180'
const children = [
  spawn('pnpm', ['--filter', '@agnes/mhs', 'dev', hub], { stdio: 'inherit', cwd: root }),
  spawn(process.execPath, [`${root}tools/dev.mjs`, '--port', '4200'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  }),
]
const url = `http://127.0.0.1:4200/?hub=ws://${hub}`
setTimeout(() => {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
  console.log(`opened ${url}`)
}, 4000)
const stop = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

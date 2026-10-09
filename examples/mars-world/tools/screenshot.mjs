// Takes screenshots of the world with headless Chrome over the DevTools protocol, waiting until the
// page says it is ready (assets loaded, a few frames rendered).
//   node tools/screenshot.mjs <out-dir> [base-url] [shot ...]
// Needs Google Chrome (or CHROME=/path/to/chrome) and a running `node tools/dev.mjs`.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [out = '.', base = 'http://127.0.0.1:4200/', ...shots] = process.argv.slice(2)
const names =
  shots.length > 0 ? shots : ['overview', 'airlock', 'greenhouse', 'rover', 'solar', 'comms', 'pad', 'ridge']
const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const port = 9333
mkdirSync(out, { recursive: true })
const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mars-world-'))}`,
    '--window-size=1600,900',
    '--hide-scrollbars',
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = list.find((t) => t.type === 'page')
  } catch {}
}
if (!target) throw new Error('Chrome did not start')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
let next = 0
const waiting = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  // Page errors are printed, so a scene that fails to load says why.
  if (msg.method === 'Runtime.exceptionThrown')
    console.error(
      `page error: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
    )
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
    console.error(`page console: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  waiting.get(msg.id)?.(msg)
  waiting.delete(msg.id)
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    next += 1
    waiting.set(next, resolve)
    ws.send(JSON.stringify({ id: next, method, params }))
  })

await send('Runtime.enable')
for (const name of names) {
  const url = new URL(base)
  url.searchParams.set('shot', name)
  await send('Page.navigate', { url: url.href })
  let ready = false
  for (let i = 0; i < 240 && !ready; i++) {
    await sleep(250)
    const r = await send('Runtime.evaluate', {
      expression: 'document.body && document.body.dataset.ready',
      returnByValue: true,
    })
    ready = r.result?.result?.value === '1'
  }
  await sleep(1500)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const path = join(out, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
  console.log(`${ready ? '' : '(not ready) '}${path}`)
}
ws.close()
proc.kill()

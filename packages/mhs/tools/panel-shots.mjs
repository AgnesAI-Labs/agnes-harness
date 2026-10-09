// Screenshots of the Devices panel page with headless Chrome over the DevTools protocol.
//   node tools/panel-shots.mjs <out-dir> <name>=<width>x<height>@<url> ...
// For example, with `pnpm dev-hub` running:
//   node tools/panel-shots.mjs shots dock=420x1200@http://127.0.0.1:4191/ robot=1100x1600@'http://127.0.0.1:4191/?device=robot-01'
// Needs Google Chrome (or CHROME=/path/to/chrome).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [out = '.', ...specs] = process.argv.slice(2)
const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const port = Number(process.env.PORT ?? 9334)
mkdirSync(out, { recursive: true })
const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mhs-panel-'))}`,
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
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
    if (msg.method === 'Runtime.exceptionThrown')
      console.error(
        `page error: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
      )
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
  for (const spec of specs) {
    const [, name, w, h, url] = spec.match(/^([^=]+)=(\d+)x(\d+)@(.+)$/) ?? []
    if (!name) throw new Error(`bad spec ${spec}`)
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(w),
      height: Number(h),
      deviceScaleFactor: 1,
      mobile: false,
    })
    await send('Page.navigate', { url })
    await sleep(3500)
    // EVAL: script to run before the shot, such as a click that opens something.
    if (process.env.EVAL) {
      await send('Runtime.evaluate', { expression: process.env.EVAL, awaitPromise: true })
      await sleep(1500)
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${name}.png`), Buffer.from(shot.result.data, 'base64'))
    console.log(`${name}.png`)
  }
  ws.close()
} finally {
  proc.kill()
}

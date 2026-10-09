// Clicks through every feature of the Devices panel page against the development hub, in headless Chrome,
// and checks the effect on the devices through AgnesHub itself.
//   pnpm build:plugin && pnpm dev-hub &   then   node tools/panel-smoke.mjs [http://127.0.0.1:4191]
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:4191'
const chrome =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const port = Number(process.env.PORT ?? 9348)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A hub client, to see what the page did to the devices.
function hubClient(url) {
  const ws = new WebSocket(url)
  let next = 0
  const waiting = new Map()
  const notes = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    } else if (m.method) notes.push(m)
  })
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      next += 1
      waiting.set(String(next), resolve)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: String(next), method, params }))
    })
  return {
    notes,
    open: () => new Promise((r) => ws.addEventListener('open', r, { once: true })),
    request,
    device: async (id) => (await request('hub/devices')).result.devices.find((d) => d.id === id),
    close: () => ws.close(),
  }
}

const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mhs-smoke-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
try {
  let target
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200)
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page',
      )
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let next = 0
  const waiting = new Map()
  const errors = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown')
      errors.push(m.params.exceptionDetails.exception?.description ?? '')
    waiting.get(m.id)?.(m)
    waiting.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      next += 1
      waiting.set(next, resolve)
      ws.send(JSON.stringify({ id: next, method, params }))
    })
  const js = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result
      ?.value
  const open = async (path, ms = 2500) => {
    await send('Page.navigate', { url: `${base}${path}` })
    await sleep(ms)
  }
  // Helpers inside the page.
  const helpers = `
    window.$$ = (s) => [...document.querySelectorAll(s)];
    window.byText = (s, text) => $$(s).find((e) => e.textContent.trim() === text || e.textContent.includes(text));
    window.click = (el) => { el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el?.click(); return !!el };
    window.toolBox = (name) => $$('.mhs-tool').find((t) => t.querySelector('.mhs-tool-name code')?.textContent === name);
    true`
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 1400,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const hub = hubClient(`${base.replace('http', 'ws')}/ws/hub`)
  await hub.open()
  await hub.request('hub/hello', { role: 'agent', client: { name: 'smoke' } })

  // Overview
  await open('/?lang=en')
  await js(`localStorage.setItem('mhs.view', 'devices'); location.reload(); true`)
  await sleep(2500)
  await js(helpers)
  check('overview shows a card per device', (await js(`$$('.mhs-card').length`)) === 4)
  check(
    'a card with a camera shows its picture',
    (await js(`$$('.mhs-card canvas.mhs-picture').some((c) => c.width > 1)`)) === true,
  )

  // Device page: picture, state, map, radar
  await open('/?device=robot-01&lang=en', 3500)
  await js(helpers)
  check('device page draws the camera', (await js(`$$('canvas.mhs-picture')[0]?.width > 1`)) === true)
  check('device page draws the radar', (await js(`$$('canvas.mhs-radar')[0]?.width > 1`)) === true)
  check('device page draws the map', (await js(`!!document.querySelector('.mhs-map canvas')`)) === true)
  check(
    'health and position in the header',
    (await js(`document.querySelector('.mhs-page-status').textContent`))?.includes('Position trusted'),
  )

  // A tool without parameters
  await js(`click(toolBox('dock').querySelector('.mhs-btn-primary'))`)
  await sleep(6500)
  const dock = await js(`toolBox('dock').querySelector('.mhs-job')?.textContent ?? ''`)
  check('runs a tool and shows its result', /Done/.test(dock), dock)

  // A tool with a ranged parameter
  await js(`click(toolBox('turn').querySelector('.mhs-tool-name'))`)
  await sleep(300)
  await js(
    `(() => { const r = toolBox('turn').querySelector('input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, '45'); r.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
  )
  await js(`click(toolBox('turn').querySelector('.mhs-btn-primary'))`)
  await sleep(2500)
  const turn = await js(`toolBox('turn').querySelector('.mhs-job')?.textContent ?? ''`)
  check('runs a tool with a slider argument', /Done/.test(turn) && /turned 45/.test(turn), turn)

  // Picking a map point for a tool
  await js(`click(toolBox('drive_to').querySelector('.mhs-tool-name'))`)
  await sleep(300)
  await js(`click(byText('.mhs-pick button', 'Pick on the map'))`)
  await sleep(300)
  await js(
    `(() => { const c = document.querySelector('.mhs-map canvas'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.6 })); return true })()`,
  )
  await sleep(300)
  const picked = await js(`toolBox('drive_to').querySelector('.mhs-pick code')?.textContent`)
  check('picks a map point into a parameter', /"x":/.test(picked ?? ''), picked)
  await js(`click(toolBox('drive_to').querySelector('.mhs-btn-primary'))`)
  await sleep(1500)
  const busy = await hub.device('robot-01')
  check('the job shows on the device while it runs', busy.jobs?.[0]?.tool === 'drive_to')
  check(
    'the page shows it running',
    /Running/.test((await js(`toolBox('drive_to').querySelector('.mhs-job')?.textContent ?? ''`)) ?? ''),
  )

  // Stop
  await js(`click(document.querySelector('.mhs-page-title .mhs-btn-danger'))`)
  await sleep(1200)
  const stopped = await js(`toolBox('drive_to').querySelector('.mhs-job')?.textContent ?? ''`)
  check('Stop interrupts the job', /Interrupted|stopped/.test(stopped), stopped)

  // Writable state
  const lightsBefore = (await hub.device('robot-01')).state.values.lights
  await js(
    `(() => { const f = $$('.mhs-field-writable').find((e) => e.textContent.includes('lights')); click(f.querySelector('.mhs-toggle')); return true })()`,
  )
  await sleep(800)
  check(
    'a writable switch reaches the device',
    (await hub.device('robot-01')).state.values.lights === !lightsBefore,
  )

  // Manual drive: hold the pad forward for a second
  const before = (await hub.device('robot-01')).position
  await js(
    `(() => { const p = document.querySelector('.mhs-pad'); const r = p.getBoundingClientRect(); const ev = (type, y) => p.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2, clientY: y })); p.setPointerCapture = () => {}; p.hasPointerCapture = () => true; ev('pointerdown', r.top + 4); window.__hold = setInterval(() => ev('pointermove', r.top + 4), 50); setTimeout(() => { clearInterval(window.__hold); ev('pointerup', r.top + 4) }, 1500); return true })()`,
  )
  await sleep(3500)
  const after = (await hub.device('robot-01')).position
  const manualSent = hub.notes.some(
    (n) => n.method === 'hub/traffic' && n.params.devices['robot-01']?.nerve_down > 0,
  )
  console.log(
    `      manual input reached AgnesHub: ${manualSent}; pad dot: ${await js(`document.querySelector('.mhs-pad-dot')?.style.top`)}`,
  )
  check(
    'the drive pad moves the device',
    Math.hypot((after.x ?? 0) - (before.x ?? 0), (after.y ?? 0) - (before.y ?? 0)) > 0.1,
    `${before.x},${before.y} -> ${after.x},${after.y}`,
  )

  // Source switch, audio, text
  await open('/?device=arm-01&lang=en', 2500)
  await js(helpers)
  await js(`click($$('.mhs-switch-row .mhs-toggle')[0])`)
  await sleep(800)
  check('a source switch turns the source off', (await hub.device('arm-01')).off?.includes('mic'))
  await js(`click($$('.mhs-switch-row .mhs-toggle')[0])`)
  await sleep(800)
  check('and back on', !(await hub.device('arm-01')).off?.includes('mic'))
  await js(`click(toolBox('pick').querySelector('.mhs-btn-primary'))`)
  await sleep(300)
  check(
    'a tool that asks for confirmation asks first',
    (await js(`!!toolBox('pick').querySelector('.mhs-confirm')`)) === true,
  )
  await js(`click(byText('.mhs-confirm button', 'Run it'))`)
  await sleep(2500)
  const picked2 = await js(`toolBox('pick').querySelector('.mhs-job')?.textContent ?? ''`)
  check('and runs once confirmed', /Done/.test(picked2), picked2)

  // Lamp: slider state
  await open('/?device=lamp-01&lang=en', 2000)
  await js(helpers)
  await js(
    `(() => { const f = $$('.mhs-field-writable').find((e) => e.textContent.includes('brightness')); const r = f.querySelector('input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, '20'); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return true })()`,
  )
  await sleep(800)
  check('a slider sets a number field', (await hub.device('lamp-01')).state.values.brightness === 20)

  // Sensors: values with alerts and trends
  await open('/?device=env-01&lang=en', 3000)
  await js(helpers)
  check('values source shows its fields', (await js(`$$('.mhs-widget .mhs-field').length`)) >= 3)

  // World view: the office map with its zones and landmarks, the robot and the installed sensor
  await open('/?lang=en', 1500)
  await js(`localStorage.setItem('mhs.view', 'world'); location.reload(); true`)
  await sleep(3000)
  await js(helpers)
  const world = await js(
    `({ maps: $$('.mhs-world-card').length, zones: $$('.mhs-world-zone').length, landmarks: $$('.mhs-world-landmark').length, devices: $$('.mhs-world-device').length, fixed: $$('.mhs-world-device[data-fixed]').length, floor: $$('.mhs-world-map canvas')[0]?.width > 1 })`,
  )
  check(
    'world view draws the map with its zones, landmarks and devices',
    world?.maps === 1 &&
      world.zones === 3 &&
      world.landmarks === 2 &&
      world.devices === 2 &&
      world.fixed === 1 &&
      world.floor,
    JSON.stringify(world),
  )
  await js(
    `$$('.mhs-world-device[data-fixed]')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`,
  )
  await sleep(800)
  check(
    'clicking a device on the map opens its page',
    /Room sensor/.test((await js(`document.querySelector('.mhs-page-title')?.textContent ?? ''`)) ?? ''),
  )

  // Flow view, language
  await open('/?lang=zh-CN', 1500)
  await js(`localStorage.setItem('mhs.view', 'flow'); location.reload(); true`)
  await sleep(3000)
  check(
    'flow view shows the hub and every device, and no brain on a page without a session',
    (await js(
      `document.querySelectorAll('.mhs-flow-device').length === 4 && !document.querySelector('.mhs-flow-brain') && !!document.querySelector('.mhs-flow-hub')`,
    )) === true,
  )
  check(
    'the page speaks Chinese',
    (await js(`document.querySelector('.mhs-panel-title').textContent`)) === '设备',
  )

  // Stop all
  await js(
    `(() => { const b = [...document.querySelectorAll('.mhs-head-actions .mhs-btn-danger')][0]; b.click(); return true })()`,
  )
  await sleep(800)
  check(
    'Stop all answers',
    !!(await js(`document.querySelector('.mhs-head-actions .mhs-note')?.textContent`)),
  )

  check('no page errors', errors.length === 0, errors.join(' | '))
  hub.close()
  ws.close()
} finally {
  proc.kill()
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

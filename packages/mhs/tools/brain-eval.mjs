// Sends tasks to the local Agnes brain, each in a fresh session, then checks the devices through
// AgnesHub. Uses the development hub's sample devices, connected to the hub the brain uses:
//   DEV_DEVICES_TO=ws://127.0.0.1:4180 pnpm --filter @agnes/mhs dev-hub &
//   node packages/mhs/tools/brain-eval.mjs [task...]
// AGNES_CLI: the CLI entry (default packages/cli/dist/local/agnes.mjs); AGNES_HUB: the hub (default
// ws://127.0.0.1:4180). Transcripts and report.json go to a temporary directory.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const REPO = new URL('../../../', import.meta.url).pathname
const CLI = process.env.AGNES_CLI ?? `${REPO}packages/cli/dist/local/agnes.mjs`
const HUB = process.env.AGNES_HUB ?? 'ws://127.0.0.1:4180'
const OUT = mkdtempSync(join(tmpdir(), 'brain-eval-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function hub() {
  const ws = new WebSocket(`${HUB}/ws/hub`)
  await new Promise((r) => ws.once('open', r))
  let n = 0
  const wait = new Map()
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString())
    if (m.id && wait.has(m.id)) {
      wait.get(m.id)(m.result ?? m.error)
      wait.delete(m.id)
    }
  })
  const req = (method, params = {}) =>
    new Promise((r) => {
      n += 1
      wait.set(String(n), r)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: String(n), method, params }))
    })
  await req('hub/hello', { role: 'agent', client: { name: 'eval' } })
  return {
    req,
    device: async (id) => (await req('hub/devices')).devices.find((d) => d.id === id),
    close: () => ws.close(),
  }
}

function run(name, prompt, timeoutMs) {
  const cwd = join(OUT, 'ws', `${name}-${Date.now().toString(36)}`)
  mkdirSync(cwd, { recursive: true })
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [CLI, '--cwd', cwd, '-p', prompt], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        out,
        ms: Date.now() - started,
        error: timedOut ? 'timeout' : code ? String(code) : undefined,
      })
    })
  })
}

async function callAndWait(h, device, tool, args) {
  await h.req('hub/call', { device, tool, arguments: args })
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    if (((await h.device(device)).jobs ?? []).length === 0) return
  }
}

const near = (p, x, y, r = 0.6) => p && Math.hypot(p.x - x, p.y - y) <= r

const TASKS = {
  lamp: {
    prompt: 'Turn on the desk lamp, set it to 30 % brightness and a cool colour.',
    timeout: 120_000,
    before: async (h) =>
      h.req('hub/set', { device: 'lamp-01', values: { on: false, brightness: 80, color: 'warm' } }),
    check: async (h) => {
      const v = (await h.device('lamp-01')).state.values
      return v.on === true && v.brightness === 30 && v.color === 'cool'
    },
  },
  sequence: {
    prompt:
      'Dim the desk lamp to 10 %, send the robot back to its dock, and then tell me the robot battery level.',
    timeout: 180_000,
    before: async (h) => {
      await h.req('hub/set', { device: 'lamp-01', values: { on: true, brightness: 70 } })
      await callAndWait(h, 'robot-01', 'drive_to', { target: { x: 6, y: 2 } })
    },
    check: async (h, out) => {
      const lamp = (await h.device('lamp-01')).state.values
      const robot = (await h.device('robot-01')).state.values
      return lamp.brightness === 10 && robot.mode === 'docked' && /\d+\s*%/.test(out)
    },
  },
  vague: {
    prompt: '把灯关了',
    timeout: 90_000,
    before: async (h) => h.req('hub/set', { device: 'lamp-01', values: { on: true } }),
    check: async (h) => (await h.device('lamp-01')).state.values.on === false,
  },
  stop: {
    prompt: '机器人别动了，马上停下。',
    timeout: 90_000,
    before: async (h) => {
      h.req('hub/call', { device: 'robot-01', tool: 'drive_to', arguments: { target: { x: 7, y: 5 } } })
      await sleep(1500)
    },
    check: async (h, out) =>
      ((await h.device('robot-01')).jobs ?? []).length === 0 && /stop_device/.test(out),
  },
  look: {
    prompt: 'What does the robot see in front of it right now? Describe the picture in one sentence.',
    timeout: 120_000,
    check: async (_h, out) => /read_device/.test(out) && !/E_STEP_FAILED|could not be read/.test(out),
  },
  drive: {
    before: async (h) => callAndWait(h, 'robot-01', 'drive_to', { target: { x: 1.5, y: 1.5 } }),
    prompt: '让机器人开到地图上 (5, 4) 那个点，到了以后用扬声器说一句"到了"。',
    timeout: 180_000,
    check: async (h, out) => near((await h.device('robot-01')).position, 5, 4) && /到了/.test(out),
  },
  co2: {
    prompt:
      'What is the CO2 level in the room right now, and is it OK? Answer in one sentence with the number.',
    timeout: 120_000,
    check: async (_h, out) => /\d{3,4}\s*ppm/i.test(out),
  },
  arm: {
    prompt: '机械臂先回零位，再在 x=0.3、y=0、z=0.1 的位置抓一个东西，告诉我抓到的重量。',
    timeout: 180_000,
    before: async (h) => h.req('hub/stop', {}),
    check: async (h, out) =>
      (await h.device('arm-01')).state.values.gripper === 'holding' && /0\.4/.test(out),
  },
  watch: {
    prompt:
      'When the room CO2 goes above 1500 ppm, switch the desk lamp off. Do not poll: set a watch and wait for it to wake you.',
    timeout: 300_000,
    before: async (h) => h.req('hub/set', { device: 'lamp-01', values: { on: true } }),
    // The answer comes after a wake-up, in a later turn; give it time.
    after: 150_000,
    check: async (h, out) =>
      (await h.device('lamp-01')).state.values.on === false && /watch_device/.test(out),
  },
  battery: {
    prompt: 'Which devices need attention right now, and why? List them briefly.',
    timeout: 120_000,
    check: async (_h, out) => /list_devices|read_device/.test(out),
  },
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TASKS)
const h = await hub()
const report = []
for (const name of names) {
  const task = TASKS[name]
  await task.before?.(h)
  await sleep(500)
  const r = await run(name, task.prompt, task.timeout)
  if (task.after) await sleep(task.after)
  const ok = await task.check(h, r.out).catch(() => false)
  const tools = [...r.out.matchAll(/- tool (\w+) · (\w+)/g)].map((m) => `${m[1]}:${m[2]}`)
  report.push({ name, ok, seconds: Math.round(r.ms / 1000), error: r.error, tools })
  writeFileSync(join(OUT, `${name}.log`), r.out)
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name} ${Math.round(r.ms / 1000)}s ${r.error ?? ''} tools=${tools.join(',')}`,
  )
}
h.close()
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`${report.filter((r) => r.ok).length}/${report.length} passed; transcripts in ${OUT}`)

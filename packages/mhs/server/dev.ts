/**
 * AgnesHub on the command line, to try devices by hand. Clients can connect to /ws/hub as well.
 *
 *   pnpm --filter @agnes/mhs dev [host:port] [--record session.jsonl]
 *
 * Listens on AGNES_HUB_LISTEN or 127.0.0.1:4180. --record session.jsonl writes the text messages of
 * each device as JSON Lines to its own file, session.<device>.jsonl, ready for
 * `python -m agnes_mhs.validate`. Type `help` for the commands.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createInterface } from 'node:readline'
import { North } from './north.js'
import { South } from './south.js'

const HELP = `devices                         list devices, their tools and sources
call <device> <tool> [json]     call a tool, e.g. call robot-01 move {"x": 0.5}
cancel <device> <call>          cancel one call
stop <device>                   stop all motion
pause|resume <device> <call>    pause or resume a pausable call
configure <device> <json>       e.g. configure robot-01 {"cam": {"on": true, "hz": 5}}
keyframe <device> <source>...   ask for keyframes
time <device>                   measure the device clock
manual <device> <json>          one manual message, e.g. manual robot-01 {"vx": 0.2}
state <device>                  the device's state (MHS 10.1)
read <device> [source]...       what a model reads: state and the newest data (hub-api.md 7.1)
set <device> <json>             change writable state, e.g. set robot-01 {"volume": 3}
latest <device> <source>        latest data message of a source
watch                           toggle printing incoming data (at most once a second per source)
quit`

const args = process.argv.slice(2)
const recordAt = args.indexOf('--record')
const record = recordAt >= 0 ? args[recordAt + 1] : undefined
const positional = args.filter((a, i) => !a.startsWith('--') && !(recordAt >= 0 && i === recordAt + 1))
const listen = positional[0] ?? process.env.AGNES_HUB_LISTEN ?? '127.0.0.1:4180'
const [host = '127.0.0.1', port = '4180'] = listen.split(':')

// One file per device: the validator follows one device's declarations through its session.
const recordFiles = new Set<string>()
const recordTo = (device: string, text: string) => {
  if (!record) return
  const ext = extname(record)
  const file = `${record.slice(0, record.length - ext.length)}.${device}${ext || '.jsonl'}`
  if (!recordFiles.has(file)) {
    recordFiles.add(file)
    writeFileSync(file, '')
    console.log(`recording ${device} to ${file}`)
  }
  appendFileSync(file, `${text}\n`)
}
const hub = new South({
  name: 'mhs-dev',
  log: (line) => console.log(`· ${line}`),
  ...(record ? { tap: recordTo } : {}),
})
const north = new North(hub, { name: 'mhs-dev', log: (line) => console.log(`· ${line}`) })
const address = await hub.listen(Number(port), host, north.handleUpgrade)
console.log(
  `listening on ws://${address.address}:${address.port}: devices on /ws/mhs and /ws/nerve, clients on /ws/hub; type help`,
)

let watching = false
const shown = new Map<string, number>()
hub.on(
  'data',
  (device: string, msg: { source: string; seq: number; t: number; data: unknown }, binary?: Buffer) => {
    if (!watching) return
    const key = `${device}/${msg.source}`
    if (Date.now() - (shown.get(key) ?? 0) < 1000) return
    shown.set(key, Date.now())
    const extra = binary ? ` +${binary.length} bytes` : ''
    console.log(`  ${key} #${msg.seq} ${JSON.stringify(msg.data).slice(0, 100)}${extra}`)
  },
)
hub.on('progress', (device: string, p: unknown) => console.log(`  ${device} progress ${JSON.stringify(p)}`))

const json = (text: string | undefined): unknown => (text ? JSON.parse(text) : {})
const show = (value: unknown) => console.log(JSON.stringify(value, null, 1))

async function run(line: string) {
  const [cmd, device = '', ...rest] = line.trim().split(/\s+/)
  const tail = line.trim().split(/\s+/).slice(3).join(' ')
  switch (cmd) {
    case undefined:
    case '':
      return
    case 'help':
      return console.log(HELP)
    case 'quit':
      north.close()
      await hub.close()
      process.exit(0)
      return
    case 'devices':
      for (const d of hub.devices()) {
        const tools = (d.description.tools ?? []).map((t) => t.name).join(', ')
        const sources = (d.description.sources ?? []).map((s) => `${s.id}:${s.kind}`).join(', ')
        console.log(`${d.id} (${d.description.device.kind}) ${d.available ? 'available' : 'not available'}`)
        console.log(`  tools: ${tools || '-'}\n  sources: ${sources || '-'}`)
      }
      return
    case 'call': {
      const handle = hub.call(device, rest[0] ?? '', json(tail))
      show(await handle.reply)
      return show(await handle.done)
    }
    case 'cancel':
      return show(await hub.cancel(device, rest[0] ?? ''))
    case 'stop':
      return show(await hub.stop(device))
    case 'pause':
      return show(await hub.pause(device, rest[0] ?? ''))
    case 'resume':
      return show(await hub.resume(device, rest[0] ?? ''))
    case 'configure':
      return show(await hub.configure(device, json(line.trim().split(/\s+/).slice(2).join(' ')) as never))
    case 'keyframe':
      return show(await hub.keyframe(device, rest))
    case 'time':
      return show(await hub.syncClock(device))
    case 'manual':
      return show(
        hub.manual(device, json(line.trim().split(/\s+/).slice(2).join(' ')) as Record<string, number>),
      )
    case 'state':
      return show(hub.state(device))
    case 'set':
      return show(
        await hub.set(device, json(line.trim().split(/\s+/).slice(2).join(' ')) as Record<string, unknown>),
      )
    case 'read': {
      const read = await north.read({ device, ...(rest.length > 0 ? { sources: rest } : {}) })
      for (const item of read.items) if (item.b64) item.b64 = `(${item.b64.length} base64 characters)`
      return show(read)
    }
    case 'latest': {
      const latest = hub.latest(device, rest[0] ?? '')
      return show(latest && { ...latest.msg, binary: latest.binary?.length })
    }
    case 'watch':
      watching = !watching
      return console.log(watching ? 'watching data' : 'not watching data')
    default:
      console.log(`unknown command ${cmd}; type help`)
  }
}

// Each line runs as soon as it is typed, so a stop gets through while a call is still running.
createInterface({ input: process.stdin }).on('line', (line) => {
  run(line).catch((e: Error) => console.log(`error: ${e.message}`))
})

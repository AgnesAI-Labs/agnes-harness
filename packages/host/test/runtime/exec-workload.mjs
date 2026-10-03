import { spawn } from 'node:child_process'
import { appendFileSync, openSync } from 'node:fs'

const [mode, trace] = process.argv.slice(2)
if (trace) appendFileSync(trace, `${process.pid}\n`)
if (mode === 'cpuMs') {
  for (;;) Math.sqrt(Math.random())
} else if (mode === 'memoryBytes') {
  const held = []
  setInterval(() => held.push(Buffer.alloc(1024 * 1024, 7)), 20)
} else if (mode === 'processes' || mode === 'tree' || mode === 'escape') {
  const script = new URL(import.meta.url).pathname
  const child = () =>
    spawn(process.execPath, [script, 'idle', trace], {
      detached: mode === 'escape',
      stdio: ['ignore', 'ignore', 'ignore', 3],
    })
  child()
  if (mode === 'processes') setInterval(child, 100)
  setInterval(() => {}, 100)
} else if (mode === 'openFiles') {
  setInterval(() => {
    try {
      openSync('/dev/null', 'r')
    } catch {}
  }, 20)
} else if (mode === 'outputBytes') {
  setInterval(() => {
    process.stdout.write('x'.repeat(256))
    process.stderr.write('y'.repeat(256))
  }, 10)
} else setInterval(() => {}, 100)

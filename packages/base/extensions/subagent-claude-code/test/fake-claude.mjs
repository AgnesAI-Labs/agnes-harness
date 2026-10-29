import { writeFileSync } from 'node:fs'

const marker = process.argv.find((arg) => arg.startsWith('--marker='))?.slice('--marker='.length)
if (marker) writeFileSync(marker, 'spawned')
const block = process.argv.includes('--block')
const task = process.argv.at(-1) ?? ''
if (!process.env.PATH) process.exit(1)
const leaked = process.env.CLAUDE_CHILD_SECRET
const text = leaked ? leaked : `echo:${task}`
process.stdout.write(
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`,
)
if (block) setInterval(() => undefined, 1000)
else {
  process.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`,
  )
}

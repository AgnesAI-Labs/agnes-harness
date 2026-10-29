import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline'

const block = process.argv.includes('--block')
if (!process.env.PATH) process.exit(1)
const rl = createInterface({ input: stdin })
let runId = 0

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`)
}

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocol: 'agnes.child-engine', version: 1 } })
    return
  }
  if (message.method === 'cancel') {
    if (runId) send({ jsonrpc: '2.0', id: runId, result: { status: 'cancelled' } })
    return
  }
  if (message.method === 'run') {
    runId = message.id
    const leaked = process.env.SDK_CHILD_SECRET
    send({
      jsonrpc: '2.0',
      method: 'text',
      params: { text: leaked ? leaked : `echo:${message.params.task}` },
    })
    if (!block) send({ jsonrpc: '2.0', id: message.id, result: { status: 'completed' } })
  }
})

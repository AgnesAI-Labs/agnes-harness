import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'

const rl = createInterface({ input: stdin })
let sessionId = 'child-session'
let workspace = false
let cancelled = false
let wait = null

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`)
}

function chunk(text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  })
}

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (wait && message.id === wait.id) {
    if (message.error) chunk('unknown-ok')
    else chunk(`perm:${message.result?.outcome?.optionId ?? message.result?.outcome?.outcome ?? 'none'}`)
    send({ jsonrpc: '2.0', id: wait.promptId, result: { stopReason: 'end_turn' } })
    wait = null
    return
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    return
  }
  if (message.method === '_agnes/v1/workspace.add') {
    workspace = true
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'session/new') {
    if (process.env.ACP_REQUIRE_WORKSPACE === '1' && !workspace) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'workspace required' } })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
    return
  }
  if (message.method === 'session/prompt') {
    const text = message.params?.prompt?.[0]?.text ?? ''
    if (text === 'permit') {
      wait = { id: 50, promptId: message.id }
      send({
        jsonrpc: '2.0',
        id: 50,
        method: 'session/request_permission',
        params: {
          sessionId,
          options: [
            { optionId: 'no', kind: 'reject_once' },
            { optionId: 'yes', kind: 'allow_once' },
          ],
        },
      })
      return
    }
    if (text === 'unknown') {
      wait = { id: 51, promptId: message.id }
      send({ jsonrpc: '2.0', id: 51, method: 'session/fs/read', params: {} })
      return
    }
    if (text === 'block') {
      const timer = setInterval(() => {
        if (!cancelled) return
        clearInterval(timer)
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'cancelled' } })
      }, 15)
      return
    }
    chunk(`echo:${text}:${process.env.ACP_CHILD_SECRET ?? 'hidden'}`)
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (message.method === 'session/cancel') cancelled = true
})

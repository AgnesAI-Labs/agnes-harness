/** Opt-in real-sandbox connection probe. Credentials enter only through the child environment. */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AdminCloudAuthorization } from '@agnes/protocol/gen/app-server'
import { createCloudGateway } from '../packages/cli/launch/cloud-gateway.js'
import { authorizeCloudConnection } from '../packages/daemon-admin/src/cloud-authorization.js'

function requireCheck(ok: unknown, name: string): asserts ok {
  if (!ok) throw Error(name)
}

const origin = process.env.AGH_PROBE_ORIGIN
const key = process.env.AGH_PROBE_KEY
requireCheck(origin && key && process.env.AGH_LLMSG_API_BASE_URL, 'real probe configuration is required')
const store = {
  read: async () => ({
    kind: 'api-key' as const,
    provider: 'generic' as const,
    label: 'isolated connection probe',
    value: key,
  }),
}
let authorization: AdminCloudAuthorization | undefined
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    authorization = await authorizeCloudConnection(
      {
        ...(process.env.AGH_PROBE_DISCOVERY === '1' ? {} : { origin }),
        credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111',
      },
      store,
    )
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}
requireCheck(authorization?.trafficToken, 'automatic platform credential and key exchange failed')
if (process.env.AGH_PROBE_DISCOVERY === '1') {
  requireCheck(authorization.origin === origin, 'Key-only discovery must resolve the owned existing sandbox')
  console.log('AGH_KEY_ONLY_DISCOVERY_REAL_PASS')
}
const gateway = createCloudGateway()
gateway.register(origin, authorization)
const server = createServer(async (request, response) => {
  if (!(await gateway.handleHttp(request, response))) response.writeHead(404).end()
})
server.on('upgrade', (request, socket, head) => {
  void gateway.handleUpgrade(request, socket, head).catch(() => socket.destroy())
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const prefix = '/_agnes/remote-access/' + authorization.token
let socket: WebSocket | undefined
let activeSessionId: string | undefined
try {
  const info = await fetch(`${local}${prefix}/_agnes/remote-frontend`)
  requireCheck(info.status === 200, 'capability HTTP through relay failed')
  const value = (await info.json()) as { access?: string }
  requireCheck(value.access === 'key-owner', 'application auth must remain key-owner')
  socket = new WebSocket(`${local.replace('http:', 'ws:')}${prefix}/_agnes/remote-frontend/ws`, ['agnes-v1'])
  const connection = socket
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('browser-compatible websocket timeout')), 12000)
    connection.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }
    connection.onerror = () => {
      clearTimeout(timeout)
      reject(Error('browser-compatible websocket failed'))
    }
  })
  let sequence = 0
  const notifications: {
    params?: { update?: { sessionUpdate?: string; content?: { text?: string }; status?: string } }
  }[] = []
  const rpc = (method: string, params: object) =>
    new Promise<{ result?: Record<string, unknown> }>((resolve, reject) => {
      const id = ++sequence
      const timeout = setTimeout(() => {
        connection.onmessage = null
        reject(Error(`real probe RPC deadline: ${method}`))
      }, 65000)
      connection.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id === id && !message.method) {
          clearTimeout(timeout)
          if (message.error) reject(Error(`real probe RPC rejected: ${method}`))
          else resolve(message)
        } else if (message.method && message.id !== undefined) {
          // Unattended verification never grants a tool extra permissions.
          connection.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Unattended probe cannot grant permissions' },
            }),
          )
        } else notifications.push(message)
      }
      connection.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  const result = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  requireCheck(result.result?.protocolVersion === 1, 'real backend protocol initialize failed')
  if (process.env.AGH_PROBE_CONVERSATION === '1') {
    const path = process.env.AGH_PROBE_READ_PATH
    const expected = process.env.AGH_PROBE_READ_EXPECTED
    requireCheck(path?.startsWith('/workspace/data/') && expected, 'owned read fixture required')
    const created = await rpc('session/new', {
      cwd: '/workspace/data',
      mcpServers: [],
      _meta: { 'ai.agnes.harness': { permission: 'default', sessionKey: `agnes:headless:${randomUUID()}` } },
    })
    const sessionId = created.result?.sessionId
    requireCheck(typeof sessionId === 'string', 'standard-permission session creation failed')
    activeSessionId = sessionId
    await rpc('_agnes/v1/session.setModel', {
      sessionId,
      slot: 'primary',
      route: 'agnes-cloud-primary',
      model: 'agnes-2-5-flash',
    })
    notifications.length = 0
    const turn = await rpc('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: `Use the read tool exactly once to read ${path}. Reply only with the exact text you read. Do not run commands or edit files.`,
        },
      ],
      _meta: { 'ai.agnes.harness': { maxSteps: 5, creditLimit: 0.1, timeLimitMs: 60000, unattended: true } },
    })
    requireCheck(turn.result?.stopReason === 'end_turn', 'real model turn did not finish')
    const updates = notifications.map((message) => message.params?.update)
    const text = updates
      .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
      .map((update) => update?.content?.text ?? '')
      .join('')
    requireCheck(text.trim() === expected, 'real model must return the owned read fixture')
    requireCheck(
      updates.some((update) => update?.sessionUpdate === 'tool_call_update' && update.status === 'completed'),
      'real tool execution was not completed',
    )
    console.log('AGH_RELAY_MODEL_AND_TOOL_REAL_PASS')
  }
  const denied = await fetch(`${process.env.AGH_LLMSG_API_BASE_URL}/llmsg/api/agh/connection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer agh_sk_wrong' },
    body: JSON.stringify({ sandbox_url: origin }),
  })
  requireCheck(
    denied.status === 401 && ((await denied.json()) as { code?: number }).code === 401,
    'wrong key must return the unified LLMSG unauthorized response',
  )
  const management = origin.replace('https://8443-', 'https://49983-') + '/health'
  const managed = await fetch(management, {
    headers: { 'e2b-traffic-access-token': authorization.trafficToken },
    redirect: 'error',
  })
  requireCheck(managed.status === 401 || managed.status === 403, 'business token must not access management')
  console.log('AGH_CONNECTION_REAL_PASS')
} finally {
  if (activeSessionId && socket?.readyState === WebSocket.OPEN)
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: activeSessionId } }),
    )
  socket?.close()
  gateway.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.AGNES_CUA_FAKE_MODE ?? 'normal'
const sessionToken = process.env.AGNES_CUA_FAKE_SESSION ?? 'missing-session'
const logFile = process.env.AGNES_CUA_FAKE_LOG
let callCount = 0
let captureScope = 'window'
const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function record(event, fields = {}) {
  if (logFile)
    appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, sessionToken, event, ...fields })}\n`)
}

if (mode === 'grandchild') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  grandchild.unref()
  record('grandchild', { grandchildPid: grandchild.pid })
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function handle(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return
  record(message.method)
  if (message.method === 'initialize') {
    const initialized = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'agnes-fake-cua-driver', version: '0.28.1-test' },
      ...(mode === 'real-contract' ? {} : { capabilityVersion: '1' }),
    }
    if (mode === 'slow-init') setTimeout(() => result(message.id, initialized), 40)
    // Logs the request and never answers it, so the startup deadline is sure to pass.
    else if (mode === 'silent-init') return
    else result(message.id, initialized)
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    result(message.id, {
      ...(mode === 'real-contract' ? { capability_version: '1' } : {}),
      tools: [
        {
          name: 'capture',
          description: 'fake capture',
          inputSchema: {
            type: 'object',
            properties: {
              mode: { enum: ['som', 'vision', 'ax'] },
              target: { type: 'string' },
              generation: { type: 'integer', minimum: 1 },
              app: { type: 'string' },
              pid: { type: 'integer', minimum: 1 },
              window_id: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
          capabilities: ['capture', 'structured-content'],
          ...(mode === 'real-contract' ? {} : { capabilityVersion: '1' }),
        },
        {
          name: 'list_apps',
          description: 'fake application inventory',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          capabilities: ['observe', 'structured-content'],
          ...(mode === 'real-contract' ? {} : { capabilityVersion: '1' }),
        },
        {
          name: 'list_windows',
          description: 'fake window inventory',
          inputSchema: {
            type: 'object',
            properties: { pid: { type: 'integer', minimum: 1 } },
            additionalProperties: false,
          },
          capabilities: ['observe', 'structured-content'],
          ...(mode === 'real-contract' ? {} : { capabilityVersion: '1' }),
        },
        {
          name: 'get_capture_scope',
          description: 'fake screen compound baseline read',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          capabilities: ['screen-compound'],
          ...(mode === 'real-contract' ? {} : { capabilityVersion: '1' }),
        },
        {
          name: 'set_capture_scope',
          description: 'fake screen compound config mutation',
          inputSchema: {
            type: 'object',
            properties: { scope: { enum: ['window', 'screen'] } },
            required: ['scope'],
            additionalProperties: false,
          },
          capabilities: ['screen-compound'],
          ...(mode === 'real-contract' ? {} : { capabilityVersion: '1' }),
        },
      ],
    })
    if (mode === 'catalog-drift')
      setTimeout(
        () =>
          send({
            jsonrpc: '2.0',
            method: 'notifications/tools/list_changed',
            params: { resetReason: 'session_end' },
          }),
        10,
      )
    if (mode === 'broken-pipe')
      setTimeout(() => {
        process.stdin.on('error', () => undefined)
        input.close()
        closeSync(0)
        record('stdin_closed')
        setInterval(() => undefined, 1000)
      }, 10)
    return
  }
  if (message.method !== 'tools/call') return
  callCount += 1
  if (mode === 'hang-call') return
  if (mode === 'broken-frame') {
    process.stdout.write('{not-json}\n')
    return
  }
  if (mode === 'broken-envelope') {
    send({ jsonrpc: '2.0', id: message.id })
    return
  }
  if (mode === 'broken-utf8') {
    process.stdout.write(Buffer.from([0xff, 0x0a]))
    return
  }
  if (mode === 'empty-frame') {
    process.stdout.write('\n')
    return
  }
  if (mode === 'oversized-buffer') {
    process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1))
    return
  }
  if (mode === 'oversized-frame') {
    process.stdout.write(`${'x'.repeat(8 * 1024 * 1024 + 1)}\n`)
    return
  }
  if (mode === 'normal-large-frame') {
    result(message.id, {
      content: [{ type: 'text', text: 'x'.repeat(6 * 1024 * 1024) }],
      structuredContent: { ok: true },
      isError: false,
    })
    return
  }
  if (mode === 'rpc-error' && callCount === 1) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: 'expected fake error' } })
    return
  }
  if (mode === 'eof-call') {
    process.stdout.end()
    setInterval(() => undefined, 1000)
    return
  }
  const name = message.params?.name
  const args = message.params?.arguments ?? {}
  record('tool', { name, args, captureScope })
  if (name === 'get_capture_scope') {
    if (mode === 'screen-get-fail') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: 'fake get scope failure' } })
      return
    }
    result(message.id, { content: [], structuredContent: { scope: captureScope }, isError: false })
    return
  }
  if (name === 'set_capture_scope') {
    if (
      (mode === 'screen-set-fail' && args.scope === 'screen') ||
      (mode === 'screen-restore-fail' && args.scope === 'window')
    ) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: 'fake set scope failure' } })
      return
    }
    captureScope = args.scope
    result(message.id, { content: [], structuredContent: { scope: captureScope }, isError: false })
    return
  }
  if (name === 'list_apps') {
    result(message.id, {
      content: [{ type: 'text', text: '1 application' }],
      structuredContent: {
        apps: [{ app: 'Fake Notes', pid: 4101, frontmost: true }],
        sessionToken,
      },
      isError: false,
    })
    return
  }
  if (name === 'list_windows') {
    result(message.id, {
      content: [{ type: 'text', text: '1 window' }],
      structuredContent: {
        windows: [
          {
            app: 'Fake Notes',
            pid: args.pid ?? 4101,
            window_id: 5101,
            title: 'Fake document',
            bounds: [20, 30, 640, 480],
          },
        ],
        sessionToken,
      },
      isError: false,
    })
    return
  }
  if (mode === 'screen-capture-fail' && args.app === 'screen') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: 'fake screen capture failure' } })
    return
  }
  const captureMode = args.mode ?? 'som'
  const captureContent = [{ type: 'text', text: `capture:${sessionToken}` }]
  if (captureMode !== 'ax') captureContent.push({ type: 'image', data: onePixelPng, mimeType: 'image/png' })
  result(message.id, {
    content: captureContent,
    structuredContent: {
      sessionToken,
      pid: process.pid,
      mode: captureMode,
      width: captureMode === 'ax' ? 0 : 1,
      height: captureMode === 'ax' ? 0 : 1,
      target: {
        app: args.app ?? 'Fake Notes',
        ...(args.app === 'screen' || args.app === 'desktop' ? {} : { pid: args.pid ?? 4101 }),
        ...(args.app === 'screen' || args.app === 'desktop' ? {} : { window_id: args.window_id ?? 5101 }),
        snapshot_id: `fake-${sessionToken}-${callCount}`,
        requested: args.target ?? null,
      },
      elements: [
        {
          index: 1,
          role: 'button',
          label: 'Save',
          bounds: [100, 120, 80, 24],
          element_token: `element-${sessionToken}-${callCount}`,
        },
      ],
      generationEcho: args.generation ?? null,
      inheritedAgnesSecret: process.env.AGNES_SECRET_FAKE_DRIVER_TEST !== undefined,
      inheritedProviderKey: process.env.DEEPSEEK_API_KEY !== undefined,
    },
    isError: false,
  })
}

const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
input.on('line', (line) => {
  try {
    handle(JSON.parse(line))
  } catch {
    process.stdout.write('{broken-request}\n')
  }
})
input.on('close', () => {
  record('close')
  if (mode === 'broken-pipe') {
    setInterval(() => undefined, 1000)
    return
  }
  process.exit(0)
})

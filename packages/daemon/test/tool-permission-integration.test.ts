import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presets as basePresets, seams as baseSeams } from '@agnes/base'
import { presets as codePresets, operations, PRESET_NAMES } from '@agnes/code'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, memoryJournal, TransportClosed } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { createLocalEndpoint, createPrompterBridge } from '../src/local/index.js'
import { bindConnection } from '../src/supervisor/connection.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { testWorkspaceCatalog } from './host.js'
import { localSdkTransport, localSocketPath } from './local-socket-path.js'

it.each(['allow', 'reject', 'disconnect'])('real write approval over SDK/daemon: %s', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-approve-wire-'))
  const bridge = createPrompterBridge()
  const { host } = await createTestHost({
    dataDir: root,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: {
      '@agnes/base': { seams: { approval: baseSeams.approval }, presets: basePresets },
      '@agnes/code': { operations },
    },
    presets: {
      ...codePresets,
      standard: { ...codePresets.standard, name: 'standard', approval: { command_policy: [] } },
    },
    allowed: [...PRESET_NAMES],
    prompter: (request, options) => bridge.prompter.ask(request, options),
    script: [
      [
        {
          type: 'toolcall_end',
          via: 'native',
          call: {
            toolUseId: '',
            name: 'write',
            args: { path: 'receipt.txt', content: 'approved' },
            ordinal: 0,
          },
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [
        { type: 'text_delta', delta: 'finished' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  const workspaces = await testWorkspaceCatalog(root)
  let closed: Promise<void> | undefined
  const path = localSocketPath(join(root, 'daemon', 'approval.sock'))
  const server = await listenUnix(path, (socket) => {
    const ep = createLocalEndpoint(host, { pollMs: 5, workspaces })
    bridge.bind(ep.prompter)
    closed = bindConnection(socket, ep, { onClose() {} }).closed
  })
  const client = createClient({ journal: memoryJournal(), transport: localSdkTransport(path) })
  try {
    const session = await client.session.new({ cwd: root })
    const seen: unknown[] = []
    session.listeners.add((method, params) => seen.push({ method, params }))
    let asked!: () => void
    const question = new Promise<void>((resolve) => {
      asked = resolve
    })
    let count = 0
    let title: unknown
    let rawInput: unknown
    let late!: (value: { verdict: 'allowed-once' }) => void
    session.onPermissionRequest(async (request) => {
      count++
      title = request.toolCall.title
      rawInput = request.toolCall.rawInput
      asked()
      if (mode === 'disconnect')
        return new Promise((resolve) => {
          late = resolve
        })
      return { verdict: mode === 'allow' ? 'allowed-once' : 'rejected' }
    })
    const result = session.prompt('run the command').catch((error: unknown) => error)
    await Promise.race([
      question,
      result.then((value) => {
        throw new Error(`turn ended before approval: ${JSON.stringify(value)}`)
      }),
    ])
    expect(title).toBe('write {"content":"approved","path":"receipt.txt"}')
    expect(rawInput).toEqual({ content: 'approved', path: 'receipt.txt' })
    if (mode === 'disconnect') await client.close()
    const outcome = await result
    if (mode === 'disconnect') {
      expect(outcome).toBeInstanceOf(TransportClosed)
      await closed
      late({ verdict: 'allowed-once' })
    } else expect(outcome).toMatchObject({ reason: 'completed' })
    expect(count).toBe(1)
    const file = join(root, 'receipt.txt')
    if (mode === 'allow') {
      expect(existsSync(file), JSON.stringify(seen)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('approved')
    } else expect(existsSync(file)).toBe(false)
  } finally {
    await client.close()
    await server.close()
    await closed
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

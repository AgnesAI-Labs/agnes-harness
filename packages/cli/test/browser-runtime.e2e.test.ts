import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { createExec } from '@agnes/host-infrastructure/adapters/exec'
import { expect, it } from 'vitest'
import { prepareBrowserRuntime } from '../tools/browser-runtime.js'

const { BrowserEngine } = await import(
  new URL('../../package-manager/bundled-plugins/browser-runtime/src/engine.mjs', import.meta.url).href
)
const { BrowserRuntime } = await import(
  new URL('../../package-manager/bundled-plugins/browser-runtime/src/runtime.mjs', import.meta.url).href
)

// Opt-in because first use downloads Chrome for Testing. Run identically on Windows and both Mac architectures.
it.runIf(process.env.AGNES_BROWSER_E2E === '1')(
  'renders a real local project, fills Chinese text, streams the same page, and closes only owned browsers',
  async () => {
    await prepareBrowserRuntime()
    const exec = createExec(process.platform === 'win32' ? { windowsNodeExecutable: process.execPath } : {})
    const runtime = new BrowserRuntime(new BrowserEngine())
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Owned browser fixture</title><h1>AGH 项目预览</h1><label>Name<input id="name"></label><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test address')
    const url = `http://127.0.0.1:${address.port}`
    const signal = AbortSignal.timeout(150000)
    const ctx = (key: string) => ({
      session: { key, lane: 'main' },
      cwd: process.cwd(),
      signal,
      timeoutMs: 30000,
      // This fixture grants its installer cache, just as it grants the local HTTP fixture.
      fs: {
        create: async (path: string, bytes: Uint8Array) => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
        },
      },
      sandbox: {
        openProcess: ({
          argv,
          ...options
        }: {
          argv: string[]
          cwd: string
          env?: Record<string, string>
        }) => {
          if (!exec.openProcess) throw new Error('Missing Host process service')
          return exec.openProcess(argv, options)
        },
      },
    })
    let stopStream: (() => void) | undefined
    try {
      await runtime.execute({ action: 'open', url }, ctx('one'))
      const snapshot = await runtime.execute({ action: 'snapshot' }, ctx('one'))
      const serialized = JSON.stringify(snapshot)
      expect(serialized).toContain('Name')
      const refs = Object.entries(snapshot.refs as Record<string, { role: string }>)
      const field = refs.find(([, ref]) => ref.role === 'textbox')?.[0]
      const button = refs.find(([, ref]) => ref.role === 'button')?.[0]
      if (!field || !button) throw new Error(`Missing fixture references: ${serialized}`)
      await runtime.execute({ action: 'fill', ref: `@${field}`, text: '你好 --cdp 9222' }, ctx('one'))
      await runtime.execute({ action: 'click', ref: `@${button}` }, ctx('one'))
      expect(JSON.stringify(await runtime.execute({ action: 'snapshot' }, ctx('one')))).toContain(
        '你好 --cdp 9222',
      )
      const screenshot = await runtime.execute({ action: 'screenshot' }, ctx('one'))
      expect(Buffer.from(screenshot.bytes).subarray(1, 4).toString()).toBe('PNG')
      const actor = { kind: 'human', id: 'test-owner' }
      let disconnect: (() => void) | undefined
      const lease = runtime.observe('one', actor)
      const frame = new Promise<string>((resolve) => {
        runtime.watch(lease.ticket, {
          actor,
          signal,
          stream: {
            send: (frame: { type: string; data?: string }) => {
              if (frame.type === 'frame' && frame.data) resolve(frame.data)
              return 'accepted'
            },
            close: () => {},
            onDisconnect: (fn: () => void) => {
              disconnect = fn
              return () => {}
            },
          },
        })
      })
      stopStream = () => disconnect?.()
      expect(
        Buffer.from(await frame, 'base64')
          .subarray(0, 2)
          .toString('hex'),
      ).toBe('ffd8')
      await runtime.execute({ action: 'open', url }, ctx('two'))
      expect(JSON.stringify(await runtime.execute({ action: 'snapshot' }, ctx('two')))).not.toContain(
        '你好 --cdp 9222',
      )
      await runtime.closeSession(ctx('one').session)
      expect(JSON.stringify(await runtime.execute({ action: 'snapshot' }, ctx('two')))).toContain('Name')
      expect(runtime.observe('one', actor)).toEqual({ state: 'idle' })
    } finally {
      stopStream?.()
      await runtime.dispose()
      await exec.killAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  180000,
)

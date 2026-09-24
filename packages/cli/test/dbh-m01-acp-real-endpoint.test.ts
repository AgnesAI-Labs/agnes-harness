// Deep Bug Hunt M-01, second independent dynamic source (adversarial-tester, group A). Test-only.
// Real Host (createTestHost + slowProvider), real daemon LocalEndpoint (bootLocal), production
// main() --mode acp -> runAcp -> pump. Asserts the CORRECT behaviour; failure reproduces the defect.
// Oracle: cli-package design :126/:149 (a cancel stops the in-flight turn), ACP CancelNotification
// semantics (the turn ends with stopReason "cancelled"), and the differential control below: the very
// same endpoint honours session/cancel mid-turn when frames are dispatched concurrently.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import type { JsonRpcMessage } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { bootLocal } from '../src/boot/local.js'
import { slowProvider, TEST_LOCK, testDeps } from './boot-host.js'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dbh-m01-'))
  tmp.push(d)
  return d
}

const DELAY_MS = 6_000
const CANCEL_BUDGET_MS = 2_000

type Wire = {
  id?: number
  method?: string
  result?: { sessionId?: string; stopReason?: string }
  error?: unknown
}

function turnGate() {
  let announce: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    announce = resolve
  })
  return { started, announce }
}

describe('DBH M-01 real endpoint', () => {
  it('differential control: the real endpoint ends an in-flight prompt as cancelled when session/cancel is dispatched concurrently', async () => {
    const dir = scratch()
    const gate = turnGate()
    const booted = await bootLocal(
      parseArgs(['--mode', 'acp']),
      testDeps(dir, {
        createHostImpl: async () =>
          (await createTestHost({ dataDir: dir, provider: slowProvider(DELAY_MS, gate.announce) })).host,
      }),
    )
    const ep = booted.endpoint
    if (!ep) throw new Error('no endpoint')
    void (async () => {
      for await (const _ of ep.notifications) void _
    })()
    try {
      const init = (await ep.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      } as JsonRpcMessage)) as Wire
      expect(init.error).toBeUndefined()
      const created = (await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: dir, mcpServers: [] },
      } as JsonRpcMessage)) as Wire
      const sessionId = created.result?.sessionId
      expect(sessionId, JSON.stringify(created)).toBeTypeOf('string')
      const prompt = ep.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'take your time' }] },
      } as JsonRpcMessage) as Promise<Wire>
      await gate.started
      const t0 = performance.now()
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } } as JsonRpcMessage)
      const answer = await prompt
      const elapsed = performance.now() - t0
      expect(
        { stopReason: answer.result?.stopReason, fast: elapsed < CANCEL_BUDGET_MS },
        `elapsed=${elapsed.toFixed(0)}`,
      ).toEqual({
        stopReason: 'cancelled',
        fast: true,
      })
    } finally {
      await booted.close()
    }
  }, 30_000)

  it('main --mode acp: session/cancel written while a prompt is in flight cancels the turn within 2s', async () => {
    const dir = scratch()
    const gate = turnGate()
    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const stdout = Object.assign(new PassThrough(), { isTTY: false })
    const stderr = Object.assign(new PassThrough(), { isTTY: false })
    let buffer = ''
    const messages: Wire[] = []
    stdout.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        messages.push(JSON.parse(buffer.slice(0, nl)) as Wire)
        buffer = buffer.slice(nl + 1)
      }
    })
    let err = ''
    stderr.on('data', (chunk: Buffer) => {
      err += String(chunk)
    })
    const exits: number[] = []
    const io: MainIO = {
      env: { AGH_HOME: dir },
      stdin,
      stdout,
      stderr,
      cwd: dir,
      agnesVersion: '9.9.9',
      exit: (code) => exits.push(code),
      signals: new EventEmitter(),
    }
    const run = main(['--mode', 'acp'], io, {
      lock: TEST_LOCK,
      createHostImpl: async () =>
        (await createTestHost({ dataDir: dir, provider: slowProvider(DELAY_MS, gate.announce) })).host,
    })
    const reply = async (id: number, ms: number): Promise<Wire> => {
      const deadline = performance.now() + ms
      for (;;) {
        const found = messages.find((m) => m.id === id && m.method === undefined)
        if (found) return found
        if (performance.now() > deadline) throw new Error(`no reply to ${id} in ${ms}ms; stderr=${err}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    const send = (message: Record<string, unknown>): void => {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    }
    try {
      send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
      expect((await reply(1, 10_000)).error).toBeUndefined()
      send({ id: 2, method: 'session/new', params: { cwd: dir, mcpServers: [] } })
      const sessionId = (await reply(2, 10_000)).result?.sessionId
      expect(sessionId).toBeTypeOf('string')
      send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'take your time' }] },
      })
      await gate.started
      const t0 = performance.now()
      send({ method: 'session/cancel', params: { sessionId } })
      const answer = await reply(3, DELAY_MS + 6_000)
      const elapsed = performance.now() - t0
      expect(
        { stopReason: answer.result?.stopReason, fast: elapsed < CANCEL_BUDGET_MS },
        `elapsed=${elapsed.toFixed(0)}ms answer=${JSON.stringify(answer)}`,
      ).toEqual({ stopReason: 'cancelled', fast: true })
    } finally {
      stdin.end()
      await run
    }
  }, 40_000)
})

/** Manual browser benchmark, not a CI gate. Build @agnes/cli build:local first, then run with tsx.
 * Uses only a fresh synthetic home and an ephemeral loopback port. --events 20000 --runs 3
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defaultIds, type PreparedEvent, prepareIntegrity, verifyLedger } from '@agnes/core'
import { createSqliteStorage } from '@agnes/host'
import { chromium, expect } from '@playwright/test'
import { isolatedRuntime } from './e2e-web/runtime.js'

const number = (flag: string, fallback: number) => {
  const index = process.argv.indexOf(flag)
  const value = index < 0 ? fallback : Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${flag}`)
  return value
}
const events = number('--events', 20_000)
const runs = number('--runs', 3)
const eventIds = defaultIds()
const runtime = await isolatedRuntime()
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AGH_CHROMIUM_PATH ? { executablePath: process.env.AGH_CHROMIUM_PATH } : {}),
})
try {
  await runtime.start()
  const client = await runtime.connect()
  const ids: string[] = []
  const turns = new Map<string, number>()
  for (const label of ['A', 'B']) {
    const session = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'full-access',
    })
    await session.prompt('Initialize synthetic benchmark session', { signal: AbortSignal.timeout(20_000) })
    turns.set(session.id, (await session.projectUI()).turns.at(-1)?.turn ?? 0)
    await client.session.rename(session.id, `Opening benchmark ${label}`)
    ids.push(session.id)
  }
  await client.close()
  await runtime.cli(['daemon', 'stop'])
  const storage = createSqliteStorage({
    file: join(runtime.home, 'data/sessions.db'),
    tablesDir: join(runtime.home, 'data/tables'),
  })
  try {
    for (const key of ids) {
      const writerRunId = randomUUID()
      const opened = await storage.open(key, { writerRunId, ttlMs: 3_600_000 })
      let state = await verifyLedger(storage, key, opened.lastSeq)
      const initial = state.lastSeq
      while (state.lastSeq < initial + events) {
        const batch: PreparedEvent[] = []
        for (let i = 0; i < Math.min(500, initial + events - state.lastSeq); i++) {
          const seq = state.lastSeq + i + 1
          const position = (seq - initial - 1) % 4
          const turn = Math.floor((seq - initial - 1) / 4) + 1 + (turns.get(key) ?? 0)
          const type = ['turn/start', 'user/message', 'assistant/message', 'turn/end'][position]!
          batch.push({
            id: eventIds.ulid(),
            ts: '2026-10-19T00:00:00.000Z',
            lane: 'main',
            v: 1,
            actor: { id: 'bench', org: 'local', role: 'owner', deptPath: [], attrs: {} },
            origin: 'principal',
            trust: 'trusted',
            type,
            data:
              position === 0
                ? { turn, trigger: 'prompt' }
                : position === 3
                  ? { reason: 'completed', lastAssistantSeq: seq - 1 }
                  : {
                      content: [{ type: 'text', text: `Synthetic ${key} message ${turn}` }],
                      ...(position === 2 ? { stopReason: 'end_turn' } : {}),
                    },
          })
        }
        const next = prepareIntegrity(
          key,
          batch.map((event, i) => ({ ...event, seq: state.lastSeq + i + 1 })),
          state,
        )
        await storage.commit(key, {
          events: batch,
          integrity: next.entries,
          expectedWriterRunId: writerRunId,
        })
        state = next.state
      }
      await storage.release(key, writerRunId)
    }
  } finally {
    await storage.close()
  }
  await runtime.restart()
  const page = await browser.newPage()
  let wire: { frames: number; bytes: number; acpUpdates: number } | undefined
  page.on('pageerror', (error) => process.stderr.write(`Browser: ${error.message}\n`))
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      const message = JSON.parse(payload)
      if (message.error) process.stderr.write(`RPC refusal: ${JSON.stringify(message.error)}\n`)
      if (wire) {
        wire.frames++
        wire.bytes += Buffer.byteLength(payload)
        if (message.method === 'session/update') wire.acpUpdates++
      }
    }),
  )
  await page.addInitScript(() => {
    localStorage.setItem('agnes-locale', 'en')
    const Native = window.WebSocket
    const sockets: WebSocket[] = []
    Object.assign(window, { benchSockets: sockets })
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    }
  })
  const measurements: unknown[] = []
  const measure = async (kind: string, id: string, action: () => Promise<unknown>) => {
    wire = { frames: 0, bytes: 0, acpUpdates: 0 }
    const received = wire
    const started = performance.now()
    await action()
    await page
      .getByTestId('conversation-turn')
      .filter({ hasText: `Synthetic ${id}` })
      .last()
      .waitFor({ timeout: 30_000 })
      .catch(async (error) => {
        process.stderr.write(`${(await page.locator('body').innerText()).slice(-8000)}\n`)
        throw error
      })
    const visibleMs = performance.now() - started
    const input = page.getByRole('textbox', { name: 'Task content', exact: true })
    await input.waitFor()
    await expect(input)
      .toBeEnabled({ timeout: 120_000 })
      .catch(async (error) => {
        process.stderr.write(`${(await page.locator('body').innerText()).slice(-8000)}\n`)
        throw error
      })
    const editableMs = performance.now() - started
    await input.fill('Local benchmark draft')
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 120_000 })
    const sendableMs = performance.now() - started
    measurements.push({ kind, visibleMs, editableMs, sendableMs, ...received })
    process.stderr.write(
      `${kind}: visible=${visibleMs.toFixed(1)} editable=${editableMs.toFixed(1)} sendable=${sendableMs.toFixed(1)}ms\n`,
    )
    wire = undefined
  }
  for (let run = 0; run < runs; run++) {
    await measure(run === 0 ? 'cold-open' : 'warm-reload', ids[0]!, () =>
      page.goto(`${runtime.url}/?session=${ids[0]}`),
    )
    for (const id of [ids[1]!, ids[0]!]) {
      const label = id === ids[0] ? 'A' : 'B'
      await measure(`switch-${label}`, id, () =>
        page.getByText(`Opening benchmark ${label}`, { exact: true }).first().click(),
      )
    }
    await measure('reconnect', ids[0]!, async () => {
      const reconnected = page.waitForEvent('websocket')
      await page.evaluate(() => {
        const sockets = (window as unknown as { benchSockets: WebSocket[] }).benchSockets
        for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
      })
      await reconnected
    })
  }
  process.stdout.write(
    `${JSON.stringify({ node: process.version, eventsPerSession: events, runs, port: new URL(runtime.url).port, measurements }, null, 2)}\n`,
  )
} catch (error) {
  process.stderr.write(`${await runtime.diagnostics()}\n`)
  process.stderr.write(runtime.logs())
  throw error
} finally {
  await browser.close()
  await runtime.dispose()
}

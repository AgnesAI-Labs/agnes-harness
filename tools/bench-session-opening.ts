/** Manual browser benchmark, not a CI gate. Build @agnes/cli build:local first, then run with tsx.
 * Uses only a fresh synthetic home and an ephemeral loopback port. --events 20000 --runs 5 --cold-each-run
 * Optional spans from an instrumented local build are read from session-opening-spans.jsonl in its home.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import {
  defaultIds,
  LEDGER_INTEGRITY_ALGORITHM,
  makeVerifiedHead,
  type PreparedEvent,
  prepareIntegrity,
  verifyLedger,
} from '@agnes/core'
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
const coldOnly = process.argv.includes('--cold-only')
const coldEachRun = process.argv.includes('--cold-each-run') || coldOnly
const idleSeconds = process.argv.includes('--idle-seconds') ? number('--idle-seconds', 10) : 0
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
      preset: 'standard',
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
      await storage.writeVerifiedHead!(
        makeVerifiedHead({
          sessionKey: key,
          throughSeq: state.lastSeq,
          headDigest: state.headDigest!,
          legacyThroughSeq: state.legacyThroughSeq,
          algorithm: LEDGER_INTEGRITY_ALGORITHM,
          verifiedFullAtMs: Date.now(),
          writtenAtMs: Date.now(),
        }),
      )
      await storage.release(key, writerRunId)
    }
  } finally {
    await storage.close()
  }
  const memory = async () => {
    const discovery = JSON.parse(await readFile(join(runtime.home, 'daemon/discovery.json'), 'utf8'))
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
    const pids = new Set<number>([discovery.owner.pid])
    for (let size = 0; size !== pids.size; ) {
      size = pids.size
      for (const [pid, parent] of processes) if (pids.has(parent!)) pids.add(pid!)
    }
    return processes.filter(([pid]) => pids.has(pid!)).map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB }))
  }
  const startup: unknown[] = []
  const restart = async (run: number) => {
    const start = performance.now()
    await runtime.restart()
    const restartMs = performance.now() - start
    const readyMemory = await memory()
    if (idleSeconds) await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000))
    startup.push({ run, restartMs, readyMemory, beforeOpenMemory: await memory(), load: loadavg() })
  }
  await restart(0)
  const page = await browser.newPage()
  type RpcTiming = { method: string; start: number; end: number }
  let wire: { frames: number; bytes: number; acpUpdates: number; rpc: RpcTiming[] } | undefined
  page.on('pageerror', (error) => process.stderr.write(`Browser: ${error.message}\n`))
  page.on('websocket', (socket) => {
    const pending = new Map<string | number, { method: string; start: number }>()
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      const message = JSON.parse(payload)
      if (message.id !== undefined && message.method)
        pending.set(message.id, { method: message.method, start: Date.now() })
    })
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      const message = JSON.parse(payload)
      if (message.error) process.stderr.write(`RPC refusal: ${JSON.stringify(message.error)}\n`)
      if (wire) {
        const request = pending.get(message.id)
        if (request) wire.rpc.push({ ...request, end: Date.now() })
        wire.frames++
        wire.bytes += Buffer.byteLength(payload)
        if (message.method === 'session/update') wire.acpUpdates++
      }
      pending.delete(message.id)
    })
  })
  await page.addInitScript(() => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return
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
    wire = { frames: 0, bytes: 0, acpUpdates: 0, rpc: [] }
    const received = wire
    const started = performance.now()
    const startedAt = Date.now()
    await action()
    const visible = page
      .getByTestId('conversation-turn')
      .filter({ hasText: `Synthetic ${id}` })
      .last()
      .waitFor({ timeout: 30_000 })
      .catch(async (error) => {
        process.stderr.write(`${(await page.locator('body').innerText()).slice(-8000)}\n`)
        throw error
      })
      .then(() => performance.now() - started)
    const input = page.getByRole('textbox', { name: 'Task content', exact: true })
    const editable = expect(input)
      .toBeEnabled({ timeout: 120_000 })
      .catch(async (error) => {
        process.stderr.write(`${(await page.locator('body').innerText()).slice(-8000)}\n`)
        throw error
      })
      .then(() => performance.now() - started)
    const sendable = editable.then(async () => {
      await input.fill('Local benchmark draft')
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 120_000 })
      return performance.now() - started
    })
    // Observe independently: local editing can become ready before the selected history arrives.
    const [visibleMs, editableMs, sendableMs] = await Promise.all([visible, editable, sendable])
    measurements.push({
      kind,
      startedAt,
      visibleMs,
      editableMs,
      sendableMs,
      load: loadavg(),
      memory: await memory(),
      ...received,
      resources: await page.evaluate(() =>
        performance.getEntriesByType('resource').map((entry) => {
          const resource = entry as PerformanceResourceTiming
          return {
            name: new URL(resource.name).pathname,
            start: performance.timeOrigin + resource.startTime,
            durationMs: resource.duration,
            bytes: resource.transferSize,
          }
        }),
      ),
    })
    await page.evaluate(() => performance.clearResourceTimings())
    process.stderr.write(
      `${kind}: visible=${visibleMs.toFixed(1)} editable=${editableMs.toFixed(1)} sendable=${sendableMs.toFixed(1)}ms\n`,
    )
    wire = undefined
  }
  for (let run = 0; run < runs; run++) {
    if (coldEachRun && run > 0) {
      // Leave the old document first: its reconnect loop must not prewarm the next worker.
      await page.goto('about:blank')
      await restart(run)
    }
    await measure(run === 0 || coldEachRun ? 'cold-open' : 'warm-reload', ids[0]!, () =>
      page.goto(`${runtime.url}/?session=${ids[0]}`),
    )
    if (coldOnly) continue
    if (coldEachRun) await measure('warm-reload', ids[0]!, () => page.reload())
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
    `${JSON.stringify(
      {
        node: process.version,
        eventsPerSession: events,
        runs,
        coldEachRun,
        idleSeconds,
        port: new URL(runtime.url).port,
        startup,
        serverStarts: runtime.starts(),
        measurements,
        prewarm: (await readFile(join(runtime.home, 'data/audit/runtime.jsonl'), 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((record) => record.detail?.prewarm),
        trace: (await readFile(join(runtime.home, 'session-opening-spans.jsonl'), 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      },
      null,
      2,
    )}\n`,
  )
} catch (error) {
  process.stderr.write(`${await runtime.diagnostics()}\n`)
  process.stderr.write(runtime.logs())
  throw error
} finally {
  await browser.close()
  await runtime.dispose()
}

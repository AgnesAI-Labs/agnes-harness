import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '@agnes/host/testkit'
import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import type { RuntimeRunCommandFrame, WorkerReplyFrame, WorkerToSupervisor } from '../src/frames.js'
import { encodeFrame, JsonlDecoder } from '../src/framing.js'
import { admissionRequest } from './fixtures/runtime-admission-owner.js'

async function worker(withOwner: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a1-')))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\entry-${randomUUID()}` : join(root, 's')
  const profileFile = join(root, 'profile.json')
  const ownerLog = join(root, 'owner.jsonl')
  const { host, profile } = await createTestHost({ dataDir: root, script: [], disableSessionTitle: true })
  await host.close()
  writeFileSync(profileFile, JSON.stringify(profile))
  const replies = new Map<string, { resolve(value: WorkerReplyFrame): void; reject(error: Error): void }>()
  let link: Socket | undefined
  let hello!: () => void
  let rejectHello!: (error: Error) => void
  const greeting = new Promise<void>((resolve, reject) => {
    hello = resolve
    rejectHello = reject
  })
  const server = createServer((socket) => {
    link = socket
    const decoder = new JsonlDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.feed(chunk) as WorkerToSupervisor[]) {
        if (frame.kind === 'hello') hello()
        else if (frame.kind === 'reply') replies.get(frame.requestId)?.resolve(frame)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./fixtures/runtime-admission-process.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        AGH_HOME: root,
        AGNES_WORKER_TOKEN: 'entry-fixture',
        AGNES_SUPERVISOR_SOCKET: socketPath,
        AGNES_WORKER_KEY: '@shared',
        AGNES_WORKER_KIND: 'session',
        AGNES_PROFILE_FILE: profileFile,
        AGNES_WORKER_GENERATION: '1',
        AGNES_GATE_FD: '3',
        ...(withOwner ? { ADMISSION_FIXTURE_LOG: ownerLog } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdout?.resume()
  child.once('error', rejectHello)
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      const error = Error(`worker exited ${code}: ${stderr}`)
      rejectHello(error)
      for (const pending of replies.values()) pending.reject(error)
      resolve(code)
    }),
  )
  let counter = 0
  const call = (frame: Record<string, unknown>): Promise<WorkerReplyFrame> => {
    const requestId = `entry-${++counter}`
    return new Promise<WorkerReplyFrame>((resolve, reject) => {
      replies.set(requestId, { resolve, reject })
      link?.write(encodeFrame({ ...frame, requestId }))
    }).finally(() => replies.delete(requestId))
  }
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null)
      link?.write(encodeFrame({ kind: 'close', reason: 'test complete' }))
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    const code = await exited
    clearTimeout(timer)
    link?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return code
  }
  try {
    await greeting
    const gate = child.stdio[3]
    if (!gate || !('end' in gate)) throw Error('worker start gate unavailable')
    gate.end('start\n')
    return {
      root,
      ownerLog,
      pid: child.pid,
      call,
      runtime(frame: Pick<RuntimeRunCommandFrame, 'method' | 'params'>) {
        return call({ kind: 'command', ...frame })
      },
      close,
    }
  } catch (error) {
    child.kill('SIGKILL')
    await close()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

it('refuses the explicit runtime commands without an installation in a real worker, while legacy runs still finish', async () => {
  const w = await worker(false)
  try {
    expect(w.pid).not.toBe(process.pid)
    for (const frame of [
      { method: 'runtime.run.create', params: { request: admissionRequest } },
      { method: 'runtime.run.status', params: { request: admissionRequest.ticketId } },
      { method: 'runtime.run.probe', params: { request: admissionRequest.ticketId } },
      {
        method: 'runtime.run.cancel',
        params: {
          request: { ticketId: admissionRequest.ticketId, fingerprint: admissionRequest.fingerprint },
        },
      },
    ] satisfies Array<Pick<RuntimeRunCommandFrame, 'method' | 'params'>>) {
      const response = await w.runtime(frame)
      expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'service_not_registered' },
      })
    }
    const sessionKey = 'legacy-entry'
    const opened = await w.call({
      kind: 'session.open',
      sessionKey,
      params: {
        binding: {
          version: 1,
          sessionKey,
          workspaceId: createHash('sha256').update(w.root).digest('hex'),
          revision: 1,
          canonicalRoot: w.root,
        },
      },
    })
    expect(opened.error).toBeUndefined()
    const actor = await w.call({
      kind: 'command',
      sessionKey,
      method: 'resolveActor',
      params: { credential: 'fixture', surface: 'session' },
    })
    expect(actor.error).toBeUndefined()
    const enqueued = await w.call({
      kind: 'command',
      sessionKey,
      method: 'enqueue',
      params: {
        target: 'next-turn',
        msg: { kind: 'prompt', content: [{ type: 'text', text: 'legacy prompt' }], actor: actor.result },
      },
    })
    expect(enqueued.error).toBeUndefined()
    const run = await w.call({
      kind: 'command',
      sessionKey,
      method: 'run',
      params: { runId: 'legacy-run', until: 'turn-end' },
    })
    expect(run.error).toBeUndefined()
    const latest = await w.call({ kind: 'command', sessionKey, method: 'projectUI', params: {} })
    expect(latest.error).toBeUndefined()
    expect(JSON.stringify(latest.result)).toContain('legacy worker reply')
    expect(await w.close()).toBe(0)
  } finally {
    await w.close()
    rmSync(w.root, { recursive: true, force: true })
  }
}, 60_000)

it('routes official admission shapes and original owner contexts through the real worker service root', async () => {
  const w = await worker(true)
  try {
    const created = await w.runtime({ method: 'runtime.run.create', params: { request: admissionRequest } })
    expect(created.error).toBeUndefined()
    expect(created.result).toMatchObject({
      ok: true,
      value: { state: 'created', runId: admissionRequest.runId },
    })
    const replay = await w.runtime({ method: 'runtime.run.create', params: { request: admissionRequest } })
    expect(replay.result).toEqual(created.result)
    for (const method of ['runtime.run.status', 'runtime.run.probe'] as const) {
      const response = await w.runtime({ method, params: { request: admissionRequest.ticketId } })
      expect(response.result).toEqual(created.result)
      expect(validateRuntime('AdmissionProbe', (response.result as { value: unknown }).value).ok).toBe(true)
    }
    const cancellation = { ticketId: 'cancel-entry', fingerprint: admissionRequest.fingerprint }
    const cancelled = await w.runtime({ method: 'runtime.run.cancel', params: { request: cancellation } })
    expect(cancelled.result).toMatchObject({ ok: true, value: { state: 'cancelled' } })
    const malformed = await w.call({
      kind: 'command',
      method: 'runtime.run.create',
      params: { request: { ...admissionRequest, fingerprint: 'bad' } },
    })
    expect(malformed.result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', detailCode: 'input_invalid' },
    })
    expect(await w.close()).toBe(0)
    const observations = readFileSync(w.ownerLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      observations.filter((event) => event.method === 'state.createRun').map((event) => event.request),
    ).toEqual([admissionRequest, admissionRequest])
    expect(observations.find((event) => event.method === 'state.probeAdmission').request).toBe(
      admissionRequest.ticketId,
    )
    expect(observations.find((event) => event.method === 'admission.probe').request).toBe(
      admissionRequest.ticketId,
    )
    expect(observations.find((event) => event.method === 'admission.cancel').request).toEqual(cancellation)
    const createdContexts = observations
      .filter((event) => event.method === 'state.createRun')
      .map((event) => event.context)
    expect(
      observations.filter((event) => event.method === 'admission.confirm').map((event) => event.context),
    ).toEqual(createdContexts)
    expect(observations.filter((event) => event.method === 'close')).toEqual([{ method: 'close' }])
  } finally {
    await w.close()
    rmSync(w.root, { recursive: true, force: true })
  }
}, 60_000)

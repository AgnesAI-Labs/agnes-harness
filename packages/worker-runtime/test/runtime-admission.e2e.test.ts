import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '@agnes/host/testkit'
import { validateRuntime } from '@agnes/protocol/runtime'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import type { RuntimeRunCommandFrame, WorkerReplyFrame, WorkerToSupervisor } from '../src/frames.js'
import { encodeFrame, JsonlDecoder } from '../src/framing.js'
import { admissionRequest } from './fixtures/runtime-admission-owner.js'
import { loopAdmissionRequest } from './fixtures/runtime-loop-owner.js'

async function worker(withOwner: boolean, loopMode?: string) {
  const supervisorStartId = process.platform === 'win32' ? windowsProcessStartTimeSync(process.pid) : null
  if (process.platform === 'win32' && !supervisorStartId)
    throw Error('Current supervisor process identity unavailable')
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
        ...(supervisorStartId
          ? {
              AGNES_SUPERVISOR_PID: String(process.pid),
              AGNES_SUPERVISOR_START_ID: supervisorStartId,
            }
          : {}),
        AGNES_WORKER_KEY: '@shared',
        AGNES_WORKER_KIND: 'session',
        AGNES_PROFILE_FILE: profileFile,
        AGNES_WORKER_GENERATION: '1',
        AGNES_GATE_FD: '3',
        ...(withOwner ? { ADMISSION_FIXTURE_LOG: ownerLog } : {}),
        ...(loopMode ? { LOOP_FIXTURE_MODE: loopMode } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  let stdout = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
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
      diagnostics: () => stdout + stderr,
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

it.each([
  ['tools-source-default', 'tools_model_context_source_unavailable'],
  ['tools-source-reference', 'tools_model_context_source_unavailable'],
  ['wrong-ref-default', 'tools_model_context_source_mismatch'],
  ['wrong-ref-reference', 'tools_model_context_source_mismatch'],
  ['revoked-default', 'tools_model_context_source_revoked'],
  ['revoked-reference', 'tools_model_context_source_revoked'],
  ['state', 'loop_state_transactions_unavailable'],
  ['supervisor', 'loop_supervisor_unavailable'],
  ['model', 'loop_model_action_unavailable'],
  ['cold', 'loop_cold_state_consumer_unavailable'],
  ['credential-egress', 'loop_model_action_unavailable'],
  ['credential-c04', 'loop_model_action_unavailable'],
  ['credential-secret', 'loop_credential_binding'],
  ['credential-audience', 'loop_credential_binding'],
  ['credential-expired', 'loop_credential_expired'],
  ['credential-none', 'loop_model_credentials_unavailable'],
  ['credential-wire', 'loop_model_credentials_unavailable'],
  ['credential-owner-denied', 'secret_denied'],
])(
  'persists the named %s refusal and closes its run in a real worker',
  async (mode, detailCode) => {
    const w = await worker(true, mode)
    try {
      const created = await w.runtime({
        method: 'runtime.run.create',
        params: { request: loopAdmissionRequest },
      })
      expect(created.error).toBeUndefined()
      expect(created.result).toMatchObject({ ok: false, error: { detailCode } })
      const replay = await w.runtime({
        method: 'runtime.run.create',
        params: { request: loopAdmissionRequest },
      })
      expect(replay.result).toEqual(created.result)
      expect(await w.close()).toBe(0)
      const events = readFileSync(w.ownerLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(events).toContainEqual(
        expect.objectContaining({
          method: 'state.refused',
          state: 'refused',
          error: expect.objectContaining({ detailCode }),
        }),
      )
      expect(events.filter((event) => event.method === 'run.close')).toEqual([
        { method: 'run.close', live: 0 },
      ])
      if (mode.startsWith('credential-')) {
        expect(created.result).toMatchObject({
          error: {
            code: ['credential-egress', 'credential-c04', 'credential-none', 'credential-wire'].includes(mode)
              ? 'incompatible'
              : 'denied',
          },
        })
        const reached = mode === 'credential-egress'
        expect(events.some((event) => event.method === 'dispatch')).toBe(reached)
        expect(events.filter((event) => event.method === 'secrets.resolve')).toEqual(
          ['credential-none', 'credential-wire'].includes(mode)
            ? []
            : [{ method: 'secrets.resolve', correctBinding: true }],
        )
        expect(events.filter((event) => event.method === 'model.infer')).toEqual(
          reached ? [{ method: 'model.infer', sameHandle: true }] : [],
        )
        expect(events.filter((event) => event.method === 'model.egress')).toEqual(
          reached
            ? [
                expect.objectContaining({
                  exactHandle: true,
                  observations: [
                    {
                      path: '/v1/chat/completions',
                      correctKey: true,
                      body: '{"model":"local","messages":[]}',
                    },
                  ],
                }),
              ]
            : [],
        )
        if (['credential-egress', 'credential-c04'].includes(mode))
          expect(events).toContainEqual({ method: 'credential.accept', exactHandle: true })
        expect(events).toContainEqual({ method: 'credential.close', keyAbsent: true })
        expect(readFileSync(w.ownerLog, 'utf8')).not.toContain('sk-local-')
        expect(w.diagnostics()).not.toContain('sk-local-')
        expect(events.some((event) => event.method === 'state.complete')).toBe(false)
      } else if (['tools-source', 'wrong-ref', 'revoked'].some((prefix) => mode.startsWith(prefix))) {
        expect(events.filter((event) => event.method === 'dispatch').map((event) => event.key)).toEqual([
          'first-model',
          'tool',
        ])
        expect(events.find((event) => event.method === 'tool.result')).toMatchObject({
          outcome: 'failed',
          modelContextRef: { schema: { typeId: 'agh.model/prepared-handle@1' } },
          error: { detailCode },
        })
        expect(events).toContainEqual({ method: 'action.close' })
        expect(events.some((event) => event.method === 'executor.create')).toBe(false)
        expect(events.some((event) => event.method === 'source.verifyCall')).toBe(
          !mode.startsWith('tools-source'),
        )
      } else expect(events.some((event) => event.method === 'dispatch')).toBe(false)
    } finally {
      await w.close()
      rmSync(w.root, { recursive: true, force: true })
    }
  },
  60_000,
)

it.each(['default', 'reference'] as const)(
  'completes the installed model/tool/model chain through C10 %s in a real worker',
  async (kind) => {
    const w = await worker(true, `normal-${kind}`)
    try {
      const created = await w.runtime({
        method: 'runtime.run.create',
        params: { request: loopAdmissionRequest },
      })
      expect(created.error).toBeUndefined()
      expect(created.result).toMatchObject({
        ok: true,
        value: { state: 'created', runId: loopAdmissionRequest.runId },
      })
      const replay = await w.runtime({
        method: 'runtime.run.create',
        params: { request: loopAdmissionRequest },
      })
      expect(replay.result).toEqual(created.result)
      expect(await w.close()).toBe(0)
      const events = readFileSync(w.ownerLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(events.filter((event) => event.method === 'dispatch').map((event) => event.key)).toEqual([
        'first-model',
        'tool',
        'second-model',
      ])
      expect(events.find((event) => event.method === 'tool.result')).toMatchObject({
        outcome: 'succeeded',
        modelContextRef: { schema: { typeId: 'agh.model/prepared-handle@1' } },
      })
      expect(events.find((event) => event.method === 'state.complete')).toMatchObject({
        output: { value: { content: [{ type: 'text', text: 'statistics complete' }] } },
      })
      expect(events.some((event) => event.method === 'state.refused')).toBe(false)
      expect(events.filter((event) => event.method === 'run.close')).toEqual([
        { method: 'run.close', live: 0 },
      ])
    } finally {
      await w.close()
      rmSync(w.root, { recursive: true, force: true })
    }
  },
  60_000,
)

it.each(['cancel', 'exit'] as const)(
  'drains a blocked installed run on worker %s',
  async (operation) => {
    const w = await worker(true, 'blocked')
    const events = () =>
      existsSync(w.ownerLog)
        ? readFileSync(w.ownerLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    try {
      const running = w.runtime({ method: 'runtime.run.create', params: { request: loopAdmissionRequest } })
      // Observe the original admitted action before asking a separate worker command to cancel it.
      const settled = running.catch(() => undefined)
      await expect
        .poll(() => events().some((event) => event.method === 'dispatch'), { timeout: 10_000 })
        .toBe(true)
      if (operation === 'cancel') {
        const denied = await w.runtime({
          method: 'runtime.run.cancel',
          params: {
            request: {
              ticketId: loopAdmissionRequest.ticketId,
              fingerprint: 'b'.repeat(64),
            },
          },
        })
        expect(denied.result).toMatchObject({ ok: false, error: { detailCode: 'fingerprint_conflict' } })
        expect(events().some((event) => event.method === 'run.close')).toBe(false)
        const cancelled = await w.runtime({
          method: 'runtime.run.cancel',
          params: {
            request: {
              ticketId: loopAdmissionRequest.ticketId,
              fingerprint: loopAdmissionRequest.fingerprint,
            },
          },
        })
        expect(cancelled.error).toBeUndefined()
        expect((await settled)?.result).toMatchObject({
          ok: false,
          error: { code: 'cancelled', detailCode: 'loop_cancelled' },
        })
      }
      expect(await w.close()).toBe(0)
      await settled
      expect(events()).toContainEqual(
        expect.objectContaining({
          method: 'state.refused',
          error: expect.objectContaining({ code: 'cancelled', detailCode: 'loop_cancelled' }),
        }),
      )
      expect(events().filter((event) => event.method === 'run.close')).toEqual([
        { method: 'run.close', live: 0 },
      ])
    } finally {
      await w.close()
      rmSync(w.root, { recursive: true, force: true })
    }
  },
  60_000,
)

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

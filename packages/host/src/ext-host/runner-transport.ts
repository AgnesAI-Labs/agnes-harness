import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ExtensionError } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'
import { HostError } from '../errors.js'

export type RunnerBootstrap = {
  nonce: string
  packageDigest: string
  manifestDigest: string
  extensionId: string
  data: Record<string, unknown>
}
export type ExtensionRunner = {
  readonly pid: number
  readonly proposal: Record<string, unknown>
  onUnregister(listener: (event: string) => void): () => void
  onFailure(listener: (error: Error) => void): () => void
  invoke(
    event: string,
    payload: unknown,
    context: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>
  close(): Promise<void>
}

const MAX_FRAME = 1024 * 1024
const MAX_QUEUED = 2 * MAX_FRAME
const MAX_INVOCATIONS = 32
const MAX_CAPABILITIES = 128
const STARTUP_TIMEOUT_MS = 5_000
const CANCEL_GRACE_MS = 250

type JsonObject = Record<string, unknown>
export type RunnerInvocation = { event: string; payload: unknown; context: JsonObject }
export type RunnerCapability = (
  method: string,
  input: unknown,
  signal: AbortSignal,
  invocation: RunnerInvocation,
) => Promise<unknown>
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  controller: AbortController
  capabilities: number
  activeCapabilities: number
  capabilityIds: Set<string>
  run: ReturnType<typeof AsyncLocalStorage.snapshot>
  invocation: RunnerInvocation
  cancelled: boolean
  completion?: Readonly<{ kind: 'result'; value: unknown }> | Readonly<{ kind: 'error'; error: Error }>
  cancelTimer?: NodeJS.Timeout
}

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function protocol(message: string): HostError {
  return new HostError('E_EXT_LOAD', `E_EXT_ISOLATION_PROTOCOL: ${message}`)
}

function frame(value: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  if (body.byteLength > MAX_FRAME) throw protocol('frame exceeds 1 MiB')
  const out = Buffer.allocUnsafe(body.byteLength + 4)
  out.writeUInt32BE(body.byteLength)
  body.copy(out, 4)
  return out
}

class Decoder {
  private buffered = Buffer.alloc(0)

  push(chunk: Buffer): JsonObject[] {
    this.buffered = Buffer.concat([this.buffered, chunk])
    const messages: JsonObject[] = []
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32BE(0)
      if (length > MAX_FRAME) throw protocol(`frame exceeds 1 MiB (${length})`)
      if (this.buffered.byteLength < length + 4) break
      const bytes = this.buffered.subarray(4, length + 4)
      this.buffered = this.buffered.subarray(length + 4)
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch {
        throw protocol('invalid JSON frame')
      }
      if (!inspectJsonData(value, MAX_FRAME).ok) throw protocol('invalid JSON data')
      if (!record(value) || value.protocol !== 1 || typeof value.kind !== 'string')
        throw protocol('invalid message envelope')
      messages.push(value)
    }
    return messages
  }

  end(): void {
    if (this.buffered.byteLength !== 0) throw protocol('partial frame at EOF')
  }
}

/** Connect a caller-spawned, already-confined hooks runner. This function never chooses a sandbox. */
export async function connectExtensionRunner(
  child: ChildProcessWithoutNullStreams,
  bootstrap: RunnerBootstrap,
  capability: RunnerCapability,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
): Promise<ExtensionRunner> {
  const decoder = new Decoder()
  const pending = new Map<string, Pending>()
  let sequence = 0
  let ended = false
  let closing = false
  let state: 'hello' | 'preparing' | 'ready' = 'hello'
  let closeTask: Promise<void> | undefined
  let rejectReady: ((error: Error) => void) | undefined
  let didExit = child.exitCode !== null || child.signalCode !== null
  const exited = new Promise<void>((resolve) => {
    if (didExit) resolve()
    else
      child.once('close', () => {
        didExit = true
        resolve()
      })
  })
  const waitExit = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      void exited.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  const reap = async (): Promise<void> => {
    if (didExit) return
    child.kill('SIGTERM')
    if (await waitExit(CANCEL_GRACE_MS)) return
    child.kill('SIGKILL')
    if (!(await waitExit(2000))) throw protocol('runner process did not exit')
  }
  let terminalError: Error | undefined
  let hello: ((message: JsonObject) => void) | undefined
  let rejectHello: ((error: Error) => void) | undefined
  let ready: ((message: JsonObject) => void) | undefined
  let closed: (() => void) | undefined
  const withdrawn = new Set<string>()
  const withdrawalListeners = new Set<(event: string) => void>()
  let readyEvents: unknown
  const failureListeners = new Set<(error: Error) => void>()
  const helloPromise = new Promise<JsonObject>((resolve, reject) => {
    hello = resolve
    rejectHello = reject
  })

  const send = (message: JsonObject): void => {
    if (ended || child.stdin.destroyed) throw protocol('runner is closed')
    const encoded = frame({ protocol: 1, ...message })
    if (child.stdin.writableLength + encoded.byteLength > MAX_QUEUED)
      throw protocol('write queue exceeds 2 MiB')
    child.stdin.write(encoded)
  }
  const settle = (requestId: string, request: Pending): void => {
    const completion = request.completion
    if (!completion || request.activeCapabilities !== 0) return
    pending.delete(requestId)
    if (request.cancelTimer) clearTimeout(request.cancelTimer)
    request.controller.abort()
    if (request.cancelled) return
    if (completion.kind === 'error') request.reject(completion.error)
    else request.resolve(completion.value)
  }
  const fail = (error: Error): void => {
    if (ended) return
    ended = true
    terminalError = error
    rejectHello?.(error)
    rejectHello = undefined
    rejectReady?.(error)
    rejectReady = undefined
    for (const request of pending.values()) {
      if (request.cancelTimer) clearTimeout(request.cancelTimer)
      request.controller.abort()
      request.reject(error)
    }
    pending.clear()
    child.kill('SIGKILL')
    for (const listener of failureListeners) {
      try {
        listener(error)
      } catch {
        // Failure observers cannot keep an already failed runner alive.
      }
    }
    failureListeners.clear()
    withdrawalListeners.clear()
  }
  const dispatch = (message: JsonObject): void => {
    if (message.kind === 'hello') {
      if (state !== 'hello' || !hello) throw protocol('unexpected hello')
      state = 'preparing'
      hello(message)
      hello = undefined
      rejectHello = undefined
      return
    }
    if (message.kind === 'ready') {
      if (state !== 'preparing' || !ready) throw protocol('unexpected ready')
      state = 'ready'
      readyEvents = Array.isArray(message.hooks)
        ? message.hooks.map((hook) =>
            hook && typeof hook === 'object' && !Array.isArray(hook) ? hook.id : undefined,
          )
        : message.events
      ready(message)
      ready = undefined
      return
    }
    if (message.kind === 'closed') {
      if (!closing || !closed) throw protocol('unexpected close acknowledgement')
      closed()
      closed = undefined
      return
    }
    if (state !== 'ready') throw protocol('message before ready')
    if (message.kind === 'unregister') {
      if (
        typeof message.event !== 'string' ||
        !Array.isArray(readyEvents) ||
        !readyEvents.includes(message.event)
      )
        throw protocol('invalid registration withdrawal')
      if (!withdrawn.has(message.event)) {
        withdrawn.add(message.event)
        for (const listener of withdrawalListeners) listener(message.event)
      }
      return
    }
    if (message.kind === 'result' || message.kind === 'error') {
      if (typeof message.requestId !== 'string') throw protocol('response has no request id')
      const request = pending.get(message.requestId)
      if (!request) throw protocol('response has unknown request id')
      if (request.completion) throw protocol('duplicate invocation response')
      if (request.cancelTimer) clearTimeout(request.cancelTimer)
      request.completion =
        message.kind === 'error'
          ? { kind: 'error', error: new Error('isolated hook failed') }
          : { kind: 'result', value: message.undefined === true ? undefined : message.value }
      settle(message.requestId, request)
      return
    }
    if (message.kind !== 'capability') throw protocol('unknown message kind')
    if (
      typeof message.requestId !== 'string' ||
      typeof message.invocationId !== 'string' ||
      typeof message.method !== 'string'
    )
      throw protocol('invalid capability request')
    const invocation = pending.get(message.invocationId)
    if (!invocation) throw protocol('capability has no active invocation')
    if (invocation.completion) throw protocol('capability after invocation response')
    if (invocation.cancelled) {
      send({ kind: 'capability-result', requestId: message.requestId, ok: false })
      return
    }
    if (invocation.capabilityIds.has(message.requestId)) throw protocol('duplicate capability request')
    invocation.capabilityIds.add(message.requestId)
    invocation.capabilities++
    if (invocation.capabilities > MAX_CAPABILITIES) throw protocol('capability quota exceeded')
    invocation.activeCapabilities++
    const task = invocation
      .run(() =>
        capability(
          message.method as string,
          message.input,
          invocation.controller.signal,
          invocation.invocation,
        ),
      )
      .then(
        (value) =>
          send(
            invocation.cancelled
              ? { kind: 'capability-result', requestId: message.requestId, ok: false }
              : { kind: 'capability-result', requestId: message.requestId, ok: true, value },
          ),
        (error: unknown) =>
          send({
            kind: 'capability-result',
            requestId: message.requestId,
            ok: false,
            ...(error instanceof ExtensionError ? { code: error.code } : {}),
          }),
      )
      .catch((error) => fail(error instanceof Error ? error : protocol('capability reply failed')))
      .finally(() => {
        invocation.activeCapabilities--
        settle(message.invocationId as string, invocation)
      })
    void task
  }
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) dispatch(message)
    } catch (error) {
      fail(error instanceof Error ? error : protocol('receive failed'))
    }
  })
  child.stdout.on('end', () => {
    try {
      decoder.end()
    } catch (error) {
      fail(error instanceof Error ? error : protocol('receive failed'))
    }
  })
  const finishClose = (): boolean => {
    if (!closing) return false
    ended = true
    closed?.()
    closed = undefined
    return true
  }
  child.on('exit', () => {
    if (!finishClose()) fail(new HostError('E_EXT_LOAD', 'isolated hooks runner exited'))
  })
  child.on('error', () => {
    if (!finishClose()) fail(new HostError('E_EXT_LOAD', 'isolated hooks runner failed'))
  })

  const startupTimer = setTimeout(() => fail(protocol('runner startup timed out')), startupTimeoutMs)
  startupTimer.unref()
  const stopStartupTimer = (): void => clearTimeout(startupTimer)
  const helloMessage = await helloPromise.catch(async (error) => {
    stopStartupTimer()
    await reap()
    throw error
  })
  if (terminalError) {
    stopStartupTimer()
    await reap()
    throw terminalError
  }
  if (
    helloMessage.nonce !== bootstrap.nonce ||
    typeof helloMessage.pid !== 'number' ||
    helloMessage.pid !== child.pid
  ) {
    const error = protocol('handshake mismatch')
    stopStartupTimer()
    fail(error)
    await reap()
    throw error
  }
  const readyPromise = new Promise<JsonObject>((resolve, reject) => {
    ready = resolve
    rejectReady = reject
  })
  try {
    send({ kind: 'prepare', ...bootstrap })
  } catch (error) {
    fail(error instanceof Error ? error : protocol('prepare failed'))
  }
  const readyMessage = await readyPromise.catch(async (error) => {
    stopStartupTimer()
    await reap()
    throw error
  })
  rejectReady = undefined
  stopStartupTimer()
  if (terminalError) {
    await reap()
    throw terminalError
  }

  return Object.freeze({
    pid: helloMessage.pid,
    proposal: readyMessage,
    onUnregister(listener: (event: string) => void): () => void {
      for (const event of withdrawn) listener(event)
      withdrawalListeners.add(listener)
      return () => {
        withdrawalListeners.delete(listener)
      }
    },
    onFailure(listener: (error: Error) => void): () => void {
      if (terminalError) {
        try {
          listener(terminalError)
        } catch {
          // Failure observers are diagnostics/lifecycle notifications only.
        }
        return () => undefined
      }
      failureListeners.add(listener)
      return () => failureListeners.delete(listener)
    },
    invoke(event: string, payload: unknown, context: JsonObject, signal: AbortSignal): Promise<unknown> {
      if (closing || ended) return Promise.reject(protocol('runner is closing'))
      if (signal.aborted) return Promise.reject(protocol('invocation already cancelled'))
      if (pending.size >= MAX_INVOCATIONS) return Promise.reject(protocol('invocation quota exceeded'))
      const requestId = `h-${++sequence}`
      const controller = new AbortController()
      const abort = () => {
        const request = pending.get(requestId)
        if (!request || request.cancelled) return
        request.cancelled = true
        controller.abort()
        request.reject(new Error('isolated hook cancelled'))
        if (ended) return
        try {
          send({ kind: 'cancel', requestId })
        } catch (error) {
          fail(error instanceof Error ? error : protocol('cancel failed'))
          return
        }
        request.cancelTimer = setTimeout(
          () => fail(protocol('runner did not settle cancelled invocation')),
          CANCEL_GRACE_MS,
        )
        request.cancelTimer.unref()
      }
      signal.addEventListener('abort', abort, { once: true })
      return new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, {
          resolve,
          reject,
          controller,
          capabilities: 0,
          activeCapabilities: 0,
          capabilityIds: new Set(),
          run: AsyncLocalStorage.snapshot(),
          invocation: { event, payload, context },
          cancelled: false,
        })
        try {
          send({
            kind: 'invoke',
            requestId,
            event,
            payload,
            context,
          })
          if (signal.aborted) abort()
        } catch (error) {
          pending.delete(requestId)
          reject(error instanceof Error ? error : protocol('send failed'))
        }
      }).finally(() => signal.removeEventListener('abort', abort))
    },
    close(): Promise<void> {
      closeTask ??= (async () => {
        if (ended) {
          await reap()
          return
        }
        closing = true
        for (const request of pending.values()) {
          if (request.cancelTimer) clearTimeout(request.cancelTimer)
          request.controller.abort()
          request.reject(protocol('runner closed'))
        }
        pending.clear()
        const acknowledged = new Promise<void>((resolve) => {
          closed = resolve
        })
        try {
          send({ kind: 'close' })
        } catch {
          child.kill('SIGKILL')
        }
        await Promise.race([acknowledged, waitExit(CANCEL_GRACE_MS)])
        ended = true
        failureListeners.clear()
        withdrawalListeners.clear()
        await reap()
      })()
      return closeTask
    },
  })
}

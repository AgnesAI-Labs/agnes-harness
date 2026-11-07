// Runs the tree-walking Windows ACL primitives (inspect, grant, restore) on a worker thread. A
// walk opens, reads and hashes every object below a workspace root, which on a large tree takes
// tens of seconds; on the Host's event loop that would stall every timer and IPC reply meanwhile.
//
// One worker serves every call of a client, one call at a time and in order: the native module is
// loaded once per worker instead of once per call, and the callers (the execution authority, under
// its journal lock) issue these calls one at a time anyway. The worker source is inline, so no
// extra file has to ship next to a bundled Host; it loads the same native artifact by its resolved
// path (the module registers through NAPI_MODULE_INIT and keeps no process-wide state, so each
// thread gets its own instance). Arguments are validated and results checked on the calling thread
// with the same rules as the synchronous functions in windows-acl.ts.
//
// A call that does not answer within its deadline fails closed with E_ACL_WORKER_TIMEOUT and the
// worker is discarded; a native call cannot be interrupted, so the caller must treat its outcome as
// unknown (it may still finish). A worker that exits or crashes fails its call with
// E_ACL_WORKER_FAILED. Either way the next call starts a fresh worker.
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { windowsAclBinding } from './index.js'
import {
  type WindowsAclApply,
  type WindowsAclMutation,
  type WindowsAclRequest,
  type WindowsAclRestore,
  type WindowsAclSnapshot,
  windowsAclApplyRequest,
  windowsAclInspectRequest,
  windowsAclRestoreRequest,
} from './windows-acl.js'

export type WindowsAclWorker = Readonly<{
  inspect(path: string): Promise<WindowsAclSnapshot>
  apply(input: WindowsAclApply): Promise<WindowsAclMutation>
  restore(input: WindowsAclRestore): Promise<WindowsAclMutation>
  /** Stops the worker; later calls are refused. */
  close(): Promise<void>
}>

/** Long enough for a walk of a very large tree, short enough that a hung call cannot block forever. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

const SOURCE = `'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const methods = { inspect: 'aclInspect', apply: 'aclApply', restore: 'aclRestore' }
const unavailable = (message) => Object.assign(new Error(message), { code: 'E_SYSTEM_NATIVE_UNAVAILABLE' })
let binding
let loadError
try {
  binding = require(workerData.native)
  // A build with failure injection exists for tests only and never changes permissions.
  if (!binding || binding.abiVersion !== 1 || binding.testFaults !== undefined)
    throw unavailable('The native artifact cannot serve Windows ACL work')
} catch (error) {
  loadError = error && error.code === 'E_SYSTEM_NATIVE_UNAVAILABLE' ? error : unavailable('Cannot load the native artifact')
}
const plain = (error) => {
  const out = { name: error instanceof TypeError ? 'TypeError' : 'Error', message: String((error && error.message) || error) }
  if (error && typeof error.code === 'string') out.code = error.code
  if (error && typeof error.path === 'string') out.path = error.path
  if (error && typeof error.win32Code === 'number') out.win32Code = error.win32Code
  return out
}
parentPort.on('message', (request) => {
  const id = request && request.id
  let reply
  try {
    if (loadError) throw loadError
    const name = request && Object.hasOwn(methods, request.method) ? methods[request.method] : undefined
    if (!name || typeof binding[name] !== 'function' || !Array.isArray(request.args))
      throw Object.assign(new Error('Unknown Windows ACL request'), { code: 'EINVAL' })
    reply = { id, ok: true, value: binding[name](...request.args) }
  } catch (error) {
    reply = { id, ok: false, error: plain(error) }
  }
  try {
    parentPort.postMessage(reply)
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: plain(error) })
  }
})
`

const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** The error the worker reported, rebuilt with its stable code, path and Win32 code. */
function rebuilt(value: unknown): Error {
  const fields = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const message = typeof fields.message === 'string' ? fields.message : 'Windows ACL operation failed'
  const error = fields.name === 'TypeError' ? new TypeError(message) : new Error(message)
  for (const key of ['code', 'path', 'win32Code'] as const)
    if (fields[key] !== undefined) Object.assign(error, { [key]: fields[key] })
  return error
}

export function createWindowsAclWorker(options: Readonly<{ timeoutMs?: number }> = {}): WindowsAclWorker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw Object.assign(new TypeError('Invalid Windows ACL worker timeout'), { code: 'EINVAL' })
  let worker: Worker | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let closed = false
  let sequence = 0

  const discard = (stale: Worker) => {
    if (worker === stale) worker = undefined
    void stale.terminate().catch(() => {})
  }
  const start = (): Worker => {
    // Same refusals as the synchronous primitives (ENOSYS off Windows, an artifact without them or
    // a test build), on this thread, before any thread starts.
    windowsAclBinding()
    const native = createRequire(import.meta.url).resolve('@agnes/system-node/native')
    const started = new Worker(SOURCE, { eval: true, workerData: { native } })
    // An idle worker never keeps the process alive; a running call does (see call()).
    started.unref()
    return started
  }

  const call = <T>(request: WindowsAclRequest<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(failure('E_ACL_WORKER_CLOSED', 'The Windows ACL worker was closed'))
        return
      }
      let current: Worker
      try {
        worker ??= start()
        current = worker
      } catch (error) {
        reject(error)
        return
      }
      const id = ++sequence
      const settle = (outcome: () => void) => {
        clearTimeout(timer)
        current.off('message', onMessage)
        current.off('error', onError)
        current.off('exit', onExit)
        current.unref()
        outcome()
      }
      const onMessage = (message: unknown) => {
        const reply = (typeof message === 'object' && message !== null ? message : {}) as Record<
          string,
          unknown
        >
        if (reply.id !== id) return
        settle(() => {
          if (reply.ok !== true) {
            reject(rebuilt(reply.error))
            return
          }
          try {
            resolve(request.result(reply.value))
          } catch (error) {
            reject(error)
          }
        })
      }
      const onError = (cause: Error) =>
        settle(() => {
          discard(current)
          reject(Object.assign(failure('E_ACL_WORKER_FAILED', 'The Windows ACL worker failed'), { cause }))
        })
      const onExit = () =>
        settle(() => {
          discard(current)
          reject(failure('E_ACL_WORKER_FAILED', 'The Windows ACL worker exited during a call'))
        })
      const timer = setTimeout(
        () =>
          settle(() => {
            discard(current)
            reject(
              failure(
                'E_ACL_WORKER_TIMEOUT',
                `The Windows ACL ${request.method} did not finish within ${timeoutMs} ms; its outcome is unknown`,
              ),
            )
          }),
        timeoutMs,
      )
      current.on('message', onMessage)
      current.once('error', onError)
      current.once('exit', onExit)
      current.ref()
      current.postMessage({ id, method: request.method, args: request.args })
    })

  const run = <T>(prepare: () => WindowsAclRequest<T>): Promise<T> => {
    let request: WindowsAclRequest<T>
    try {
      request = prepare()
    } catch (error) {
      return Promise.reject(error)
    }
    const next = queue.then(() => call(request))
    queue = next.catch(() => {})
    return next
  }

  return Object.freeze({
    inspect: (path: string) => run(() => windowsAclInspectRequest(path)),
    apply: (input: WindowsAclApply) => run(() => windowsAclApplyRequest(input)),
    restore: (input: WindowsAclRestore) => run(() => windowsAclRestoreRequest(input)),
    close: async () => {
      closed = true
      const current = worker
      worker = undefined
      if (current) await current.terminate().catch(() => {})
    },
  })
}

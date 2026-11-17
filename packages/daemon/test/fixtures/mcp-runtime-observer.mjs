import childProcess from 'node:child_process'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

export function observeExecFile(original, report, executable = '/usr/bin/otool') {
  let attempt = 0
  let observedCustom
  // Node's original custom property is immutable: use a forwarding target so the Proxy can
  // expose an observing custom function without violating that property's invariants.
  return new Proxy((...args) => Reflect.apply(original, undefined, args), {
    apply(_target, receiver, args) {
      return Reflect.apply(original, receiver, args)
    },
    get(_target, property) {
      if (property !== promisify.custom) return Reflect.get(original, property)
      const custom = Reflect.get(original, property)
      if (typeof custom !== 'function') return custom
      observedCustom ??= function (...args) {
        if (args[0] !== executable) return Reflect.apply(custom, this, args)
        const id = ++attempt
        const startedAtMs = Date.now()
        const started = performance.now()
        const record = (error) => {
          try {
            const code = error?.code
            const signal = error?.signal
            report({
              event: 'exec-file-settled',
              pid: process.pid,
              attempt: id,
              startedAtMs,
              durationMs: Math.round(performance.now() - started),
              outcome: error ? 'failed' : 'succeeded',
              code:
                (Number.isInteger(code) && code >= 0 && code <= 255) ||
                (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
                  ? code
                  : null,
              status: Number.isInteger(error?.status) ? error.status : null,
              signal: typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : null,
              killed: typeof error?.killed === 'boolean' ? error.killed : null,
            })
          } catch {
            // Even a diagnostic sink failure must not change settlement or create a rejection.
          }
        }
        let promise
        try {
          promise = Reflect.apply(custom, this, args)
        } catch (error) {
          record(error)
          throw error
        }
        void promise.then(() => record(undefined), record)
        return promise
      }
      return observedCustom
    },
  })
}

export function readExecFileObservations(file) {
  try {
    if (statSync(file).size > 64 * 1024) return { unavailable: 'capture-limit' }
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((row) => JSON.parse(row))
  } catch {
    return { unavailable: 'capture-unreadable' }
  }
}

const output = new URL(import.meta.url).searchParams.get('output')
if (output) {
  const report = (entry) => {
    try {
      appendFileSync(output, `${JSON.stringify(entry)}\n`)
    } catch {
      // Diagnostic I/O must never change the operation being observed.
    }
  }
  childProcess.execFile = observeExecFile(childProcess.execFile, report)
  syncBuiltinESMExports()
  report({ event: 'observer-ready', pid: process.pid })
}

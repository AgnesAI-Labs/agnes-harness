import type { BrowserLog, BrowserLogEntry } from '@agnes/web-units'
import { redactDiagnosticText } from './diagnostics-redact.js'

const MAX_ENTRIES = 1000
const MAX_ENTRY_LENGTH = 8000
const CONSOLE_LEVELS: readonly BrowserLogEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug']

export type BrowserLogCaptureTarget = { console: Console; window: Window }

let installed = false
let dropped = 0
let entries: BrowserLogEntry[] = []

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    const { name, message, stack } = value
    // Chromium's stack already leads with "Name: message"; Safari/Firefox stacks are frames only,
    // so the message would otherwise be lost entirely.
    return stack?.includes(message) ? stack : `${name}: ${message}\n${stack ?? ''}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// A logging call must never throw back into the caller's console.* invocation: a pathological
// argument (e.g. a null-prototype object with a circular reference, where JSON.stringify's
// "circular structure" throw is caught above but the String(value) fallback then throws too, since
// a null-prototype object has no inherited toString) must not stop `original(...args)` from running.
function appendEntry(level: BrowserLogEntry['level'], args: unknown[]): void {
  try {
    const rawText = args.map(stringifyValue).join(' ')
    const text = redactDiagnosticText(rawText).slice(0, MAX_ENTRY_LENGTH)
    entries.push({ ts: new Date().toISOString(), level, text })
    while (entries.length > MAX_ENTRIES) {
      entries.shift()
      dropped += 1
    }
  } catch {
    // Never let a buffering failure break the app's logging call.
  }
}

function defaultTarget(): BrowserLogCaptureTarget | undefined {
  if (typeof window === 'undefined' || typeof console === 'undefined') return undefined
  return { console, window }
}

/** Installs console/window capture into the buffer. Idempotent: a second call is a no-op. */
export function installBrowserLogCapture(
  target: BrowserLogCaptureTarget | undefined = defaultTarget(),
): void {
  if (installed || !target) return
  installed = true
  const { console: targetConsole, window: targetWindow } = target

  for (const level of CONSOLE_LEVELS) {
    const original = targetConsole[level].bind(targetConsole)
    targetConsole[level] = ((...args: unknown[]) => {
      appendEntry(level, args)
      original(...args)
    }) as Console[typeof level]
  }

  targetWindow.addEventListener('error', (event) => {
    appendEntry('error', [
      event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
      event.error,
    ])
  })
  targetWindow.addEventListener('unhandledrejection', (event) => {
    appendEntry('error', ['Unhandled promise rejection', event.reason])
  })
}

export function getBrowserLog(): BrowserLog {
  return { collectedAt: new Date().toISOString(), entries: [...entries], dropped, limit: MAX_ENTRIES }
}

/** Test-only reset of the module-level buffer and install flag. */
export function resetBrowserLogForTest(): void {
  installed = false
  dropped = 0
  entries = []
}

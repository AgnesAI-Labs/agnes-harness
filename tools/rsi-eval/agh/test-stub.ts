// The launcher stub and the small task builders the runner tests share. The stub records what the runner
// asks of a host and answers from a script: no model and no host.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalTask, RunConfig } from '../types.js'
import type { AghHost, AghSession, LaunchInput, LedgerRow } from './run-agh.js'

export const KEY_ENV = 'RSI_TEST_API_KEY'
export const KEY_VALUE = 'sk-test-secret-value-456'

export const cfg: RunConfig = {
  provider: 'eval',
  api: 'anthropic-messages',
  upstream: 'https://api.example.test',
  model: 'model-x',
  keyEnv: KEY_ENV,
  prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  proxyPort: 4555,
  sessionTimeoutMs: 20_000,
}

export const prompt = (text: string) => ({
  text,
  checks: [{ command: `check ${text}`, contains: 'PASS' }],
  solution: [],
})
export const task = (category: EvalTask['category'], sessions: string[][]): EvalTask => ({
  id: 't1',
  category,
  description: 'd',
  trap: { signatures: ['x'], reproduce: 'true', note: 'n' },
  sessions: sessions.map((prompts) => ({ prompts: prompts.map(prompt) })),
})

export type Call =
  | { op: 'launch'; input: LaunchInput }
  | { op: 'open'; key: string; workspace: string }
  | { op: 'prompt'; key: string; text: string }
  | { op: 'review'; key: string; saveTo?: 'workspace' | 'user' }
  | { op: 'settled'; key: string; runId: string; ms: number }
  | { op: 'close-session'; key: string }
  | { op: 'seed'; workspace: string; text: string }
  | { op: 'seed-user'; text: string }
  | { op: 'liveness'; key: string }
  | { op: 'check'; command: string }
  | { op: 'close-host' }

export type Script = {
  /** Ledger rows a session's ledger holds besides its first row, by session key suffix (`s1`, `s2`). */
  ledgerRows?: Record<string, LedgerRow[]>
  /** How each prompt ends, by prompt text; `hang` waits for the abort. Default `completed`. */
  turns?: Record<string, string>
  review?: { runId: string } | { refused: string }
  settled?: string
  /** What the dry liveness read answers; `live` by default. */
  liveness?: { live: true } | { refused: string }
  /** The prompt during which the proxy's cap is reached (`trip` is called, then the turn waits for the abort). */
  capAt?: string
  trip?: () => void
}

/** A launcher that records what the runner asks of a host and answers from a script; no model, no host. */
export function stubLaunch(calls: Call[], script: Script = {}) {
  return async (input: LaunchInput): Promise<AghHost> => {
    calls.push({ op: 'launch', input })
    // The real launcher makes the home; the stub only marks it so isolation can be checked.
    mkdirSync(input.home, { recursive: true })
    writeFileSync(join(input.home, 'marker'), input.refinement ? 'on' : 'off')
    let reviews = 0
    const opened: string[] = []
    return {
      seedMemory: async (workspace, text) => {
        calls.push({ op: 'seed', workspace, text })
      },
      seedUserMemory: async (text) => {
        calls.push({ op: 'seed-user', text })
      },
      openSession: async (key, workspace): Promise<AghSession> => {
        calls.push({ op: 'open', key, workspace })
        opened.push(key)
        return {
          key,
          prompt: (text, signal) => {
            calls.push({ op: 'prompt', key, text })
            const end = script.capAt === text ? 'hang' : (script.turns?.[text] ?? 'completed')
            if (end !== 'hang') return Promise.resolve(end)
            const ended = new Promise<string>((resolve) =>
              signal.addEventListener('abort', () => resolve('cancelled')),
            )
            if (script.capAt === text) script.trip?.()
            return ended
          },
          liveness: async () => {
            calls.push({ op: 'liveness', key })
            return script.liveness ?? { live: true as const }
          },
          review: async (saveTo) => {
            calls.push({ op: 'review', key, ...(saveTo ? { saveTo } : {}) })
            return script.review ?? { runId: `run-${++reviews}` }
          },
          settled: async (runId, ms) => {
            calls.push({ op: 'settled', key, runId, ms })
            return script.settled ?? 'applied'
          },
          close: async () => {
            calls.push({ op: 'close-session', key })
          },
        }
      },
      close: async () => {
        calls.push({ op: 'close-host' })
      },
      ledger: (key): LedgerRow[] => {
        if (!opened.includes(key)) throw new Error(`not opened: ${key}`)
        return [
          {
            seq: 1,
            ts: '2026-11-03T00:00:00Z',
            type: 'session/start',
            lane: 'main',
            origin: 'system',
            data: { key },
          },
          ...(script.ledgerRows?.[key.slice(key.lastIndexOf('-') + 1)] ?? []),
        ]
      },
    }
  }
}

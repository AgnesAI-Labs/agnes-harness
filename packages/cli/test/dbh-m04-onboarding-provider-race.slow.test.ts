import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createConfigurationService } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { Client } from '@agnes/sdk'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOnboardingTui } from '../src/onboarding/tui.js'
import { FakeTerminal } from '../src/tui/terminal.js'
import { screenOf } from './tui/harness.js'

// Deep Bug Hunt M-04. Oracles: onboarding/tui.ts:17-19 (the key is held "for the span of test+save" of
// the provider it was entered for); host configuration.ts:757 "Never forward an existing account's key
// to an edited destination implicitly"; onboarding/controller.ts discards stale async results by
// generation. A key typed for provider A must never be tested or saved against provider B.
// Tests assert the correct behaviour; a failure reproduces the defect.

const KEY_A = 'sk-key-typed-for-provider-a'
const UNCONFIGURED = { profile: 'local-dev', revision: 1, configured: false } as never
const SAVED = { profile: 'local-dev', revision: 2, configured: true, effect: 'ready' }

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tmp: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

function stubClient() {
  const pending: Array<Deferred<unknown>> = []
  const test = vi.fn((_input: unknown) => {
    const d = deferred<unknown>()
    pending.push(d)
    return d.promise
  })
  const save = vi.fn().mockResolvedValue(SAVED)
  const client = {
    config: {
      providers: vi.fn().mockResolvedValue({
        providers: [
          {
            id: 'provider-a',
            label: 'Provider A',
            api: 'openai-compatible',
            baseUrl: 'https://a.example.test',
          },
          {
            id: 'provider-b',
            label: 'Provider B',
            api: 'openai-compatible',
            baseUrl: 'https://b.example.test',
          },
        ],
      }),
      test,
      save,
    },
  } as unknown as Client
  return { client, test, save, pending }
}

const VERIFIED_A = { verified: true, models: [{ id: 'model-a', name: 'Model A' }] }

describe('dbh M-04: onboarding config.test result is not bound to the provider it tested', () => {
  it('control: without switching provider, the verified key is saved for provider A', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, test, save, pending } = stubClient()
    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r') // API key
    await settle()
    term.feed('\r') // Provider A
    await settle()
    term.feed(KEY_A)
    term.feed('\r')
    await settle()
    expect(test).toHaveBeenCalledTimes(1)
    pending[0]?.resolve(VERIFIED_A)
    await settle()
    term.feed('\r') // Model A
    await settle()
    await expect(done).resolves.toEqual(SAVED)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'provider-a', apiKey: KEY_A }))
  })

  it("switching to provider B while A is being tested never saves A's key under B", async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, test, save, pending } = stubClient()
    void runOnboardingTui(client, UNCONFIGURED, term).catch(() => undefined)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r') // API key
    await settle()
    term.feed('\r') // Provider A
    await settle()
    term.feed(KEY_A)
    term.feed('\r') // test(A) now in flight
    await settle()
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'provider-a', apiKey: KEY_A }))
    term.feed('\x1b') // back to provider list
    await settle()
    expect((await screenOf(term, 80, 24)).join('\n')).toContain('Select a provider:')
    term.feed('\x1b[B')
    term.feed('\r') // Provider B
    await settle()
    expect((await screenOf(term, 80, 24)).join('\n')).toContain('Provider B API key')
    pending[0]?.resolve(VERIFIED_A) // A's stale result lands while B's key prompt is showing
    await settle()
    term.feed('\r')
    await settle()
    const leaked = save.mock.calls
      .map((c) => c[0] as { providerId: string; apiKey: string; model: string })
      .filter((input) => input.providerId !== 'provider-a' && input.apiKey === KEY_A)
    expect(leaked).toEqual([])
  })

  it('a key submitted again while the first is being tested supersedes the first result', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, test, save, pending } = stubClient()
    void runOnboardingTui(client, UNCONFIGURED, term).catch(() => undefined)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r') // API key
    await settle()
    term.feed('\r') // Provider A
    await settle()
    term.feed('sk-first-key')
    term.feed('\r')
    await settle()
    term.feed('sk-second-key')
    term.feed('\r')
    await settle()
    expect(test).toHaveBeenCalledTimes(2)
    pending[0]?.resolve(VERIFIED_A) // stale verification of the superseded key
    await settle()
    pending[1]?.resolve({ verified: false, models: [] }) // the key actually in use fails
    await settle()
    term.feed('\r')
    await settle()
    expect(save).not.toHaveBeenCalled()
    expect((await screenOf(term, 80, 24)).join('\n')).toContain('Could not verify that key')
  })

  it('a late failure of a superseded key leaves the verified key in use', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, save, pending } = stubClient()
    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r') // API key
    await settle()
    term.feed('\r') // Provider A
    await settle()
    term.feed('sk-first-key')
    term.feed('\r')
    await settle()
    term.feed('sk-second-key')
    term.feed('\r')
    await settle()
    pending[1]?.resolve(VERIFIED_A) // the key in use verifies first
    await settle()
    pending[0]?.resolve({ verified: false, models: [] }) // the superseded key fails afterwards
    await settle()
    term.feed('\r') // Model A
    await settle()
    await expect(done).resolves.toEqual(SAVED)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'provider-a', apiKey: 'sk-second-key' }),
    )
  })
})

describe('dbh M-04 (second source): real SDK client + daemon config methods + Host ConfigurationService', () => {
  it('no provider-model probe for B carries the key typed for A', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dbh-m04-home-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'dbh-m04-data-'))
    tmp.push(home, dataDir)
    // Zero network: anything that bypasses the injected request fails loudly and is counted.
    const globalFetch = vi.fn(async () => {
      throw new Error('network disabled in dbh-m04')
    })
    vi.stubGlobal('fetch', globalFetch)
    const requests: Array<{ host: string; authorization: string | undefined }> = []
    const gate = deferred<void>()
    let modelsA: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      requests.push({ host: url.host, authorization: headers.Authorization })
      if (url.host === 'api.deepseek.com') {
        await gate.promise
        return new Response(JSON.stringify({ data: modelsA.map((id) => ({ id })) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    const configuration = createConfigurationService({ home, profile: 'local-dev', request })
    const { host } = await createTestHost({ dataDir, script: [] })
    const endpoint = createLocalEndpoint(host, { pollMs: 5, configuration })
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    try {
      const { providers } = await client.config.providers()
      // The flow below picks list positions 0 and 1; pin what they are.
      expect(providers.slice(0, 2).map((p) => p.id)).toEqual(['deepseek', 'openai'])
      // Static reviewed catalogue for A, obtained without a key (no request is made).
      modelsA = (await client.config.test({ providerId: 'deepseek' })).models.map((m) => m.id)
      expect(modelsA.length).toBeGreaterThan(0)
      expect(requests).toEqual([])
      const snapshot = await client.config.get()

      const term = new FakeTerminal({ columns: 80, rows: 24 })
      let outcome: unknown
      const done = runOnboardingTui(client, snapshot, term).then(
        (v) => {
          outcome = { resolved: v }
        },
        (e: Error) => {
          outcome = { rejected: e.message }
        },
      )
      await settle()
      term.feed('\x1b[B')
      term.feed('\r') // API key
      await vi.waitFor(async () =>
        expect((await screenOf(term, 80, 24)).join('\n')).toContain('Select a provider:'),
      )
      term.feed('\r') // DeepSeek (A)
      await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('API key'))
      term.feed(KEY_A)
      term.feed('\r')
      await vi.waitFor(() => expect(requests.length).toBe(1)) // A's probe is in flight
      // Harness control: the in-flight probe is A's endpoint with A's key.
      expect(requests[0]).toEqual({ host: 'api.deepseek.com', authorization: `Bearer ${KEY_A}` })
      term.feed('\x1b')
      await vi.waitFor(async () =>
        expect((await screenOf(term, 80, 24)).join('\n')).toContain('Select a provider:'),
      )
      term.feed('\x1b[B')
      term.feed('\r') // OpenAI (B)
      await vi.waitFor(async () =>
        expect((await screenOf(term, 80, 24)).join('\n')).toContain('OpenAI API key'),
      )
      gate.resolve()
      // Give the stale A result every chance to be applied, then press enter as the user would.
      await new Promise((r) => setTimeout(r, 100))
      term.feed('\r')
      await Promise.race([done, new Promise((r) => setTimeout(r, 1000))])

      const toOtherHostsWithKeyA = requests.filter(
        (r) => r.host !== 'api.deepseek.com' && r.authorization === `Bearer ${KEY_A}`,
      )
      expect(globalFetch).not.toHaveBeenCalled()
      expect(toOtherHostsWithKeyA, `onboarding outcome: ${JSON.stringify(outcome)}`).toEqual([])
    } finally {
      await client.close()
      await endpoint.close()
      await host.close()
    }
  })
})

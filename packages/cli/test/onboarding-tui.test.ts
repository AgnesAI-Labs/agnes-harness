import type { Client } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { runOnboardingTui } from '../src/onboarding/tui.js'
import { FakeTerminal } from '../src/tui/terminal.js'
import { screenOf } from './tui/harness.js'

const UNCONFIGURED = { profile: 'local-dev', revision: 1, configured: false } as never

const SAVED = {
  profile: 'local-dev',
  revision: 2,
  configured: true,
  effect: 'ready',
}

/** Lets the driver's pending config calls settle before the next keystroke is fed. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function stubClient(overrides: Record<string, unknown> = {}): {
  client: Client
  test: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
} {
  const test = vi.fn().mockResolvedValue({
    verified: true,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  })
  const save = vi.fn().mockResolvedValue(SAVED)
  const client = {
    config: {
      providers: vi.fn().mockResolvedValue({
        providers: [
          {
            id: 'deepseek',
            label: 'DeepSeek',
            api: 'openai-compatible',
            baseUrl: 'https://api.deepseek.test',
          },
          { id: 'openai', label: 'OpenAI', api: 'openai-compatible', baseUrl: 'https://api.openai.test' },
        ],
      }),
      test,
      save,
      ...overrides,
    },
  } as unknown as Client
  return { client, test, save }
}

describe('first-run onboarding TUI', () => {
  it('uses the subscription operation instead of an API-key prompt and commits the chosen model', async () => {
    const term = new FakeTerminal({ columns: 100, rows: 24 })
    const oauth = vi.fn(async (input: { action: string }) =>
      input.action === 'commit'
        ? { operationId: 'op', state: 'saved', snapshot: SAVED }
        : { operationId: 'op', state: 'ready', models: [{ id: 'codex-model', name: 'Codex Model' }] },
    )
    const { client, test, save } = stubClient({
      oauth,
      providers: async () => ({
        providers: [
          {
            id: 'openai-codex',
            label: 'OpenAI Codex',
            authType: 'oauth',
            api: 'openai-codex-responses',
            baseUrl: 'https://chatgpt.com/backend-api',
          },
        ],
      }),
    })
    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r')
    await settle()
    term.feed('\r')
    await settle() // Provider
    expect((await screenOf(term, 100, 24)).join('\n')).toContain('Device code login')
    term.feed('\r')
    await settle() // Browser
    await vi.waitFor(() =>
      expect(oauth).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'start', loginMethod: 'browser' }),
      ),
    )
    await settle()
    term.feed('\r')
    await settle() // Model
    await expect(done).resolves.toEqual(SAVED)
    expect(oauth).toHaveBeenCalledWith({ action: 'commit', operationId: 'op', model: 'codex-model' })
    expect(test).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
  it('paints both authentication choices when it starts', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const client = { config: {} } as unknown as Client

    void runOnboardingTui(client, UNCONFIGURED, term)
    await Promise.resolve()

    const screen = (await screenOf(term, 80, 24)).join('\n')
    expect(screen).toContain('Sign in with an Agnes account')
    expect(screen).toContain('Sign in with an API key')
  })

  it('saves the chosen provider, key and model through client.config', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, test, save } = stubClient()

    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()

    term.feed('\x1b[B') // move off 'Agnes account'
    term.feed('\r') // choose 'API key'
    await settle()
    term.feed('\r') // choose the first provider, DeepSeek
    await settle()
    term.feed('sk-secret-value')
    term.feed('\r') // submit the key
    await settle()
    term.feed('\r') // choose the first model
    await settle()

    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.test',
        apiKey: 'sk-secret-value',
      }),
    )
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'deepseek',
        apiKey: 'sk-secret-value',
        model: 'deepseek-chat',
        expectedRevision: 1,
      }),
    )
    await expect(done).resolves.toEqual(SAVED)
  })

  it('cancels without saving when escape is pressed on the root selector', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, save } = stubClient()

    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b')
    await settle()

    await expect(done).resolves.toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  // ghostty, kitty and WezTerm get the kitty keyboard protocol, which sends escape as CSI 27 u and
  // ctrl+c as CSI 99;5u. The selectors read raw input without knowing that and used to swallow both.
  const GHOSTTY = { NO_COLOR: '1', TERM_PROGRAM: 'ghostty' }

  it('cancels on the root selector when a kitty-protocol terminal sends escape', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 }, GHOSTTY)
    const { client, save } = stubClient()

    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[27u')
    await settle()

    await expect(done).resolves.toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('escape on the key prompt still goes back rather than cancelling, under the kitty protocol', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 }, GHOSTTY)
    const { client } = stubClient()
    let settled = false

    void runOnboardingTui(client, UNCONFIGURED, term).then(() => {
      settled = true
    })
    await settle()
    term.feed('\x1b[B')
    term.feed('\r')
    await settle()
    term.feed('\r')
    await settle()
    term.feed('\x1b[27u')
    await settle()

    expect((await screenOf(term, 80, 24)).join('\n')).toContain('Select a provider:')
    expect(settled).toBe(false)
  })

  // Every hint on these screens says "ctrl+c cancel". The views hand ctrl+c back unhandled, so the
  // flow itself has to act on it.
  it.each([
    { name: 'legacy ctrl+c on the root selector', env: { NO_COLOR: '1' }, before: [], key: '\x03' },
    {
      name: 'kitty ctrl+c on the key prompt',
      env: GHOSTTY,
      before: ['\x1b[B', '\r', '\r'],
      key: '\x1b[99;5u',
    },
  ])('$name cancels without saving', async ({ env, before, key }) => {
    const term = new FakeTerminal({ columns: 80, rows: 24 }, env)
    const { client, save } = stubClient()

    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    for (const input of before) {
      term.feed(input)
      await settle()
    }
    term.feed(key)
    await settle()

    await expect(done).resolves.toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('after a rejected key, escape back and a new key saves only that key', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const test = vi
      .fn()
      .mockRejectedValueOnce(new Error('401 Unauthorized'))
      .mockResolvedValue({ verified: true, models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })
    const { client, save } = stubClient({ test })

    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r')
    await settle()
    term.feed('\r')
    await settle()
    term.feed('sk-rejected')
    term.feed('\r')
    await settle()
    expect((await screenOf(term, 80, 24)).join('\n')).toContain('Could not verify that key')
    // The failure notice says "Press escape to go back and try again".
    term.feed('\x1b')
    await settle()
    term.feed('\r') // DeepSeek again
    await settle()
    term.feed('sk-accepted')
    term.feed('\r')
    await settle()
    term.feed('\r')
    await settle()

    await expect(done).resolves.toEqual(SAVED)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'deepseek', apiKey: 'sk-accepted', model: 'deepseek-chat' }),
    )
  })

  it('never renders the key after the provider rejects it', async () => {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    const { client, save } = stubClient({
      test: vi.fn().mockRejectedValue(new Error('401 Unauthorized for key sk-secret-value')),
    })

    void runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r')
    await settle()
    term.feed('\r')
    await settle()
    term.feed('sk-secret-value')
    term.feed('\r')
    await settle()

    const screen = (await screenOf(term, 80, 24)).join('\n')
    expect(screen).not.toContain('sk-secret-value')
    expect(screen).toContain('Could not verify that key')
    expect(save).not.toHaveBeenCalled()
  })
})

// DBH CONC-003 verification. Production entry: runOnboardingTui (packages/cli/src/onboarding/tui.ts),
// which bin.ts:640-648 calls on an unconfigured first run. Real Select component
// (packages/cli-tui/src/components/select.ts), real FakeTerminal key routing.
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// Oracle, independent of onboarding/tui.ts's model-select branch:
//   - packages/cli-tui/src/components/select.ts:30-34 and :39-46 -- Enter and the digit keys both
//     call `onChoose` every time, with no one-shot latch, so a Select cannot be the thing that
//     de-duplicates. Guarding the effect is the caller's job.
//   - packages/cli/src/onboarding/tui.ts:49/:325 -- the same file's `attempt` counter is the
//     author's own precedent for guarding a repeated keystroke against an in-flight async effect.
//   - onboarding/tui.ts:270 mints a fresh `accountId: acct-${randomUUID()}` on every call, so a
//     second save is not idempotent: it writes a second account for the same credential.
// The window is not narrow: onboarding/tui.ts:233 says saving "will send a test request to the
// selected model", i.e. a real round trip, and `child` is not replaced for its whole duration
// (tui.ts:54-57 forwards every keystroke to `child` unconditionally).
import type { Client } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { runOnboardingTui } from '../src/onboarding/tui.js'
import { FakeTerminal } from '../src/tui/terminal.js'

const UNCONFIGURED = { profile: 'local-dev', revision: 1, configured: false, accounts: [] } as never
const SAVED = { profile: 'local-dev', revision: 2, configured: true, effect: 'ready' }

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function gatedClient() {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const save = vi.fn(async () => {
    await gate
    return SAVED
  })
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
        ],
      }),
      test: vi.fn().mockResolvedValue({
        verified: true,
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      }),
      save,
    },
  } as unknown as Client
  return { client, save, release: () => release() }
}

/** Drives the API-key flow to the model selector, then presses Enter `enters` times. */
async function chooseModel(enters: number) {
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const g = gatedClient()
  const done = runOnboardingTui(g.client, UNCONFIGURED, term)
  await settle()
  term.feed('\x1b[B') // move off 'Agnes account'
  term.feed('\r') // choose 'API key'
  await settle()
  term.feed('\r') // choose the first provider, DeepSeek
  await settle()
  term.feed('sk-secret-value')
  term.feed('\r') // submit the key
  await settle()
  for (let i = 0; i < enters; i++) {
    term.feed('\r') // choose the first model
    await settle()
  }
  g.release()
  await Promise.race([done, new Promise((r) => setTimeout(r, 2_000))])
  await settle()
  return {
    saves: g.save.mock.calls.length,
    accountIds: g.save.mock.calls.map((c) => ((c as unknown[])[0] as { accountId?: string }).accountId),
  }
}

describe('DBH CONC-003: a second Enter on the model selector must not save twice', () => {
  it('[control] one Enter saves exactly once', async () => {
    const r = await chooseModel(1)
    expect(r.saves).toBe(1)
  }, 20_000)

  it('two Enters while the save is in flight still save exactly once', async () => {
    const r = await chooseModel(2)
    expect(r.saves, `accountIds=${JSON.stringify(r.accountIds)}`).toBe(1)
  }, 20_000)

  // Preservation: the OAuth branch keeps the selector open after a failed commit and tells the user
  // to retry (onboarding/tui.ts:267). A latch that is taken but never released would turn that
  // notice into a lie -- the screen would still invite a retry that can no longer happen.
  it('[preserve] a failed OAuth commit can still be retried from the same selector', async () => {
    const term = new FakeTerminal({ columns: 100, rows: 24 })
    let commits = 0
    const oauth = vi.fn(async (input: { action: string }) => {
      if (input.action !== 'commit')
        return { operationId: 'op', state: 'ready', models: [{ id: 'codex-model', name: 'Codex Model' }] }
      commits++
      if (commits === 1) throw new Error('commit failed')
      return { operationId: 'op', state: 'saved', snapshot: SAVED }
    })
    const client = {
      config: {
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
        oauth,
      },
    } as unknown as Client
    const done = runOnboardingTui(client, UNCONFIGURED, term)
    await settle()
    term.feed('\x1b[B')
    term.feed('\r')
    await settle()
    term.feed('\r') // provider
    await settle()
    term.feed('\r') // device-code / browser login
    await vi.waitFor(() => expect(oauth).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' })))
    await settle()
    term.feed('\r') // model -- first commit rejects
    await settle()
    term.feed('\r') // model again -- must be allowed through
    await settle()
    await Promise.race([done, new Promise((r) => setTimeout(r, 2_000))])
    expect(commits).toBe(2)
  }, 20_000)
})

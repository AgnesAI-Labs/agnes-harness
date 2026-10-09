import { execFile } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { openLoginBrowser } from '../src/login-browser.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('@agnes/host', () => ({ createPlatform: () => ({ os: 'darwin' }) }))

describe('OAuth browser admission', () => {
  it('opens an exact reviewed HTTPS origin and refuses ambiguous or secret-bearing URLs', () => {
    vi.mocked(execFile).mockClear()
    const signal = new AbortController().signal
    const valid = 'https://auth.openai.com/authorize?request=opaque'
    openLoginBrowser(valid, signal)
    expect(execFile).toHaveBeenCalledWith(
      'open',
      [valid],
      { signal, timeout: 10_000, windowsHide: true },
      expect.any(Function),
    )
    for (const invalid of [
      'http://auth.openai.com/authorize',
      'https://auth.openai.com.evil.invalid/authorize',
      'https://user@auth.openai.com/authorize',
      'https://auth.openai.com/authorize#access_token=synthetic',
      'not a URL',
    ])
      openLoginBrowser(invalid, signal)
    const cancelled = new AbortController()
    cancelled.abort()
    openLoginBrowser(valid, cancelled.signal)
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})

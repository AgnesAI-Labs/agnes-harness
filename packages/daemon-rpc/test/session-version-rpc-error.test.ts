import { describe, expect, it } from 'vitest'
import { throwSessionOpenRpcError } from '../src/local/methods/acp.js'

const refusal = (error: unknown) => {
  try {
    throwSessionOpenRpcError(error)
  } catch (thrown) {
    return thrown as { data: Record<string, unknown> }
  }
  throw new Error('expected a refusal')
}

describe('session open refusals for a version difference', () => {
  it.each([
    ['E_SESSION_VERSION_NEWER', 'newer', ['upgrade']],
    ['E_SESSION_VERSION_OLDER', 'older', ['new-session', 'repin']],
    ['E_SESSION_CORRUPT', 'corrupt', ['new-session']],
  ])('answers %s with its direction, next actions and text in both languages', (code, issue, actions) => {
    const failure = refusal({
      code,
      detail: { sessionKey: 's-1', cause: 'E_SEAM_PIN_MISMATCH', ledgerPath: '/data/sessions.db' },
    })
    expect(failure.data).toMatchObject({
      code,
      issue,
      actions,
      reason: 'E_SEAM_PIN_MISMATCH',
      localized: { en: expect.stringContaining('s-1'), 'zh-CN': expect.stringContaining('你') },
    })
    expect((failure.data.localized as { en: string }).en).toContain('/data/sessions.db')
  })
})

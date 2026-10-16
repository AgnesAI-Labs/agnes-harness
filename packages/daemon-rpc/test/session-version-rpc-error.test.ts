import { describe, expect, it } from 'vitest'
import { throwSessionOpenRpcError } from '../src/local/methods/acp.js'

const refusal = (error: unknown, sessionId?: string) => {
  try {
    throwSessionOpenRpcError(error, sessionId)
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
    ['E_LEDGER_INTEGRITY', 'corrupt', ['new-session'], 'E_SESSION_CORRUPT'],
  ])(
    'answers %s with its direction, next actions and text in both languages',
    (code, issue, actions, expectedCode = code) => {
      const failure = refusal(
        {
          code,
          detail: { sessionKey: 's-1', cause: 'E_SEAM_PIN_MISMATCH', ledgerPath: '/data/sessions.db' },
        },
        'different-request',
      )
      expect(failure.data).toMatchObject({
        code: expectedCode ?? code,
        issue,
        actions,
        reason: 'E_SEAM_PIN_MISMATCH',
        localized: { en: expect.stringContaining('s-1'), 'zh-CN': expect.stringContaining('你') },
      })
      expect((failure.data.localized as { en: string }).en).toContain('/data/sessions.db')
      const relayed = refusal({ code }, 's-1')
      expect(relayed.data).toMatchObject({
        code: expectedCode ?? code,
        issue,
        actions,
        localized: { en: expect.stringContaining('s-1'), 'zh-CN': expect.stringContaining('s-1') },
      })
      expect(relayed.data.reason).toBeUndefined()
    },
  )
})

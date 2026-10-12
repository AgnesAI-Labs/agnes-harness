import { describe, expect, it } from 'vitest'
import { errorMessageKey, SESSION_VERSION_CODES, sessionVersionNotice } from '../src/index.js'

const facts = { sessionId: 'sess-1', ledgerPath: '/data/sessions.db' }

describe('session version notices', () => {
  it('gives each direction its own code, actions and bilingual text that names the session and its ledger', () => {
    const newer = sessionVersionNotice('newer', facts)
    const older = sessionVersionNotice('older', {
      ...facts,
      reason: 'the pinned approval is gone',
      repinnable: true,
    })
    const corrupt = sessionVersionNotice('corrupt', facts)
    expect([newer.code, older.code, corrupt.code]).toEqual([
      'E_SESSION_VERSION_NEWER',
      'E_SESSION_VERSION_OLDER',
      'E_SESSION_CORRUPT',
    ])
    expect(newer.actions).toEqual(['upgrade'])
    expect(older.actions).toEqual(['new-session', 'repin'])
    expect(corrupt.actions).toEqual(['new-session'])
    for (const notice of [newer, older, corrupt]) {
      expect(notice.message.en).toContain('sess-1')
      expect(notice.message.en).toContain('/data/sessions.db')
      expect(notice.message['zh-CN']).toContain('sess-1')
      expect(notice.message['zh-CN']).toContain('/data/sessions.db')
      expect(notice.message['zh-CN']).toContain('你')
    }
    expect(older.message.en).toMatch(/start a new session/)
    expect(older.message.en).toMatch(/switch this session to the current version|switch this session/)
    expect(older.message['zh-CN']).toContain('新开一个会话')
    expect(older.message['zh-CN']).toContain('切换到当前版本')
  })

  it('only offers the explicit switch when an administrator can perform it', () => {
    expect(sessionVersionNotice('older', facts).actions).toEqual(['new-session'])
    expect(sessionVersionNotice('older', facts).message.en).not.toMatch(/switch this session/)
  })

  it('maps the codes onto localized client message keys', () => {
    expect(errorMessageKey(SESSION_VERSION_CODES.newer)).toBe('appServer.errors.sessionNewer')
    expect(errorMessageKey(SESSION_VERSION_CODES.older)).toBe('appServer.errors.sessionOlder')
    expect(errorMessageKey('E_SEAM_PIN_CHANGE')).toBe('appServer.errors.sessionOlder')
    expect(errorMessageKey(SESSION_VERSION_CODES.corrupt)).toBe('appServer.errors.sessionCorrupt')
  })
})

import { describe, expect, it } from 'vitest'
import { McpLoginRefused, parsePastedCallback } from '../../src/mcp-login/paste.js'

const expected = { redirectUri: 'http://localhost:4123/callback', state: 'state-1' }

describe('a pasted callback address', () => {
  it('a pasted full URL completes the login', () => {
    expect(
      parsePastedCallback('  http://localhost:4123/callback?code=abc&state=state-1 \n', expected),
    ).toEqual({
      code: 'abc',
    })
  })

  it('a pasted code or query string alone is rejected', () => {
    for (const text of [
      'abc',
      'code=abc&state=state-1',
      '?code=abc&state=state-1',
      '/callback?code=abc&state=state-1',
    ])
      expect(() => parsePastedCallback(text, expected)).toThrow(/full address/)
  })

  it('state mismatch is rejected', () => {
    expect(() =>
      parsePastedCallback('http://localhost:4123/callback?code=abc&state=other', expected),
    ).toThrow(/does not belong to this sign-in/)
    expect(() => parsePastedCallback('http://localhost:4123/callback?code=abc', expected)).toThrow(
      /does not belong to this sign-in/,
    )
  })

  it('origin or path mismatch is rejected', () => {
    for (const text of [
      'https://localhost:4123/callback?code=abc&state=state-1',
      'http://127.0.0.1:4123/callback?code=abc&state=state-1',
      'http://localhost:4124/callback?code=abc&state=state-1',
      'http://localhost:4123/other?code=abc&state=state-1',
      'http://evil.example/callback?code=abc&state=state-1',
    ])
      expect(() => parsePastedCallback(text, expected)).toThrow(/not this sign-in's callback address/)
  })

  it('a matching address without a code is rejected', () => {
    expect(() => parsePastedCallback('http://localhost:4123/callback?state=state-1', expected)).toThrow(
      /no code/,
    )
  })

  it('error= in the pasted URL is reported', () => {
    let caught: unknown
    try {
      parsePastedCallback(
        'http://localhost:4123/callback?error=access_denied&error_description=User%20said%20no&state=state-1',
        expected,
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpLoginRefused)
    expect((caught as McpLoginRefused).error).toBe('access_denied')
    expect((caught as Error).message).toContain('access_denied')
    expect((caught as Error).message).toContain('User said no')
  })

  it('control characters from the authorization server do not reach the terminal', () => {
    expect(() =>
      parsePastedCallback(
        'http://localhost:4123/callback?error=x%1B%5B2J&error_description=a%07b&state=state-1',
        expected,
      ),
    ).toThrow('the authorization server refused the sign-in: x [2J (a b)')
  })

  it('an empty paste cancels', () => {
    expect(parsePastedCallback('', expected)).toBe('cancel')
    expect(parsePastedCallback('   \n', expected)).toBe('cancel')
  })
})

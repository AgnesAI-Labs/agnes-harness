import { describe, expect, it } from 'vitest'
import { CHANNEL_ERRORS, ChannelError, isChannelError } from '../src/index.js'

describe('ChannelError', () => {
  it('has the seven-code closed set', () => {
    expect(CHANNEL_ERRORS).toEqual([
      'E_MANIFEST_INVALID',
      'E_CONFIG_INVALID',
      'E_SECRETS_UNREADABLE',
      'E_CONNECT_FAILED',
      'E_DAEMON_UNAVAILABLE',
      'E_CAPABILITY_MISSING',
      'E_NOT_IMPLEMENTED',
    ])
  })

  it('carries a stable code and optional structured detail', () => {
    const error = new ChannelError('E_CONFIG_INVALID', 'connect missing', { key: 'connect' })

    expect(isChannelError(error)).toBe(true)
    expect(error).toMatchObject({
      name: 'ChannelError',
      code: 'E_CONFIG_INVALID',
      detail: { key: 'connect' },
    })
    expect(error.message).toBe('E_CONFIG_INVALID: connect missing')
    expect(isChannelError(new Error('E_CONFIG_INVALID: forged'))).toBe(false)
  })
})

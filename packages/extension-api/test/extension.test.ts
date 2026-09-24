import { describe, expect, it } from 'vitest'
import { defineExtension } from '../src/index.js'

describe('defineExtension', () => {
  it('is identity and preserves the function', async () => {
    const f = defineExtension((agnes) => {
      agnes.ctx.log.info('hi')
    })
    expect(typeof f).toBe('function')
    const calls: string[] = []
    const fakeApi = {
      ctx: {
        log: {
          info: (m: string) => calls.push(m),
          debug() {},
          warn() {},
          error() {},
        },
      },
    }
    await f(fakeApi as never)
    expect(calls).toEqual(['hi'])
  })
})

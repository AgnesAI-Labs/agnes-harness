import { describe, expect, it } from 'vitest'

describe('cli export surface and guards', () => {
  it('keeps root runtime exports stable', async () => {
    const mod = await import('../src/index.js')
    expect(Object.keys(mod).sort()).toMatchSnapshot()
  }, 15_000)
})

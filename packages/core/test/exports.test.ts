import { expect, it } from 'vitest'

it('keeps the public runtime export surface stable', async () => {
  expect(Object.keys(await import('@agnes/core')).sort()).toMatchSnapshot()
})

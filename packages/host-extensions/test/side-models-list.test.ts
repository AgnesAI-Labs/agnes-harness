import { expect, it } from 'vitest'
import { rowApiFixture } from './fixtures/row-api.js'

const models = [
  { route: 'jev', model: 'model-a', api: 'jev', endpoint: 'https://private.invalid', apiKey: 'private' },
  { route: 'chat', model: 'small', api: 'responses', credentialRef: 'secret://hidden' },
]
it('lists route, model and api without endpoint or credentials', async () => {
  const f = rowApiFixture({ sideCall: true }, { sideCallDeclared: true, sideModels: () => models })
  const entries = await f.api.ctx.sideModels!.list()
  expect(entries).toEqual([
    { route: 'jev', model: 'model-a', api: 'jev' },
    { route: 'chat', model: 'small', api: 'responses' },
  ])
  expect(Object.isFrozen(entries)).toBe(true)
  expect(Object.isFrozen(entries[0])).toBe(true)
  f.controller.abort()
  await expect(f.api.ctx.sideModels!.list()).rejects.toThrow(/closed/)
})
it('is absent without the sideCall grant or declaration', () => {
  expect(
    rowApiFixture({}, { sideCallDeclared: true, sideModels: () => models }).api.ctx.sideModels,
  ).toBeUndefined()
  expect(rowApiFixture({ sideCall: true }, { sideModels: () => models }).api.ctx.sideModels).toBeUndefined()
})
it('reads the current provider catalogue only when requested', async () => {
  let current = models
  const f = rowApiFixture({ sideCall: true }, { sideCallDeclared: true, sideModels: () => current })
  current = []
  expect(await f.api.ctx.sideModels!.list()).toEqual([])
})

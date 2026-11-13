import { expect, it } from 'vitest'
import { fixtureTool } from '../../host/test/fixtures/tool.js'
import { rowApiFixture } from './fixtures/row-api.js'

it('reads only live own projection names in installed hook and tool contexts', async () => {
  const names = new Set(['own'])
  const f = rowApiFixture({}, { projectionNames: () => [...names] })
  f.api.registerHook('turn_stopping', async (_payload, ctx) => {
    const result = await ctx.projections.readOwn('own')
    expect(result).toMatchObject({ status: 'available', value: { count: 1 } })
    await expect(ctx.projections.readOwn('other/own')).rejects.toThrow(/not declared/)
    return { action: 'stop' }
  })
  await f.registrations[0]!.handler({}, f.context)
  f.api.tools.register({
    ...fixtureTool('test_read'),
    async execute(_args, ctx) {
      expect(await ctx.projections.readOwn('own')).toMatchObject({ status: 'available' })
      return { content: [] }
    },
  })
  await f.tools[0]!.execute({}, { ...f.context, session: { key: 's', lane: 'main', depth: 0 } } as any)
  names.delete('own')
  await expect(f.registrations[0]!.handler({}, f.context)).rejects.toThrow(/not declared/)
  f.lease.revoke('retired')
  await expect(Promise.resolve().then(() => f.registrations[0]!.handler({}, f.context))).rejects.toThrow(
    /expired/i,
  )
})

it('rejects a read whose registration disappears while awaiting the fold', async () => {
  let names = ['own']
  const f = rowApiFixture({}, { projectionNames: () => names })
  f.ports.projections.read = async () => {
    names = []
    return { asOfSeq: 1, unit: { state: { count: 1 }, stateVersion: 1 } } as any
  }
  f.api.registerHook('turn_stopping', async (_payload, ctx) => {
    expect(await ctx.projections.readOwn('own')).toMatchObject({ status: 'unavailable' })
    return { action: 'stop' }
  })
  await f.registrations[0]!.handler({}, f.context)
})

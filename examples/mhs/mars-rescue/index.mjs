import { readFileSync } from 'node:fs'

/** Business policy is a Skill; MHS remains the owner of all seven device tools and admission. */
export const marsRescue = {
  inject: ['skills', 'profileRuntime'],
  apply(ctx) {
    const fleet = ctx.profileRuntime.register({
      id: 'fleet',
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      defaultConfig: {},
      async start(init) {
        init.onShutdown(async () => ({ state: 'settled' }))
        init.ready()
        return init
      },
    })
    for (const [name, target] of [
      ['mars.devices', 'mhs.producer'],
      ['mars.media', 'mhs.producer.media'],
    ])
      ctx.profileRuntime.streams.register(name, async (input, context) => {
        const current = await fleet.get()
        current.assertCurrent()
        await ctx.profileRuntime.connectProducer(
          { extension: 'plugin/91109187c405c716', name: target },
          input,
          context,
        )
      })
    ctx.skills.register({
      name: 'mars-rescue',
      description: 'Coordinate simulated Mars rescue, sampling and storm preparation using MHS.',
      body: readFileSync(new URL('./skills/rescue/SKILL.md', import.meta.url), 'utf8'),
    })
  },
}

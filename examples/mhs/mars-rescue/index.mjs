import { readFileSync } from 'node:fs'

/** Business policy is a Skill; MHS remains the owner of all seven device tools and admission. */
export const marsRescue = {
  inject: ['skills'],
  apply(ctx) {
    ctx.skills.register({
      name: 'mars-rescue',
      description: 'Coordinate simulated Mars rescue, sampling and storm preparation using MHS.',
      body: readFileSync(new URL('./skills/rescue/SKILL.md', import.meta.url), 'utf8'),
    })
  },
}

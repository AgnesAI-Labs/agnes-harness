import { rememberingSkill } from './generated.js'

/** The public Skills service owns discovery, revision pins and registration cleanup. */
export const rememberingPlugin = {
  inject: ['skills'],
  apply(ctx: {
    skills: { register(skill: { name: string; description: string; body: string }): () => void }
  }) {
    ctx.skills.register({
      name: 'remembering',
      description: 'Remember stable preferences, consolidate learned memory and respect file approval.',
      body: rememberingSkill,
    })
  },
}

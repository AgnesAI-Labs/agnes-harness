import type { PrincipalsSeam } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'

/**
 * The single-machine identity. Whoever is at the keyboard owns the machine, so every credential
 * arriving on any surface resolves to the same owner and every authorize() allows.
 *
 * This is a statement about the deployment, not a policy engine with the rules left out: an
 * installation that has more than one person in it fits a different principals implementation
 * through the profile, and nothing in the kernel changes.
 */
export const principalsLocal: SeamFactory<PrincipalsSeam> = async (ctx) => {
  // An Actor id is required to be non-empty by the session schema, and `??` does not catch the
  // empty string an exported-but-unset USER leaves behind - which is how a shell started by a
  // service manager arrives.
  const fromEnv = [process.env.USER, process.env.USERNAME, process.env.LOGNAME].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  )
  const id = fromEnv?.trim() ?? 'local'
  ctx.log.debug('principals-local resolved the machine owner', { id })
  return {
    async resolve(_cred, surface) {
      // The surface is recorded rather than acted on: it is the one thing about an inbound
      // credential that stays true after this seam has flattened everything else into one owner.
      return { id, org: 'local', role: 'owner', deptPath: [], attrs: { surface } }
    },
    async authorize() {
      return { decisionId: 'n/a', effect: 'allow', reason: 'local-owner' }
    },
  }
}

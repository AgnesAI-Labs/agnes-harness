import { toolPolicyKind } from '@agnes/extension-api'
import { policy } from './policy.mjs'

export { policy }
export const plugin = {
  inject: ['providers'],
  apply(ctx) {
    ctx.providers.register(toolPolicyKind, policy)
  },
}

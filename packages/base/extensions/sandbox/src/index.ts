import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'

export * from './availability.js'
export * from './policy.js'

// Pure policy slice only. It is deliberately not listed in package.json and registers nothing.
export default defineAgnesPlugin({
  apply() {},
})

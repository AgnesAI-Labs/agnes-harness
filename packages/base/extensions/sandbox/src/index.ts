import { defineExtension } from '@agnes/extension-api'

export * from './availability.js'
export * from './policy.js'

// Pure policy slice only. It is deliberately not listed in package.json and registers nothing.
export default defineExtension(() => undefined)

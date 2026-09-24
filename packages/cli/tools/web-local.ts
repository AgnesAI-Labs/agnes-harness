#!/usr/bin/env node
import { resolveLaunchResources } from '../launch/resources.js'
import { runWebCommand } from '../launch/web-command.js'

/** Development entry point; production uses the sibling resources in `dist/local`. */

await runWebCommand(process.argv.slice(2), {
  resources: resolveLaunchResources(import.meta.url, { allowSource: true }),
})

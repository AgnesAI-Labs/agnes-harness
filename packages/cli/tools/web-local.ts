#!/usr/bin/env node
import { startWebDevBuild } from '@agnes/web/dev'
import { resolveLaunchResources } from '../launch/resources.js'
import { runWebCommand } from '../launch/web-command.js'

/** Development entry point; production uses the sibling resources in `dist/local`. */

const frontend = await startWebDevBuild()
try {
  await runWebCommand(process.argv.slice(2), {
    resources: resolveLaunchResources(import.meta.url, { allowSource: true }),
    developmentReload: true,
    onWebServerReady: (web) => frontend.setOnRebuilt(() => web.reloadDevelopmentClients?.()),
  })
} finally {
  await frontend.close()
}

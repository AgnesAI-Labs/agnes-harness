import { createLauncher } from '../packages/package-manager/bundled-plugins/browser/src/launcher.mjs'
import { BrowserRuntime } from '../packages/package-manager/bundled-plugins/browser/src/runtime.mjs'

// Provision only the reviewed plugin payload, not Playwright's unrelated cache.
// Run through tools/toolchain/run.mjs; acceptance must not silently skip a missing browser.
console.info(
  'Browser acceptance runtime',
  JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }),
)
if (process.env.AGH_BROWSER_EXPECT_ARCH && process.arch !== process.env.AGH_BROWSER_EXPECT_ARCH)
  throw new Error('Browser acceptance runner architecture does not match its declared matrix entry.')
const launcher = createLauncher()
const runtime = new BrowserRuntime({ launch: () => launcher.launch() })
try {
  await new Promise((resolve, reject) => {
    const changed = () => {
      if (!['ready', 'failed'].includes(runtime.state)) return
      runtime.listeners.delete(changed)
      if (runtime.state === 'failed') reject(new Error(runtime.error))
      else resolve()
    }
    runtime.listeners.add(changed)
    launcher.prepare(runtime)
  })
} finally {
  await launcher.cancel()
  await runtime.close()
}

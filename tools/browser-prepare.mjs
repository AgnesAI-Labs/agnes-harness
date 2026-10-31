import { createServer } from 'node:http'
import { createLauncher } from '../packages/package-manager/bundled-plugins/browser/src/launcher.mjs'
import { BrowserRuntime } from '../packages/package-manager/bundled-plugins/browser/src/runtime.mjs'
import { showPage } from '../packages/package-manager/bundled-plugins/browser/src/streams.mjs'

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
  // The first start of a freshly unpacked browser pays one-time operating-system costs (code
  // signature and malware scans of the app, its helpers and graphics libraries): several
  // seconds on hosted macOS runners. Pay them here, not inside the first timed test. Start the
  // way the product does: open a page and wait for its first display frame. A screenshot is not
  // used: macOS Intel runners have no usable GPU, and while Chromium falls back to software
  // compositing a screenshot can find no surface ("Unable to capture screenshot").
  const started = performance.now()
  const site = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><p>Agnes</p>')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const viewer = new AbortController()
  try {
    const session = { key: 'browser-prepare', lane: 'main' }
    const opened = await runtime.act(session, {
      action: 'open',
      url: `http://127.0.0.1:${site.address().port}/`,
    })
    await new Promise((resolve, reject) => {
      showPage(
        runtime,
        { pageId: opened.pageId, displayVersion: 2 },
        {
          scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
          signal: viewer.signal,
          stream: {
            send() {
              resolve()
              return 'accepted'
            },
            close: (reason) => reject(new Error(`Browser display closed: ${reason}`)),
            onDisconnect() {},
          },
        },
      ).catch(reject)
    })
  } finally {
    viewer.abort()
    await new Promise((resolve) => site.close(resolve))
  }
  console.info('Browser first start', JSON.stringify({ ms: Math.round(performance.now() - started) }))
} finally {
  await launcher.cancel()
  await runtime.close()
}

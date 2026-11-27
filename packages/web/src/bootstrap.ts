import { backendFrame, frameFailure } from './backends/frame-context.js'
import { prepareLocalWorkbenchBoot, restoreInitialCloudLocation } from './backends/local-workbench-bus.js'

const params = new URLSearchParams(location.search)
const childFrame = backendFrame()

if (childFrame && params.has('connection')) {
  const { mountApplication } = await import('@agnes/web-ui')
  const { createElement } = await import('react')
  const { ConnectionPage } = await import('./backend-selector.js')
  const root = document.getElementById('app-root')
  if (!root) throw new Error('missing #app-root')
  mountApplication(root, createElement(ConnectionPage))
} else if (childFrame || params.has('admin')) {
  if (childFrame) document.body.dataset.aghBackendFrame = 'cloud'
  try {
    const { prepareRemoteFrontend } = await import('./remote-frontend.js')
    await prepareRemoteFrontend()
    if (params.has('admin')) await import('./recovery.js')
    else await import('./app.js')
  } catch (error) {
    frameFailure(error instanceof Error ? error.message : 'unavailable')
    if (!params.has('remote')) throw error
    const { mountApplication } = await import('@agnes/web-ui')
    const { createElement } = await import('react')
    const { RemoteFrontendFailure } = await import('./backend-selector.js')
    const root = document.getElementById('app-root')
    if (!root) throw error
    mountApplication(
      root,
      createElement(RemoteFrontendFailure, {
        message: error instanceof Error ? error.message : 'Remote connection failed / 远程连接失败',
      }),
    )
  }
} else {
  const boot = prepareLocalWorkbenchBoot()
  try {
    await import('./app.js')
  } finally {
    restoreInitialCloudLocation(boot)
  }
}

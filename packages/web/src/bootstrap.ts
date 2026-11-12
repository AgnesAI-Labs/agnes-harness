import { backendFrame, frameFailure } from './backends/frame-context.js'
import { selectedRemoteOrigin } from './remote-frontend.js'

/** Backend contexts own independent runtimes; the outer A workbench only navigates projections. */
if (
  !backendFrame() &&
  !new URLSearchParams(location.search).has('admin') &&
  selectedRemoteOrigin() !== location.origin
) {
  const { mountBackendWorkbench } = await import('./backends/workbench.js')
  mountBackendWorkbench()
} else if (new URLSearchParams(location.search).has('connection')) {
  const { mountApplication } = await import('@agnes/web-ui')
  const { createElement } = await import('react')
  const { ConnectionPage } = await import('./backend-selector.js')
  const root = document.getElementById('app-root')
  if (!root) throw new Error('missing #app-root')
  mountApplication(root, createElement(ConnectionPage))
} else {
  if (backendFrame()) document.body.dataset.aghBackendFrame = 'true'
  try {
    const { prepareRemoteFrontend } = await import('./remote-frontend.js')
    await prepareRemoteFrontend()
    if (new URLSearchParams(location.search).has('admin')) await import('./recovery.js')
    else await import('./app.js')
  } catch (error) {
    frameFailure(error instanceof Error ? error.message : 'unavailable')
    if (!new URLSearchParams(location.search).has('remote')) throw error
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
}

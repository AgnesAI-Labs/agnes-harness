/** Choose recovery before importing the workbench, client roster, app roles or app navigation. */
if (new URLSearchParams(location.search).has('connection')) {
  const { mountApplication } = await import('@agnes/web-ui')
  const { createElement } = await import('react')
  const { ConnectionPage } = await import('./backend-selector.js')
  const root = document.getElementById('app-root')
  if (!root) throw new Error('missing #app-root')
  mountApplication(root, createElement(ConnectionPage))
} else {
  try {
    const { prepareRemoteFrontend } = await import('./remote-frontend.js')
    await prepareRemoteFrontend()
    if (new URLSearchParams(location.search).has('admin')) await import('./recovery.js')
    else await import('./app.js')
  } catch (error) {
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

export {}

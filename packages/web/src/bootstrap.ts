/** Choose recovery before importing the workbench, client roster, app roles or app navigation. */
if (new URLSearchParams(location.search).has('admin')) {
  await import('./recovery.js')
} else {
  await import('./app.js')
}

export {}

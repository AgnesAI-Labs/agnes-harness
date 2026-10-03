// Web renderer for the status card view, example.runtime-ui-bundle/status-card@1.
// manifest.json holds the renderer descriptor, so this module carries no package digest and its bytes
// do not depend on one. It has no imports and does nothing when it loads.

/** Shows the view as one line of text; returning text keeps the module free of a React import. */
export function component({ view }) {
  return `${view.data.title}: ${view.data.status}`
}

import { mountResourceAdmin } from './admin.js'

/**
 * Standalone host for `/admin/resources`.
 *
 * The embedded host receives the selected workspace from the workbench; the full page reads it from
 * the query string instead, so this is the only place that touches `location`.
 */
const workspaceId = new URLSearchParams(location.search).get('workspaceId')

document.getElementById('resource-return')?.addEventListener('click', () => {
  location.href = '/'
})
mountResourceAdmin(workspaceId ? { workspaceId } : {})

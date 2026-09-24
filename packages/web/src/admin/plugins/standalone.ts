import { mountPluginAdmin } from './admin.js'

/**
 * Standalone host for `/admin/plugins`.
 *
 * The local launcher validates its exact loopback Origin and Host at the BFF. This page therefore
 * needs only the "back to workbench" link; it does not receive or persist a browser credential.
 */
document.getElementById('return-workbench')?.addEventListener('click', () => location.assign('/'))
mountPluginAdmin()

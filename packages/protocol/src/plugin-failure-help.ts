export type PluginFailureHelp = Readonly<{ fixHint: string; docsUrl: string }>

/** Fixed, public advice; never echoes exception text, paths, configuration or credentials. */
export function pluginFailureHelp(reason: string): PluginFailureHelp {
  let fixHint = 'Check the plugin entry and activation logs, fix the package, then retry.'
  let anchor = 'troubleshooting'
  if (/missing[-_ ]?export|export.*(?:missing|not found|not (?:a )?function)/i.test(reason))
    fixHint = 'Export the function named in agnes.plugins and check package.json exports.'
  else if (/api.*(?:range|mismatch|incompatib)|(?:range|mismatch).*api/i.test(reason))
    fixHint = 'Install a compatible plugin version or update the Host to match its API range.'
  else if (
    /missing[-_ ]?inject|inject.*(?:missing|unavailable)|missing.*(?:service|dependency)|required.*service.*missing/i.test(
      reason,
    )
  )
    fixHint = 'Install and enable the provider of each required inject service.'
  else if (/schema|invalid.*config|config.*invalid/i.test(reason))
    fixHint = 'Correct the plugin manifest or configuration to match its schema.'
  else if (/capability|E_PACKAGE_BLOCKED|E_PACKAGE_TRUST|policy/i.test(reason)) {
    fixHint = 'Review agnes.capabilities and the administrator allow/deny policy before retrying.'
    anchor = 'capabilities'
  } else if (/frontend|client module|browser/i.test(reason))
    fixHint = 'Rebuild the frontend, verify its declared asset paths, then reload the page.'
  else if (/E_PACKAGE_SOURCE|archive|git.*ref/i.test(reason)) {
    fixHint = 'Use a real folder, a valid zip/tarball, or a credential-free HTTPS git URL.'
    anchor = 'sharing'
  }
  return {
    fixHint,
    docsUrl: 'https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/guide/packages.md#' + anchor,
  }
}

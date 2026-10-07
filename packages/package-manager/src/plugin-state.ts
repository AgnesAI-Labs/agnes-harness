/** Public diagnostics classify failures without forwarding exception text, paths or credentials. */
export function publicPluginFailureReason(reason: string): string {
  if (/missing[-_ ]?export|export.*(?:missing|not found|not (?:a )?function)/i.test(reason))
    return 'Plugin export is missing.'
  if (/api.*(?:range|mismatch|incompatib)|(?:range|mismatch).*api/i.test(reason))
    return 'Plugin API range is incompatible.'
  if (/missing[-_ ]?inject|inject.*(?:missing|unavailable)|missing.*(?:service|dependency)/i.test(reason))
    return 'A required plugin service is missing.'
  if (/schema|invalid.*config|config.*invalid/i.test(reason)) return 'Plugin configuration schema is invalid.'
  if (/capability.*block|blocked.*capability/i.test(reason)) return 'Plugin capability policy blocked activation.'
  if (/frontend.*(?:load|fail)|client module.*(?:load|fail)/i.test(reason))
    return 'Plugin frontend could not be loaded.'
  return 'Runtime activation failed.'
}

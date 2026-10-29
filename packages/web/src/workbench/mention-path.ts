/** UI navigation only. Outside paths retain their spelling for backend authorization. */
export function mentionPanelPath(root: string | undefined, path: string): string {
  if (!root) return path
  const windows = (value: string) =>
    /^[A-Za-z]:[\\/]/u.test(value) || /^(?:\\\\[^\\]+\\|\/\/[^/]+\/)/u.test(value)
  const normalize = (value: string) => {
    const slashed = windows(value)
      ? value.replace(/\\/gu, '/').replace(/^[a-z]:/u, (drive) => drive.toUpperCase())
      : value
    return slashed.replace(/\/+$/u, '') || '/'
  }
  if (windows(root) !== windows(path)) return path
  const base = normalize(root),
    target = normalize(path)
  // Do not turn an unresolved parent traversal into a workspace-relative navigation request.
  if ([base, target].some((value) => value.split('/').includes('..'))) return path
  if (target === base) return ''
  const prefix = base.endsWith('/') ? base : `${base}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : path
}

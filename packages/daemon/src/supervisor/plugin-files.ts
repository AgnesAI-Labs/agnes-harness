/** Text-only authoring input. Paths never select existing files on the daemon. */
export function checkedPluginFiles(value: unknown): { path: string; content: string }[] {
  const invalid = (): never => {
    throw new Error('PLUGIN_FILES_INVALID')
  }
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) return invalid()
  const paths = new Set<string>()
  let total = 0
  const files = value.map((file: unknown) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return invalid()
    const f = file as Record<string, unknown>
    if (
      Object.keys(f).sort().join(',') !== 'content,path' ||
      typeof f.path !== 'string' ||
      typeof f.content !== 'string'
    )
      return invalid()
    const segments = f.path.split('/')
    if (
      f.path.length > 240 ||
      segments.length > 8 ||
      segments.some(
        (s) =>
          !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(s) ||
          s.endsWith('.') ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) ||
          s.toLowerCase() === 'node_modules',
      )
    )
      return invalid()
    if (!/\.(mjs|json|md|txt|css)$/.test(f.path) && f.path !== 'LICENSE') return invalid()
    const key = f.path.toLowerCase()
    if ([...paths].some((p) => p === key || p.startsWith(`${key}/`) || key.startsWith(`${p}/`)))
      return invalid()
    paths.add(key)
    const size = Buffer.byteLength(f.content)
    total += size
    if (size > 256 * 1024 || total > 1024 * 1024 || f.content.includes('\0')) return invalid()
    return { path: f.path, content: f.content }
  })
  const manifest = files.find((f) => f.path === 'package.json')
  if (!manifest || !files.some((f) => f.path === 'index.mjs')) return invalid()
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(manifest.content)
  } catch {
    return invalid()
  }
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    Array.isArray(pkg) ||
    pkg.type !== 'module' ||
    pkg.exports !== './index.mjs' ||
    typeof pkg.name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/.test(pkg.name) ||
    pkg.name.startsWith('@agnes/') ||
    typeof pkg.version !== 'string'
  )
    return invalid()
  const allowed = [
    'name',
    'version',
    'description',
    'type',
    'license',
    'exports',
    'files',
    'engines',
    'agnes',
  ]
  if (Object.keys(pkg).some((key) => !allowed.includes(key))) return invalid()
  const agnes = pkg.agnes as Record<string, unknown> | undefined
  if (
    !agnes ||
    Object.keys(agnes).some((k) => !['plugins', 'clientDescriptors'].includes(k)) ||
    !Array.isArray(agnes.plugins) ||
    !agnes.plugins.length
  )
    return invalid()
  // Client contributions are limited to inert skin data. The package manager still checks its
  // descriptor schema, CSS/token restrictions and asset containment before admitting installation.
  const plugins = agnes.plugins
  const descriptors = agnes.clientDescriptors
  const skinRows = new Set<string>()
  if (descriptors !== undefined) {
    if (!Array.isArray(descriptors) || !descriptors.length) return invalid()
    for (const descriptor of descriptors) {
      if (
        !descriptor ||
        typeof descriptor !== 'object' ||
        Object.keys(descriptor).sort().join(',') !== 'path,rowId' ||
        typeof descriptor.rowId !== 'string' ||
        typeof descriptor.path !== 'string' ||
        !descriptor.path.startsWith('./') ||
        skinRows.has(descriptor.rowId)
      )
        return invalid()
      const file = files.find((f) => f.path === descriptor.path.slice(2))
      if (!file) return invalid()
      let data: Record<string, unknown>
      try {
        data = JSON.parse(file.content)
      } catch {
        return invalid()
      }
      if (
        !data ||
        Array.isArray(data) ||
        Object.keys(data).join(',') !== 'skins' ||
        !Array.isArray(data.skins) ||
        !data.skins.length
      )
        return invalid()
      skinRows.add(descriptor.rowId)
    }
  }
  for (const row of agnes.plugins) {
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).some((k) => !['id', 'export', 'inject'].includes(k)) ||
      (!(skinRows.has(row.id) && row.inject === undefined) &&
        (!Array.isArray(row.inject) ||
          !row.inject.length ||
          row.inject.some((s: unknown) => s !== 'extension' && s !== 'skills')))
    )
      return invalid()
  }
  if ([...skinRows].some((id) => !plugins.some((row) => row.id === id))) return invalid()
  return files
}

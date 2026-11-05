/** Shared on-disk contract for explicitly reviewed, complete Skill directories. */
export const SKILL_BUNDLE_MARKER = 'AGH-SKILL.json'
export const SKILL_BUNDLE_VERSION = 1
export const SKILL_BUNDLE_FRONTMATTER_KEYS = Object.freeze([
  'name',
  'description',
  'license',
  'metadata',
  'compatibility',
  'disable',
  'disable-model-invocation',
  'user-invocable',
])
export const SKILL_BUNDLE_LIMITS = Object.freeze({
  files: 2048,
  bytes: 32 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  depth: 16,
  entries: 4096,
})

export function isSkillBundlePath(path: string): boolean {
  if (!path || path.length > 2048 || path.includes('\\')) return false
  const parts = path.split('/')
  return (
    parts.length <= SKILL_BUNDLE_LIMITS.depth &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9._-]{1,128}$/.test(part) &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
        !['node_modules', '__pycache__', 'venv'].includes(part.toLowerCase()),
    )
  )
}

/** Editor, VCS and OS metadata (`.git*`, `.DS_Store`, `Thumbs.db`) that never belongs to a bundle. */
export function isSkillBundleIgnored(name: string): boolean {
  return name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name)
}

export function skillBundleFileKind(path: string): 'text' | 'binary' | undefined {
  if (!isSkillBundlePath(path)) return undefined
  const name = path.split('/').at(-1) ?? ''
  if (/^(LICENSE(?:-.*)?|NOTICE|COPYING|AUTHORS|README|CHANGELOG|Makefile|Dockerfile|Justfile)$/i.test(name))
    return 'text'
  if (
    /\.(md|txt|json|ya?ml|csv|js|mjs|cjs|ts|py|sh|bash|ps1|rb|html?|css|svg|xml|j2|jinja2?|toml|lock|tsx|jsx|go|rs|java|kt|swift|c|h|cpp|hpp|lua|php|pl|r|sql|ini|cfg|conf|xsd|xsl|xslt|rst|tex)$/i.test(
      name,
    )
  )
    return 'text'
  if (/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|otf|pdf|docx|xlsx|pptx|bmp|avif)$/i.test(name)) return 'binary'
  return undefined
}

export function isSkillBundleMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  return Object.keys(data).length === 1 && data.version === SKILL_BUNDLE_VERSION
}

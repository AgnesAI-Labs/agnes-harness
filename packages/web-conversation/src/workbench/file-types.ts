/** A tree row's type badge: a short extension label and the colour family it is drawn in. */
export type FileTypeTone = 'html' | 'css' | 'js' | 'ts' | 'json' | 'md' | 'svg' | 'image' | 'code' | 'other'
export type FileType = { label: string; tone: FileTypeTone }

/** Extension → [canonical extension, tone]; the badge shows the canonical extension in capitals. */
const TYPES: Record<string, readonly [string, FileTypeTone]> = {
  html: ['html', 'html'],
  htm: ['html', 'html'],
  css: ['css', 'css'],
  scss: ['scss', 'css'],
  less: ['less', 'css'],
  js: ['js', 'js'],
  mjs: ['js', 'js'],
  cjs: ['js', 'js'],
  jsx: ['jsx', 'js'],
  ts: ['ts', 'ts'],
  mts: ['ts', 'ts'],
  cts: ['ts', 'ts'],
  tsx: ['tsx', 'ts'],
  json: ['json', 'json'],
  jsonl: ['json', 'json'],
  md: ['md', 'md'],
  markdown: ['md', 'md'],
  svg: ['svg', 'svg'],
  png: ['png', 'image'],
  jpg: ['jpg', 'image'],
  jpeg: ['jpg', 'image'],
  gif: ['gif', 'image'],
  webp: ['webp', 'image'],
  ico: ['ico', 'image'],
  py: ['py', 'code'],
  sh: ['sh', 'code'],
  yml: ['yml', 'code'],
  yaml: ['yml', 'code'],
  toml: ['toml', 'code'],
  txt: ['txt', 'other'],
  csv: ['csv', 'other'],
  pdf: ['pdf', 'other'],
}

/** Undefined means no recognised extension: the row keeps the plain file icon. */
export function fileType(name: string): FileType | undefined {
  const dot = name.lastIndexOf('.')
  const type = dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined
  return type && { label: type[0].toUpperCase(), tone: type[1] }
}

/**
 * The files the Files tab can show rendered as well as as source. Each kind is drawn by a renderer the
 * deliverables preview already uses; images other than SVG are binary to a workspace read, so they
 * have no text to render and get no toggle.
 */
export type RenderedKind = 'html' | 'markdown' | 'svg'
export function renderedKind(path: string): RenderedKind | undefined {
  const type = fileType(path.slice(path.lastIndexOf('/') + 1))
  return type?.tone === 'html'
    ? 'html'
    : type?.tone === 'md'
      ? 'markdown'
      : type?.tone === 'svg'
        ? 'svg'
        : undefined
}

export function formatSize(size: number, locale?: string): string {
  if (size < 1024) return `${size} B`
  const [unit, label] = size >= 1024 * 1024 ? [1024 * 1024, 'MB'] : [1024, 'KB']
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size / unit)} ${label}`
}

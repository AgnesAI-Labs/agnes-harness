import type { PackageSource } from '@agnes/protocol'

export function sourceFromForm(type: string, ref: string): PackageSource | undefined {
  if (!ref) return undefined
  if (type === 'npm' || type === 'file' || type === 'workspace' || type === 'git') return { type, ref }
  return undefined
}

/** What each source type has to start with, and one complete example the field can show. */
export const SOURCE_FORMATS: Readonly<
  Record<PackageSource['type'], Readonly<{ prefix: string; example: string }>>
> = Object.freeze({
  npm: { prefix: 'npm:', example: 'npm:scope/package@1.2.3' },
  file: { prefix: 'file:./', example: 'file:./examples/packages/hot-service/v1' },
  workspace: { prefix: 'workspace:extensions/', example: 'workspace:extensions/my-extension' },
  git: { prefix: 'git:', example: 'git:https://example.com/org/repo.git#<40 位提交哈希>' },
})

/** A problem the page can see before asking the backend, or undefined when the reference looks right. */
export function sourceProblem(type: string, ref: string): string | undefined {
  if (!ref) return '请输入来源引用。'
  const format = type in SOURCE_FORMATS ? SOURCE_FORMATS[type as PackageSource['type']] : undefined
  if (!format) return '请选择来源类型。'
  if (!ref.startsWith(format.prefix))
    return `此类型的引用必须以“${format.prefix}”开头，例如 ${format.example}`
  return undefined
}

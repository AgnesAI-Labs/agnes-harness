import type { PackageSource } from '@agnes/protocol'
import { createCatalogTranslator, type LocaleTranslator } from '@agnes/web-ui'
import { pluginAdminLocaleCatalog } from './locales/admin.js'

const sourceText = createCatalogTranslator(pluginAdminLocaleCatalog, 'en')

export function sourceFromForm(type: string, ref: string): PackageSource | undefined {
  if (!ref) return undefined
  if (type === 'npm' || type === 'workspace') return { type, ref }
  if (type === 'file' || type === 'path' || type === 'git' || type === 'url')
    return { type, ref: ref.startsWith(type + ':') ? ref : type + ':' + ref }
  return undefined
}

/** What each source type has to start with, and one complete example the field can show. */
export const SOURCE_FORMATS: Readonly<
  Record<PackageSource['type'], Readonly<{ prefix: string; example: string }>>
> = Object.freeze({
  local: { prefix: 'local:', example: 'local:workspace/my-plugin' },
  npm: { prefix: 'npm:', example: 'npm:scope/package@1.2.3' },
  file: { prefix: 'file:', example: '/path/to/my-plugin.tgz' },
  path: { prefix: 'path:', example: '/path/to/my-plugin' },
  url: { prefix: 'url:', example: 'https://example.com/my-plugin.zip' },
  workspace: {
    prefix: 'workspace:extensions/',
    example: 'workspace:extensions/my-extension',
  },
  git: {
    prefix: 'git:',
    example: 'https://example.com/org/repo.git',
  },
})

/** A problem the page can see before asking the backend, or undefined when the reference looks right. */
export function sourceProblem(
  type: string,
  ref: string,
  t: LocaleTranslator = sourceText,
): string | undefined {
  if (!ref) return t('source.validation.missing')
  const format = type in SOURCE_FORMATS ? SOURCE_FORMATS[type as PackageSource['type']] : undefined
  if (!format) return t('source.validation.type')
  if (['file', 'path', 'git', 'url'].includes(type)) return undefined
  if (!ref.startsWith(format.prefix))
    return t('source.validation.prefix', { prefix: format.prefix, example: format.example })
  return undefined
}

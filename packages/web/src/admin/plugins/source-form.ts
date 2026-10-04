import type { PackageSource } from '@agnes/protocol'
import { createCatalogTranslator, type LocaleTranslator } from '@agnes/web-ui'
import { pluginAdminLocaleCatalog } from './locales/admin.js'

const sourceText = createCatalogTranslator(pluginAdminLocaleCatalog, 'en')

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
  file: {
    prefix: 'file:./',
    example: 'file:./examples/packages/hot-service/v1',
  },
  workspace: {
    prefix: 'workspace:extensions/',
    example: 'workspace:extensions/my-extension',
  },
  git: {
    prefix: 'git:',
    example: 'git:https://example.com/org/repo.git#<40-character commit hash>',
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
  if (!ref.startsWith(format.prefix))
    return t('source.validation.prefix', { prefix: format.prefix, example: format.example })
  return undefined
}

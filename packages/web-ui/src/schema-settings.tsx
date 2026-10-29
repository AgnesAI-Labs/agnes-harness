import { useEffect, useState } from 'react'
import { appServerErrorMessage } from './app-server-errors.js'
import { SchemaConfigForm } from './config-form.js'
import type { ConfigSchema } from './config-schema.js'
import { CONFIG_FORM_NAMESPACE, configFormCatalog } from './locales/config-form.js'
import type { Translate } from './locales/index.js'
import { SettingsCard, SettingsState } from './settings-layout.js'
import { Button } from './ui/button.js'
import { useUiText } from './ui-locale.js'

export type ConfigDocument = Readonly<{ values: Record<string, unknown>; revision?: number | string }>
export type ConfigSettingsContext = Readonly<{ t: Translate; data?: unknown }>
export type SchemaSettingsDefinition = Readonly<{
  schema: ConfigSchema
  testId: string
  /** Stable, non-secret identity; locale changes must not trigger configuration reads. */
  scope?(context: ConfigSettingsContext): string
  canConfigure(context: ConfigSettingsContext): boolean
  load(context: ConfigSettingsContext, signal: AbortSignal): Promise<ConfigDocument>
  save?(
    document: ConfigDocument,
    context: ConfigSettingsContext,
    signal: AbortSignal,
  ): Promise<ConfigDocument>
  test?(document: ConfigDocument, context: ConfigSettingsContext, signal: AbortSignal): Promise<void>
}>

/** Declare once, then register this component in settingsSections. No new shell or backend grants. */
export function createSchemaSettingsComponent(definition: SchemaSettingsDefinition) {
  return function SchemaSettingsComponent({ context }: { context: ConfigSettingsContext }) {
    const { t, locale } = useUiText(CONFIG_FORM_NAMESPACE, configFormCatalog)
    const scope = definition.scope?.(context) ?? definition.testId
    const [document, setDocument] = useState<ConfigDocument>()
    const [loadedScope, setLoadedScope] = useState<string>()
    const [loading, setLoading] = useState(true)
    const [failed, setFailed] = useState<unknown>(false)
    const [retry, setRetry] = useState(0)
    // biome-ignore lint/correctness/useExhaustiveDependencies: scope is the declaration's explicit resource identity. Locale/context changes retain the current draft.
    useEffect(() => {
      const abort = new AbortController()
      setDocument(undefined)
      setLoadedScope(undefined)
      setLoading(true)
      setFailed(false)
      void Promise.resolve()
        .then(() => definition.load(context, abort.signal))
        .then(
          (value) => {
            if (abort.signal.aborted) return
            if (!validDocument(value)) {
              setFailed(true)
              return
            }
            setDocument(value)
            setLoadedScope(scope)
          },
          (error) => {
            if (!abort.signal.aborted) setFailed(error || true)
          },
        )
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false)
        })
      return () => abort.abort()
    }, [scope, retry])
    return (
      <SettingsCard data-testid={definition.testId} aria-busy={loading}>
        {loading && <SettingsState tone="loading">{t('loading')}</SettingsState>}
        {!!failed && (
          <>
            <SettingsState tone="error">
              {appServerErrorMessage(failed, locale) ?? t('unavailable')}
            </SettingsState>
            <Button onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button>
          </>
        )}
        {document && loadedScope === scope && (
          <SchemaConfigForm
            key={scope}
            schema={definition.schema}
            value={document.values}
            onChange={(values) => setDocument({ ...document, values })}
            t={(key, vars) => {
              const value = context.t(key, vars)
              return value === key ? t(key, vars) : value
            }}
            readOnly={!definition.canConfigure(context) || (!definition.save && !definition.test)}
            testId={`${definition.testId}-form`}
            {...(definition.save
              ? {
                  onSave: async (
                    values: Readonly<Record<string, unknown>>,
                    { signal }: { signal: AbortSignal },
                  ) => {
                    if (!definition.canConfigure(context)) throw new Error('Configuration write unavailable')
                    const result = await definition.save?.(
                      { ...document, values: { ...values } },
                      context,
                      signal,
                    )
                    if (!signal.aborted) {
                      if (!result || !validDocument(result)) throw new Error('Invalid configuration document')
                      setDocument(result)
                    }
                  },
                }
              : {})}
            {...(definition.test
              ? {
                  onTest: async (
                    values: Readonly<Record<string, unknown>>,
                    { signal }: { signal: AbortSignal },
                  ) => {
                    if (!definition.canConfigure(context)) throw new Error('Configuration test unavailable')
                    await definition.test?.({ ...document, values: { ...values } }, context, signal)
                  },
                }
              : {})}
          />
        )}
      </SettingsCard>
    )
  }
}

function validDocument(value: ConfigDocument): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !!value.values &&
    typeof value.values === 'object' &&
    !Array.isArray(value.values) &&
    (value.revision === undefined ||
      typeof value.revision === 'string' ||
      (typeof value.revision === 'number' && Number.isFinite(value.revision)))
  )
}

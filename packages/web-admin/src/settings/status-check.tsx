import {
  Button,
  createDocumentLocaleSource,
  createRegionHost,
  Dialog,
  renderRegion,
  UiLocaleProvider,
  type UiLocaleSource,
  unmountRegion,
  useAdvancedSettings,
  useUiText,
} from '@agnes/web-ui'
import { useCallback } from 'react'
import { type DiagnosticsApi, diagnosticsApi } from './diagnostics-api.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'
import { DoctorPanel } from './doctor.js'

const browserApi = diagnosticsApi()

/**
 * The status check on its own: what a run notice opens. It needs no advanced settings; with them
 * on it also leads to the full diagnostics page.
 */
export function StatusCheckDialog({
  open,
  onClose,
  onDetails,
  api = browserApi,
}: {
  open: boolean
  onClose(): void
  /** Open the full diagnostics page. */
  onDetails(): void
  api?: DiagnosticsApi
}) {
  const { t } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const advanced = useAdvancedSettings()
  const load = useCallback((probe: boolean, signal: AbortSignal) => api.doctor(signal, probe), [api])
  return (
    <Dialog
      open={open}
      destroyOnHidden
      width={520}
      title={t('doctor')}
      data-testid="status-check-dialog"
      onCancel={onClose}
      footer={
        <>
          {advanced && (
            <Button appearance="ghost" data-testid="status-check-details" onClick={onDetails}>
              {t('openDiagnostics')}
            </Button>
          )}
          <Button data-testid="status-check-close" onClick={onClose}>
            {t('close')}
          </Button>
        </>
      }
    >
      <DoctorPanel load={load} />
    </Dialog>
  )
}

/** Mount the dialog on the page; the caller opens it from wherever a problem is reported. */
export function mountStatusCheck(options: {
  details(): void
  locale?: UiLocaleSource
  api?: DiagnosticsApi
}): {
  open(): void
  dispose(): void
} {
  const host = createRegionHost(document.body, 'div')
  const locale = options.locale ?? createDocumentLocaleSource({}).source
  const render = (open: boolean) =>
    renderRegion(
      host,
      <UiLocaleProvider source={locale}>
        <StatusCheckDialog
          open={open}
          {...(options.api ? { api: options.api } : {})}
          onClose={() => render(false)}
          onDetails={() => {
            render(false)
            options.details()
          }}
        />
      </UiLocaleProvider>,
    )
  return {
    open: () => render(true),
    dispose() {
      unmountRegion(host)
      host.remove()
    },
  }
}

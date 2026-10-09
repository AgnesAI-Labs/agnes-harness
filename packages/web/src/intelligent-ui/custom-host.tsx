import { boundedUiJson, validIntelligentSurface } from '@agnes/protocol/intelligent-ui'
import type { ClientModuleRosterRow } from '@agnes/protocol/gen/package-admin'
import type { ThemeService } from '@agnes/web-client'
import {
  CustomUiFallback,
  type CustomUiRenderProps,
  INTELLIGENT_UI_NAMESPACE,
  intelligentUiCatalog,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export interface CustomUiModuleSource {
  list(sessionId: string): Promise<readonly ClientModuleRosterRow[]>
  subscribe(listener: () => void): () => void
  theme: ThemeService
}
export function selectCustomUiModule(
  rows: readonly ClientModuleRosterRow[],
  props: CustomUiRenderProps,
): ClientModuleRosterRow | undefined {
  const matches = rows.filter(
    (row) =>
      row.enabled &&
      row.phase === 'ready' &&
      row.intelligentComponents?.some((item) => item.kind === props.component.kind),
  )
  if (matches.length !== 1) return undefined
  const row = matches[0]!
  // Never substitute a current installation for a historical session's reviewed module.
  if (
    !row.revision ||
    !row.contentDigest ||
    !row.entryUrl ||
    !/^\/plugins\/generations\/[a-f0-9-]{36}\//.test(row.entryUrl)
  )
    return undefined
  const declaration = row.intelligentComponents!.filter((item) => item.kind === props.component.kind)
  return validIntelligentSurface({ ...props.surface, components: [props.component] }, declaration)
    ? row
    : undefined
}

/** The only bridge out of the opaque-origin frame is a declared surface action id. */
export function CustomUiHost(
  props: CustomUiRenderProps & { sessionId: string; source: CustomUiModuleSource },
) {
  const { locale, t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const theme = useSyncExternalStore(props.source.theme.subscribe, props.source.theme.getSnapshot)
  const [epoch, setEpoch] = useState(0)
  const [module, setModule] = useState<ClientModuleRosterRow>()
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(props)
  latest.current = props
  useEffect(
    () =>
      props.source.subscribe(() => {
        setModule(undefined)
        setReady(false)
        setEpoch((value) => value + 1)
      }),
    [props.source],
  )
  useEffect(() => {
    let disposed = false
    setModule(undefined)
    setReady(false)
    setFailed(false)
    props.source
      .list(props.sessionId)
      .then((rows) => {
        if (!disposed) setModule(selectCustomUiModule(rows, props))
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
    }
  }, [props.source, props.sessionId, props.surface, props.component, epoch])
  useEffect(() => {
    if (!module) return
    setReady(false)
    setFailed(false)
    const timer = setTimeout(() => setFailed(true), 15000)
    let stopped = false
    const receive = (event: MessageEvent) => {
      if (stopped || event.source !== frame.current?.contentWindow || !boundedUiJson(event.data, 1024, 4))
        return
      const message = event.data as { type?: unknown; id?: unknown }
      if (message.type === 'agnes-ui-loaded') {
        frame.current?.contentWindow?.postMessage(
          {
            type: 'agnes-ui-init',
            kind: props.component.kind,
            props: structuredClone(props.surface.data[props.component.dataKey]),
            theme,
            locale,
          },
          '*',
        )
      } else if (message.type === 'agnes-ui-ready') {
        clearTimeout(timer)
        setReady(true)
      } else if (message.type === 'agnes-ui-error') {
        stopped = true
        clearTimeout(timer)
        setFailed(true)
      } else if (message.type === 'agnes-ui-action' && typeof message.id === 'string') {
        const current = latest.current
        if (
          !current.disabled &&
          current.component.actionIds.includes(message.id) &&
          current.surface.actions.some((action) => action.id === message.id)
        )
          current.onAction(message.id)
      }
    }
    window.addEventListener('message', receive)
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
    }
  }, [module, theme, locale, props.component, props.surface])
  useEffect(() => {
    frame.current?.toggleAttribute('inert', props.disabled)
  }, [props.disabled, module, ready, theme, locale, epoch])
  const declaration = module?.intelligentComponents?.find((item) => item.kind === props.component.kind)
  return (
    <div data-testid={`ui-custom-host-${props.component.id}`}>
      {(!ready || failed) && <CustomUiFallback component={props.component} />}
      {module?.entryUrl && !failed && (
        <iframe
          key={`${module.entryUrl}:${epoch}:${theme}:${locale}`}
          ref={frame}
          src={`${module.entryUrl}?agnes_ui_frame=1`}
          title={declaration?.accessibility.label ?? props.component.title ?? props.component.id}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          data-testid={`ui-custom-frame-${props.component.id}`}
          aria-label={t('ui.customFrame')}
          style={{ width: '100%', height: 320, border: 0, display: ready ? 'block' : 'none' }}
        />
      )}
    </div>
  )
}

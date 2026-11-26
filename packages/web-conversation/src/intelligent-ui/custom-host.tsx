import { validateAgainst } from '@agnes/protocol'
import { UiComponentDeclaration } from '@agnes/protocol/gen/extension-manifest'
import type { ClientModuleRosterRow } from '@agnes/protocol/gen/package-admin'
import {
  boundedUiJson,
  UI_COMPONENT_FRAME_PATH,
  UI_COMPONENT_MODULE_BYTES,
  validIntelligentSurfaceProjection,
} from '@agnes/protocol/intelligent-ui'
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
  resolveUrl?(url: string): string
  theme: ThemeService
}

async function readModuleSource(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  if (
    !response.ok ||
    !response.body ||
    response.headers.get('content-type')?.split(';')[0] !== 'application/json'
  ) {
    await response.body?.cancel()
    throw new Error('UI component module unavailable')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let source = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 6 * UI_COMPONENT_MODULE_BYTES + 32) throw new Error('UI component response too large')
      source += decoder.decode(value, { stream: true })
    }
    const value: unknown = JSON.parse(source + decoder.decode())
    if (
      typeof value !== 'object' ||
      value === null ||
      !('source' in value) ||
      Object.keys(value).length !== 1 ||
      typeof value.source !== 'string' ||
      new TextEncoder().encode(value.source).byteLength > UI_COMPONENT_MODULE_BYTES
    )
      throw new Error('UI component response invalid')
    return value.source
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function selectCustomUiModule(
  rows: readonly ClientModuleRosterRow[],
  props: Pick<CustomUiRenderProps, 'surface' | 'component'>,
): (ClientModuleRosterRow & { rendererDataUrl: string }) | undefined {
  const matches = rows.filter(
    (row) =>
      row.enabled &&
      row.phase === 'ready' &&
      row.intelligentComponents?.some((item) => item.kind === props.component.kind),
  )
  if (matches.length !== 1) return undefined
  const [row] = matches
  if (!row) return undefined
  // Never substitute a current installation for a historical session's reviewed module.
  if (
    !row.revision ||
    !row.packageId ||
    !row.contentDigest ||
    !/^sha256-[a-f0-9]{64}$/.test(row.contentDigest) ||
    row.entryUrl !== undefined ||
    row.styleUrls !== undefined ||
    row.documentAdmission !== undefined ||
    row.binding?.owner !== row.rowId ||
    row.binding.packageId !== row.packageId ||
    row.binding.integrity !== row.revision ||
    row.binding.lifetime !== 'session' ||
    !row.rendererDataUrl
  )
    return undefined
  const rendererDataUrl = row.rendererDataUrl
  const pinned = /^\/plugins\/generations\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(.*)$/u.exec(
    rendererDataUrl,
  )
  const entry = pinned?.[1]
  if (
    !entry?.startsWith(`${row.packageId}/${encodeURIComponent(row.revision)}/`) ||
    !/^[^?#\\]+\.(?:m?js)\?agnes_ui_source=1$/u.test(entry) ||
    new URL(rendererDataUrl, 'http://localhost').pathname !== rendererDataUrl.split('?')[0]
  )
    return undefined
  const declarations = row.intelligentComponents!.filter((item) => item.kind === props.component.kind)
  if (declarations.length !== 1) return undefined
  const declaration = declarations[0]!
  // Props were validated against the pinned declaration before the backend wrote this surface.
  // Rendering checks the projection and module binding; Ajv's backend schema compiler uses
  // dynamic functions, which the workbench CSP deliberately forbids.
  return validateAgainst(UiComponentDeclaration, declaration).ok &&
    validIntelligentSurfaceProjection({ ...props.surface, components: [props.component] }) &&
    declaration.fallback === props.component.fallback &&
    boundedUiJson(props.surface.data[props.component.dataKey], declaration.maxPropsBytes)
    ? { ...row, rendererDataUrl }
    : undefined
}

/** The only bridge out of the opaque-origin frame is a declared surface action id. */
export function CustomUiHost(
  props: CustomUiRenderProps & { sessionId: string; source: CustomUiModuleSource },
) {
  const { locale, t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const theme = useSyncExternalStore(props.source.theme.subscribe, props.source.theme.getSnapshot)
  const [epoch, setEpoch] = useState(0)
  const [loaded, setLoaded] = useState<{ version: number; label: string }>()
  const [ready, setReady] = useState(false)
  const frame = useRef<{ element: HTMLIFrameElement; version: number }>()
  const version = useRef(0)
  const latest = useRef(props)
  latest.current = props
  useEffect(
    () =>
      props.source.subscribe(() => {
        version.current++
        setEpoch((value) => value + 1)
      }),
    [props.source],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is the subscription version; reload the roster after invalidation.
  useEffect(() => {
    const nextVersion = ++version.current
    const controller = new AbortController()
    setLoaded(undefined)
    setReady(false)
    let source: string | undefined
    let initialized = false
    const fail = () => {
      clearTimeout(timer)
      controller.abort()
      setLoaded(undefined)
      setReady(false)
    }
    const timer = setTimeout(fail, 15000)
    const receive = (event: MessageEvent) => {
      const currentFrame = frame.current
      if (
        controller.signal.aborted ||
        nextVersion !== version.current ||
        currentFrame?.version !== nextVersion ||
        event.origin !== 'null' ||
        event.source !== currentFrame.element.contentWindow ||
        !boundedUiJson(event.data, 1024, 4)
      )
        return
      const message = event.data as { type?: unknown; id?: unknown }
      if (message.type === 'agnes-ui-loaded' && !initialized && source !== undefined) {
        initialized = true
        currentFrame.element.contentWindow?.postMessage(
          {
            type: 'agnes-ui-init',
            source,
            kind: props.component.kind,
            props: structuredClone(props.surface.data[props.component.dataKey]),
            theme,
            locale,
          },
          '*',
        )
        source = undefined
      } else if (message.type === 'agnes-ui-ready' && initialized) {
        clearTimeout(timer)
        setReady(true)
      } else if (message.type === 'agnes-ui-error') {
        fail()
      } else if (message.type === 'agnes-ui-action' && initialized && typeof message.id === 'string') {
        const current = latest.current
        if (
          !current.disabled &&
          current.source === props.source &&
          current.sessionId === props.sessionId &&
          current.surface === props.surface &&
          current.component === props.component &&
          current.component.actionIds.includes(message.id) &&
          current.surface.actions.some((action) => action.id === message.id)
        )
          current.onAction(message.id)
      }
    }
    window.addEventListener('message', receive)
    void (async () => {
      try {
        const rows = await props.source.list(props.sessionId)
        controller.signal.throwIfAborted()
        if (nextVersion !== version.current) return
        const module = selectCustomUiModule(rows, props)
        const declaration = module?.intelligentComponents?.find((item) => item.kind === props.component.kind)
        if (!module || !declaration) {
          clearTimeout(timer)
          return
        }
        const url = props.source.resolveUrl?.(module.rendererDataUrl) ?? module.rendererDataUrl
        source = await readModuleSource(url, controller.signal)
        controller.signal.throwIfAborted()
        if (nextVersion !== version.current) return
        setLoaded({ version: nextVersion, label: declaration.accessibility.label })
      } catch {
        if (!controller.signal.aborted) fail()
      }
    })()
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('message', receive)
    }
  }, [props.source, props.sessionId, props.component, props.surface, epoch, theme, locale])
  return (
    <div data-testid={`ui-custom-host-${props.component.id}`}>
      {!ready && <CustomUiFallback component={props.component} />}
      {loaded && (
        <iframe
          key={loaded.version}
          ref={(element) => {
            frame.current = element ? { element, version: loaded.version } : undefined
            element?.toggleAttribute('inert', props.disabled)
          }}
          src={UI_COMPONENT_FRAME_PATH}
          title={loaded.label}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          data-testid={`ui-custom-frame-${props.component.id}`}
          aria-label={t('ui.customFrame')}
          className="agnes-custom-ui-frame"
          hidden={!ready}
        />
      )}
    </div>
  )
}

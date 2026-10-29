import { getBrowserLog } from '@agnes/web-foundation/browser-log'
import {
  createRegionHost,
  createRegionRenderer,
  type DiagnosticsDialogSnapshot,
  DiagnosticsDialogView,
  type DiagnosticsInclude,
  type DiagnosticsStep,
} from '@agnes/web-ui'
import { diagnosticsLocale, diagnosticsText } from '@agnes/web-units/diagnostics-locale'
import { flushSync } from 'react-dom'
import type { CollectedDiagnostics, CollectInput, collectDiagnostics, RpcCall } from './diagnostics-bundle.js'

declare const __AGNES_WEB_BUNDLE__: boolean
let collector: Promise<typeof import('./diagnostics-bundle.js')> | undefined
let collectAttempt = 0
function loadCollector() {
  collector ??= (
    typeof __AGNES_WEB_BUNDLE__ !== 'undefined' && __AGNES_WEB_BUNDLE__
      ? (import(
          new URL(
            `./vendor/chunk-diagnostics.js${collectAttempt++ ? `?retry=${collectAttempt}` : ''}`,
            import.meta.url,
          ).href
        ) as Promise<typeof import('./diagnostics-bundle.js')>)
      : import('./diagnostics-bundle.js')
  ).catch((error: unknown) => {
    collector = undefined
    throw error
  })
  return collector
}

// lib.dom has no File System Access typings; this is the slice saveZip uses.
type SaveFilePicker = (o: {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}) => Promise<{
  name: string
  createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
}>

export type DiagnosticsDialogDeps = {
  call: RpcCall
  context(): Pick<CollectInput, 'sessionId' | 'sessionTitle' | 'projection' | 'projectionHasEarlier'>
  collect?: typeof collectDiagnostics
  save?: (zip: Uint8Array, fileName: string) => Promise<'saved' | 'canceled'>
}

const TITLE_KEY = {
  menu: 'diagnostics.title.menu',
  share: 'diagnostics.title.share',
  ready: 'diagnostics.title.ready',
  saved: 'diagnostics.title.saved',
} as const
const titleFor = (step: DiagnosticsStep) => diagnosticsText(TITLE_KEY[step])

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Only the origin: the WS credential lives in location.hash, so href/search/hash never leave the page. */
const browserInfo = () => ({
  userAgent: navigator.userAgent,
  language: navigator.language,
  platform: navigator.platform,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
  origin: location.origin,
})

/**
 * Must be called straight from the click handler: the picker call happens before the first await,
 * while the click's user activation is still valid.
 */
export async function saveZip(
  zip: Uint8Array,
  fileName: string,
  win: Window = window,
): Promise<'saved' | 'canceled'> {
  const blob = new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  const picker = (win as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (!picker) {
    const url = URL.createObjectURL(blob)
    const host = createRegionHost(win.document.body, 'span')
    const root = createRegionRenderer(host)
    let link: HTMLAnchorElement | null = null
    // Commit before clicking so older Firefox sees an attached download anchor.
    try {
      flushSync(() =>
        root.render(
          <a
            href={url}
            download={fileName}
            aria-label={fileName}
            hidden
            ref={(node) => {
              link = node
            }}
          >
            {fileName}
          </a>,
        ),
      )
      const anchor = link as HTMLAnchorElement | null
      anchor?.click()
    } finally {
      root.unmount()
      host.remove()
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return 'saved'
  }
  let handle: Awaited<ReturnType<SaveFilePicker>>
  try {
    handle = await picker.call(win, {
      suggestedName: fileName,
      types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
    })
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'canceled'
    throw error
  }
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
  return 'saved'
}

export function createDiagnosticsDialog(deps: DiagnosticsDialogDeps): {
  open(trigger?: HTMLElement): void
  dispose(): void
} {
  const collect: typeof collectDiagnostics =
    deps.collect ??
    (async (...args) => {
      args[2].throwIfAborted()
      const module = await loadCollector()
      args[2].throwIfAborted()
      return module.collectDiagnostics(...args)
    })
  const save = deps.save ?? saveZip
  const host = createRegionHost(document.body, 'div')
  const root = createRegionRenderer(host)
  let dialog: HTMLDialogElement
  let snapshot: DiagnosticsDialogSnapshot = {
    step: 'menu',
    title: titleFor('menu'),
    hasSession: false,
    include: { conversation: false, logs: true, system: true },
    generating: false,
    saving: false,
    summary: '',
    hasWarnings: false,
    savedName: '',
    error: '',
  }
  let controller: AbortController | undefined
  let result: CollectedDiagnostics | undefined
  let trigger: HTMLElement | undefined
  let generation = 0
  let disposed = false

  const render = () => {
    const locale = diagnosticsLocale()
    flushSync(() =>
      root.render(
        // biome-ignore lint/a11y/useKeyWithClickEvents: native dialog cancel supplies Escape dismissal; only its backdrop handles clicks.
        <dialog
          ref={(node) => {
            if (node) dialog = node
          }}
          className="diagnostics-dialog"
          aria-labelledby="diagnostics-heading"
          data-agnes-region="dialog"
          onCancel={(event) => {
            event.preventDefault()
            dismiss()
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) dismiss()
          }}
        >
          <DiagnosticsDialogView
            snapshot={snapshot}
            actions={actions}
            text={(key) => diagnosticsText(key as Parameters<typeof diagnosticsText>[0], undefined, locale)}
          />
        </dialog>,
      ),
    )
  }
  const focusStep = () => {
    dialog
      .querySelector<HTMLElement>(`[data-step="${snapshot.step}"] :is(button, input):not(:disabled)`)
      ?.focus()
  }
  const show = (step: DiagnosticsStep, title = titleFor(step)) => {
    snapshot = { ...snapshot, step, title, error: '' }
    render()
    focusStep()
  }
  // The generation token retires both collection and save continuations across close and reopen.
  const retire = () => {
    generation++
    controller?.abort()
    controller = undefined
    result = undefined
    snapshot = {
      ...snapshot,
      step: 'menu',
      title: titleFor('menu'),
      generating: false,
      saving: false,
      summary: '',
      hasWarnings: false,
      savedName: '',
      error: '',
    }
  }
  const dismiss = () => {
    if (disposed) return
    retire()
    render()
    dialog.close()
    trigger?.focus()
  }
  const actions = {
    close: dismiss,
    share: () => show('share'),
    back: (step: 'menu' | 'share') => show(step),
    setInclude: (name: keyof DiagnosticsInclude, checked: boolean) => {
      snapshot = { ...snapshot, include: { ...snapshot.include, [name]: checked } }
      render()
    },
    generate: () => {
      if (disposed || controller || snapshot.step !== 'share') return
      const mine = new AbortController()
      const currentGeneration = ++generation
      controller = mine
      snapshot = { ...snapshot, generating: true, error: '' }
      render()
      const input = {
        call: deps.call,
        ...deps.context(),
        browserLog: getBrowserLog(),
        browser: browserInfo(),
        now: new Date(),
      }
      void collect(input, snapshot.include, mine.signal).then(
        (value) => {
          if (disposed || generation !== currentGeneration || controller !== mine) return
          controller = undefined
          result = value
          snapshot = {
            ...snapshot,
            generating: false,
            summary: `${value.fileName}（${formatSize(value.zip.byteLength)}）`,
            hasWarnings: value.bundle.warnings.length > 0,
          }
          show('ready')
        },
        (failure: unknown) => {
          if (disposed || generation !== currentGeneration || controller !== mine) return
          controller = undefined
          snapshot = {
            ...snapshot,
            generating: false,
            error: diagnosticsText('diagnostics.error.generate', { detail: message(failure) }),
          }
          render()
        },
      )
    },
    save: () => {
      const current = result
      if (disposed || !current || snapshot.saving || snapshot.step !== 'ready') return
      const currentGeneration = generation
      snapshot = { ...snapshot, saving: true, error: '' }
      // saveZip calls the native picker before its first await, inside this click callback.
      const pending = save(current.zip, current.fileName)
      render()
      void pending
        .then(
          (outcome) => {
            if (disposed || generation !== currentGeneration || result !== current) return
            if (outcome !== 'saved') return
            snapshot = { ...snapshot, savedName: current.fileName }
            show(
              'saved',
              current.bundle.warnings.length
                ? diagnosticsText('diagnostics.savedPartial')
                : titleFor('saved'),
            )
          },
          (failure: unknown) => {
            if (disposed || generation !== currentGeneration || result !== current) return
            snapshot = {
              ...snapshot,
              error: diagnosticsText('diagnostics.error.save', { detail: message(failure) }),
            }
            render()
          },
        )
        .finally(() => {
          if (disposed || generation !== currentGeneration || result !== current) return
          snapshot = { ...snapshot, saving: false }
          render()
        })
    },
  } satisfies import('@agnes/web-ui').DiagnosticsDialogActions

  render()
  const dispose = () => {
    if (disposed) return
    retire()
    disposed = true
    window.removeEventListener('agnes:locale-changed', onLocale)
    window.removeEventListener('pagehide', dispose)
    root.unmount()
    dialog.replaceChildren()
    host.remove()
  }
  const onLocale = () => {
    if (disposed) return
    snapshot = { ...snapshot, title: titleFor(snapshot.step) }
    render()
  }
  window.addEventListener('agnes:locale-changed', onLocale)
  window.addEventListener('pagehide', dispose, { once: true })

  return {
    open(from) {
      if (disposed) return
      trigger = from
      retire()
      const hasSession = deps.context().sessionId !== null
      snapshot = {
        ...snapshot,
        hasSession,
        include: { conversation: hasSession, logs: true, system: true },
      }
      render()
      if (!dialog.open) dialog.showModal()
      focusStep()
    },
    dispose,
  }
}

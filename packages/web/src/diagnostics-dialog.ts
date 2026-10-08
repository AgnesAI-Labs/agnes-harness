import { getBrowserLog } from '@agnes/web-foundation/browser-log'
import {
  createAntdRoot,
  type DiagnosticsDialogSnapshot,
  DiagnosticsDialogView,
  type DiagnosticsInclude,
  type DiagnosticsStep,
} from '@agnes/web-ui'
import { diagnosticsLocale, diagnosticsText } from '@agnes/web-units/diagnostics-locale'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import {
  type CollectedDiagnostics,
  type CollectInput,
  collectDiagnostics,
  type RpcCall,
} from './diagnostics-bundle.js'

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
    const a = win.document.createElement('a')
    a.href = url
    a.download = fileName
    // Attached for the click: older Firefox ignores clicks on detached anchors.
    win.document.body.append(a)
    a.click()
    a.remove()
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
  const collect = deps.collect ?? collectDiagnostics
  const save = deps.save ?? saveZip
  const dialog = document.createElement('dialog')
  dialog.className = 'diagnostics-dialog'
  dialog.setAttribute('aria-labelledby', 'diagnostics-heading')
  dialog.dataset.agnesRegion = 'dialog'
  document.body.append(dialog)
  const root = createAntdRoot(dialog)
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
        createElement(DiagnosticsDialogView, {
          snapshot,
          actions,
          text: (key) => diagnosticsText(key as Parameters<typeof diagnosticsText>[0], undefined, locale),
        }),
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
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    dismiss()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismiss()
  })
  const dispose = () => {
    if (disposed) return
    retire()
    disposed = true
    window.removeEventListener('agnes:locale-changed', onLocale)
    window.removeEventListener('pagehide', dispose)
    root.unmount()
    dialog.remove()
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

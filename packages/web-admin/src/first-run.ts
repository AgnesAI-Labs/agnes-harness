import type { ConfigSnapshot } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import type { Client } from '@agnes/sdk/browser'
import { homeNavigation } from '@agnes/web-client'
import {
  appServerErrorMessage,
  createCatalogTranslator,
  DoctorNotice,
  FirstRunGuide,
  firstRunCatalog,
  renderRegion,
  unmountRegion,
} from '@agnes/web-ui'
import { createElement } from 'react'

/** Legacy configured snapshots without an accounts field remain usable. */
export function needsFirstRun(snapshot: ConfigSnapshot): boolean {
  return snapshot.accounts?.length === 0 || (snapshot.accounts === undefined && !snapshot.configured)
}

export async function loadDoctor(probeAccounts = false, signal?: AbortSignal): Promise<DoctorResult> {
  const response = await fetch('/admin/api/doctor', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ probeAccounts }),
    ...(signal ? { signal } : {}),
  })
  const result: unknown = await response.json()
  if (!response.ok) throw result && typeof result === 'object' && 'error' in result ? result.error : result
  if (!validateMethod('_agnes/v1/doctor.run', 'result', result).ok) throw new Error('invalid doctor result')
  return result as DoctorResult
}

/** Owns only UI drafts. Accounts, model tests and defaults stay on existing configuration RPCs. */
export function createFirstRunController(options: {
  host: HTMLElement
  banner: HTMLElement
  client: Client
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  attachAccount(host: HTMLElement): () => void
  connectAccount(): Promise<boolean>
  selectDemo(): Promise<void>
  chooseWorkspace(path?: string, signal?: AbortSignal): Promise<string | undefined>
  examples(): Promise<void>
  closeSettings(): void
  details(): Promise<void>
  start(): Promise<void>
  saved(snapshot: ConfigSnapshot): Promise<void>
}) {
  let snapshot: ConfigSnapshot | undefined
  let accountReady = false
  let step = 0
  let connecting = false,
    demo = false,
    workspace = ''
  let error: unknown
  let visible = false,
    paused = false,
    busy = false,
    picking: AbortController | undefined,
    disposed = false,
    bannerDismissed = false
  let generation = 0
  let report: DoctorResult | undefined
  const pending = new AbortController()
  const text = () =>
    createCatalogTranslator(firstRunCatalog, document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en')
  const key = () => (report?.homeId ? `agh-first-run:${report.homeId}:${snapshot?.profile}` : undefined)
  const skipped = () => {
    try {
      const scope = key()
      return scope ? options.storage?.getItem(scope) === 'done' : false
    } catch {
      return false
    }
  }
  const remember = () => {
    try {
      const scope = key()
      if (scope) options.storage?.setItem(scope, 'done')
    } catch {
      /* Setup remains skippable when storage is unavailable. */
    }
  }
  // A hidden modal keeps (and freezes) its content, so the borrowed account form is handed back to
  // Settings here when the guide closes; otherwise Settings' own account tiles would open nothing.
  let release: (() => void) | undefined
  const attachAccount = (host: HTMLElement) => {
    release = options.attachAccount(host)
    return () => {
      release?.()
      release = undefined
    }
  }
  /** Dropping the request makes the daemon close the system window; nothing stays pending. */
  const cancelPick = () => {
    const current = picking
    picking = undefined
    current?.abort()
  }
  const render = () => {
    if (disposed) return
    if (!visible) {
      release?.()
      release = undefined
    }
    const t = text()
    renderRegion(
      options.host,
      createElement(FirstRunGuide, {
        open: visible && !paused,
        step,
        connecting,
        accountReady,
        demo,
        workspace,
        attachAccount,
        busy,
        picking: picking !== undefined,
        error:
          error === undefined
            ? ''
            : (appServerErrorMessage(error, document.documentElement.lang) ?? t('firstRun.failed')),
        t,
        onStep(next: number) {
          step = next
          error = undefined
          render()
        },
        onAdd() {
          connecting = true
          demo = false
          error = undefined
          render()
        },
        onDemo() {
          connecting = false
          demo = true
          error = undefined
          render()
        },
        onWorkspace(path?: string) {
          if (busy || (!path && picking)) return
          cancelPick()
          const own = path ? undefined : new AbortController()
          picking = own
          if (!own) busy = true
          error = undefined
          render()
          void options
            .chooseWorkspace(path, own?.signal)
            .then((name) => {
              if (disposed) return
              if (own && picking !== own) return
              if (name) workspace = name
              picking = undefined
              busy = false
              render()
            })
            .catch((value) => {
              if (own?.signal.aborted) return
              if (own && picking === own) picking = undefined
              showError(value)
            })
        },
        onCancelPick() {
          cancelPick()
          render()
        },
        onExamples() {
          paused = true
          render()
          queueMicrotask(() => {
            void options.examples().catch(showError)
          })
        },
        onContinue() {
          void next()
        },
        onSkip() {
          cancelPick()
          generation++
          visible = false
          remember()
          render()
          void options.start().catch(showError)
        },
      }),
    )
    renderRegion(
      options.banner,
      report?.status === 'fail' && !bannerDismissed
        ? createElement(DoctorNotice, {
            t,
            count: report.checks.filter((check) => check.status === 'fail').length,
            onDetails() {
              paused = visible
              render()
              queueMicrotask(() => {
                void options.details().catch(showError)
              })
            },
            onDismiss() {
              bannerDismissed = true
              try {
                if (report?.homeId)
                  options.storage?.setItem(`agh-doctor-dismissed:${report.homeId}`, String(Date.now()))
              } catch {
                /* Storage is optional. */
              }
              render()
            },
          })
        : null,
    )
  }
  const showError = (value: unknown) => {
    if (disposed) return
    busy = false
    paused = false
    error = value
    render()
  }
  const next = async () => {
    if (busy) return
    if (step === 2) {
      visible = false
      remember()
      render()
      await options.start().catch(showError)
      return
    }
    if (step === 1) {
      if (!workspace) return
      step = 2
      render()
      return
    }
    if (accountReady && !connecting) {
      step = 1
      render()
      return
    }
    if (!connecting && !demo) return
    const epoch = ++generation
    busy = true
    error = undefined
    render()
    try {
      let saved = false
      if (demo) await options.selectDemo()
      else saved = await options.connectAccount()
      if (epoch !== generation || disposed) return
      if (saved || demo) {
        accountReady = saved
        step = 1
        connecting = false
      }
      busy = false
      render()
    } catch (value) {
      if (epoch === generation) showError(value)
    }
  }
  const resume = () => {
    if (visible && paused && !homeNavigation.getSnapshot()) {
      paused = false
      render()
    }
  }
  document.getElementById('config')?.addEventListener('close', resume)
  const stopHomeNavigation = homeNavigation.subscribe(resume)
  return {
    async initialize(value: ConfigSnapshot, hasSession: boolean) {
      snapshot = value
      try {
        report = await loadDoctor(false, pending.signal)
      } catch {
        /* Startup is never blocked by diagnostics. */
      }
      if (disposed) return
      try {
        const dismissed = report?.homeId
          ? Number(options.storage?.getItem(`agh-doctor-dismissed:${report.homeId}`))
          : 0
        bannerDismissed = dismissed > 0 && Date.now() - dismissed < 7 * 24 * 60 * 60 * 1000
      } catch {
        /* Diagnostics never block startup. */
      }
      visible = !hasSession && needsFirstRun(value) && !skipped()
      render()
      return visible
    },
    updated(value: ConfigSnapshot) {
      snapshot = value
      render()
    },
    refreshLocale: render,
    get active() {
      return visible
    },
    dispose() {
      disposed = true
      cancelPick()
      generation++
      pending.abort()
      stopHomeNavigation()
      document.getElementById('config')?.removeEventListener('close', resume)
      unmountRegion(options.host)
      unmountRegion(options.banner)
    },
  }
}

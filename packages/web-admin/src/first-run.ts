import type { ConfigSnapshot } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import type { Client } from '@agnes/sdk/browser'
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
  openAccount(): Promise<void>
  examples(): Promise<void>
  closeSettings(): void
  details(): Promise<void>
  start(): Promise<void>
  saved(snapshot: ConfigSnapshot): Promise<void>
}) {
  let snapshot: ConfigSnapshot | undefined
  let step = 0,
    accountId = '',
    model = ''
  let error: unknown
  let visible = false,
    paused = false,
    busy = false,
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
  const render = () => {
    if (disposed) return
    const t = text()
    renderRegion(
      options.host,
      createElement(FirstRunGuide, {
        open: visible && !paused,
        step,
        snapshot,
        accountId,
        model,
        busy,
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
        onAccount(id: string) {
          accountId = id
          model = snapshot?.accounts?.find((a) => a.accountId === id)?.model ?? ''
          render()
        },
        onModel(id: string) {
          model = id
          render()
        },
        onAdd() {
          paused = true
          render()
          void options.openAccount().catch(showError)
        },
        onExamples() {
          paused = true
          render()
          void options.examples().catch(showError)
        },
        onContinue() {
          void next()
        },
        onSkip() {
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
            onDetails() {
              paused = visible
              render()
              void options.details().catch(showError)
            },
            onDismiss() {
              bannerDismissed = true
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
  const select = () => {
    const account =
      snapshot?.accounts?.find((a) => a.accountId === snapshot?.defaultAccountId) ??
      snapshot?.accounts?.find((a) => a.enabled && a.credentialConfigured)
    accountId = account?.accountId ?? ''
    model = account?.model ?? ''
  }
  const next = async () => {
    if (busy) return
    if (step === 4) {
      visible = false
      remember()
      render()
      await options.start().catch(showError)
      return
    }
    if (step !== 2) {
      step++
      render()
      return
    }
    const account = snapshot?.accounts?.find((a) => a.accountId === accountId)
    if (!account || !model || !snapshot) return
    busy = true
    error = undefined
    const epoch = ++generation
    render()
    try {
      let saved =
        account.model === model
          ? snapshot
          : await options.client.config.save({
              providerId: account.providerId,
              accountId: account.accountId,
              model,
              expectedRevision: snapshot.revision,
            })
      if (saved.defaultAccountId !== accountId)
        saved = await options.client.config.account({
          accountId,
          action: 'default',
          expectedRevision: saved.revision,
        })
      await options.saved(saved)
      if (epoch !== generation || disposed) return
      snapshot = saved
      step = 3
      busy = false
      render()
    } catch (value) {
      if (epoch === generation) showError(value)
    }
  }
  const resume = () => {
    if (visible && paused) {
      paused = false
      render()
    }
  }
  document.getElementById('config')?.addEventListener('close', resume)
  return {
    async initialize(value: ConfigSnapshot, hasSession: boolean) {
      snapshot = value
      select()
      try {
        report = await loadDoctor(false, pending.signal)
      } catch {
        /* Startup is never blocked by diagnostics. */
      }
      if (disposed) return
      visible = !hasSession && needsFirstRun(value) && !skipped()
      render()
      return visible
    },
    updated(value: ConfigSnapshot) {
      snapshot = value
      select()
      if (visible && step === 1 && value.accounts?.some((a) => a.enabled && a.credentialConfigured)) {
        step = 2
        paused = false
        options.closeSettings()
      }
      render()
    },
    refreshLocale: render,
    get active() {
      return visible
    },
    dispose() {
      disposed = true
      generation++
      pending.abort()
      document.getElementById('config')?.removeEventListener('close', resume)
      unmountRegion(options.host)
      unmountRegion(options.banner)
    },
  }
}

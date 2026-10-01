import type { ThinkingLevel } from '@agnes/protocol'
import type { LocaleVars } from '@agnes/web-client'

export { shouldShowEmptyState } from './conversation-visibility.js'

/** 渲染时取词：宿主传 `LocaleService#t` 的稳定包装，禁止缓存返回值跨渲染。 */
export type Translate = (key: string, vars?: LocaleVars) => string

export type ComposerPresentation = {
  connected: boolean
  configured: boolean
  hasSession: boolean
  busy: boolean
  stopping: boolean
  loading: boolean
}

export type ComposerActionPresentation = {
  label: string
  mode: 'idle' | 'busy' | 'pending'
  title: string
}

export type KnownSessionModel = { route: string; id: string; thinking?: ThinkingLevel }

type ResizeableComposer = {
  scrollHeight: number
  style: Pick<CSSStyleDeclaration, 'height' | 'overflowY'>
}

export function resizeComposer(composer: ResizeableComposer, maxHeight = 180): void {
  composer.style.height = 'auto'
  const height = Math.min(composer.scrollHeight, maxHeight)
  composer.style.height = `${height}px`
  composer.style.overflowY = composer.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

export function isComposerSubmitShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'keyCode'> &
    Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>>,
): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}

export function setButtonLabel(button: HTMLButtonElement, value: string): void {
  const label = button.querySelector<HTMLElement>('.button-label, span')
  if (label) label.textContent = value
  else button.textContent = value
}

export function composerHint(state: ComposerPresentation, t: Translate): string {
  return composerHintPresentation(state, t).text
}

export function composerHintPresentation(
  state: ComposerPresentation,
  t: Translate,
): {
  kind: 'shortcut' | 'state'
  text: string
} {
  if (!state.connected) return { kind: 'state', text: t('composer.hint.disconnected') }
  if (!state.configured) return { kind: 'state', text: t('composer.hint.unconfigured') }
  if (state.loading) return { kind: 'state', text: t('composer.hint.preparing') }
  if (!state.hasSession) return { kind: 'state', text: t('composer.hint.newTask') }
  if (state.stopping) return { kind: 'state', text: t('composer.hint.stopping') }
  return state.busy
    ? { kind: 'state', text: t('composer.hint.busy') }
    : { kind: 'shortcut', text: t('composer.hint.shortcut') }
}

export function composerActionPresentation(
  state: Pick<ComposerPresentation, 'busy' | 'loading'> & { sending: boolean },
  t: Translate,
): ComposerActionPresentation {
  const mode = state.loading || state.sending ? 'pending' : state.busy ? 'busy' : 'idle'
  const label =
    mode === 'pending'
      ? state.loading
        ? t('composer.action.preparing')
        : t('composer.action.submitting')
      : mode === 'busy'
        ? t('composer.action.append')
        : t('composer.action.send')
  return {
    mode,
    label,
    title: mode === 'pending' ? label : t('composer.action.title', { label }),
  }
}

export function canSubmitComposer(
  state: Pick<ComposerPresentation, 'connected' | 'hasSession' | 'stopping' | 'loading'> & {
    sending: boolean
  },
): boolean {
  return state.connected && state.hasSession && !state.sending && !state.stopping && !state.loading
}

/** 档位在界面上按首字母大写显示，与后台的 `ThinkingLevel` 小写取值区分开。 */
export function thinkingLevelLabel(level: ThinkingLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

export function modelSelectLabel(model: KnownSessionModel | undefined, t: Translate): string {
  if (!model) return t('composer.model.select')
  return model.thinking ? `${model.id} ${thinkingLevelLabel(model.thinking)}` : model.id
}

export function modelSelectAccessibleName(model: KnownSessionModel | undefined, t: Translate): string {
  return model ? t('composer.model.accessible.current', { id: model.id }) : t('composer.model.accessible.fallback')
}

export function launcherCredential(
  hash: string,
  hasNavigationTarget: (id: string) => boolean,
): string | undefined {
  const fragment = hash.slice(1)
  return fragment && !hasNavigationTarget(fragment) ? fragment : undefined
}

export function errorNotice(
  message: string,
  diagnosticId?: unknown,
  diagnosticUnavailable?: unknown,
  turnErrorCode?: unknown,
  reason?: unknown,
  t: Translate = (key) => key,
): string {
  // Not a fault to retry or report: the session was written by an older build and cannot be read.
  if (reason === 'legacy-ledger-format') return t('session.error.legacyLedger')
  if (message === 'INTERNAL_ERROR (-32603)' && turnErrorCode === 'AUTH')
    return t('session.error.authFailed')
  if (message === 'INTERNAL_ERROR (-32603)' && turnErrorCode === 'OUTPUT_LIMIT')
    return t('session.error.outputLimit')
  if (message === 'INTERNAL_ERROR (-32603)' && turnErrorCode === 'RATE_LIMIT')
    return t('session.error.rateLimit')
  if (message !== 'INTERNAL_ERROR (-32603)') return message
  const id =
    typeof diagnosticId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(diagnosticId)
      ? t('session.error.diagnosticId', { id: diagnosticId })
      : ''
  return `${t('session.error.internal')}${diagnosticUnavailable === true ? t('session.error.diagnosticUnavailable') : id}`
}

export function workspaceErrorNotice(error: unknown, t: Translate = (key) => key): string {
  const data =
    typeof error === 'object' && error !== null ? (error as { data?: { reason?: unknown } }).data : undefined
  if (data?.reason === 'not-found') return t('workspace.error.notFound')
  if (data?.reason === 'not-directory') return t('workspace.error.notDirectory')
  if (data?.reason === 'not-accessible') return t('workspace.error.notAccessible')
  if (data?.reason === 'not-absolute') return t('workspace.error.notAbsolute')
  return t('workspace.error.fallback')
}

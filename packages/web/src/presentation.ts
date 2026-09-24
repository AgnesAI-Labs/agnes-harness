export { shouldShowEmptyState } from './conversation-visibility.js'

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

export type KnownSessionModel = { route: string; id: string }

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

export function composerHint(state: ComposerPresentation): string {
  return composerHintPresentation(state).text
}

export function composerHintPresentation(state: ComposerPresentation): {
  kind: 'shortcut' | 'state'
  text: string
} {
  if (!state.connected) return { kind: 'state', text: '连接后台后开始' }
  if (!state.configured) return { kind: 'state', text: '配置模型后开始' }
  if (state.loading) return { kind: 'state', text: '正在准备…' }
  if (!state.hasSession) return { kind: 'state', text: '准备新任务' }
  if (state.stopping) return { kind: 'state', text: '正在请求停止…' }
  return state.busy
    ? { kind: 'state', text: '可补充下一轮' }
    : { kind: 'shortcut', text: 'Enter 发送，Shift+Enter 换行' }
}

export function composerActionPresentation(
  state: Pick<ComposerPresentation, 'busy' | 'loading'> & { sending: boolean },
): ComposerActionPresentation {
  const mode = state.loading || state.sending ? 'pending' : state.busy ? 'busy' : 'idle'
  const label =
    mode === 'pending'
      ? state.loading
        ? '正在准备会话…'
        : '正在提交…'
      : mode === 'busy'
        ? '加入下一轮'
        : '发送'
  return {
    mode,
    label,
    title: mode === 'pending' ? label : `${label}（Enter）`,
  }
}

export function canSubmitComposer(
  state: Pick<ComposerPresentation, 'connected' | 'hasSession' | 'stopping' | 'loading'> & {
    sending: boolean
  },
): boolean {
  return state.connected && state.hasSession && !state.sending && !state.stopping && !state.loading
}

export function modelSelectLabel(model?: KnownSessionModel): string {
  return model?.id ?? '选择模型'
}

export function modelSelectAccessibleName(model?: KnownSessionModel): string {
  return model ? `当前会话模型：${model.id}` : '选择当前会话模型'
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
): string {
  // Not a fault to retry or report: the session was written by an older build and cannot be read.
  if (reason === 'legacy-ledger-format') return '该会话由旧版本创建，当前版本无法打开，请新建会话。'
  if (message === 'INTERNAL_ERROR (-32603)' && turnErrorCode === 'AUTH')
    return '模型凭据已失效或被上游拒绝，请在设置中重新配置或登录该模型账号。'
  if (message !== 'INTERNAL_ERROR (-32603)') return message
  const id =
    typeof diagnosticId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(diagnosticId)
      ? ` 诊断编号：${diagnosticId}`
      : ''
  return `后台未能完成请求，请稍后重试。${diagnosticUnavailable === true ? ' 诊断记录未能保存。' : id}`
}

export function workspaceErrorNotice(error: unknown): string {
  const data =
    typeof error === 'object' && error !== null ? (error as { data?: { reason?: unknown } }).data : undefined
  if (data?.reason === 'not-found') return '工作目录不存在，请检查路径后重试。'
  if (data?.reason === 'not-directory') return '所选路径不是目录，请选择一个文件夹。'
  if (data?.reason === 'not-accessible') return '无法访问此工作目录，请检查权限后重试。'
  if (data?.reason === 'not-absolute') return '请输入工作目录的绝对路径。'
  return '无法使用此工作目录，请检查路径是否存在及访问权限。'
}

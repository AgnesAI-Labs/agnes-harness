import type { UITimeline } from '@agnes/protocol'
import { bindDismissibleDialog } from '@agnes/web-admin-frame'
import { getBrowserLog } from './browser-log.js'
import { type CollectedDiagnostics, collectDiagnostics, type RpcCall } from './diagnostics-bundle.js'

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
  context(): { sessionId: string | null; sessionTitle: string | null; projection: UITimeline | undefined }
  collect?: typeof collectDiagnostics
  save?: (zip: Uint8Array, fileName: string) => Promise<'saved' | 'canceled'>
}

type Step = 'menu' | 'share' | 'ready' | 'saved'
const TITLES: Record<Step, string> = {
  menu: '报告问题',
  share: '选择要包含的内容',
  ready: '诊断包已生成',
  saved: '诊断文件已保存',
}

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
  // Static markup only; every dynamic string below goes through textContent. Everything sits in one
  // padded wrapper so the only click whose target is the <dialog> itself is a backdrop click.
  dialog.innerHTML = `<div class="diagnostics-body"><div class="dialog-heading"><h2 id="diagnostics-heading"></h2></div>
    <section data-step="menu">
      <p class="dialog-intro">创建一个可分享给支持人员的诊断 ZIP 包，包含当前会话的对话与轨迹、日志和系统信息。</p>
      <p class="diagnostics-badge">分享前会先对密钥脱敏。</p>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-action="cancel">取消</button><button class="primary-button" type="button" data-action="share">分享诊断</button></div>
    </section>
    <section data-step="share" hidden>
      <fieldset class="diagnostics-include" aria-labelledby="diagnostics-heading">
        <label><input type="checkbox" name="conversation" /> 对话与轨迹</label>
        <label><input type="checkbox" name="logs" /> 日志</label>
        <label><input type="checkbox" name="system" /> 系统信息</label>
      </fieldset>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-back="menu">返回</button><button class="primary-button" type="button" data-action="generate">生成诊断包</button></div>
    </section>
    <section data-step="ready" hidden>
      <p class="dialog-intro" data-ready-summary></p>
      <p class="dialog-intro" data-ready-warning hidden>部分诊断资料不可用或超出导出上限，详见包内 diagnostic-export-warnings.json。</p>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-back="share">返回</button><button class="primary-button" type="button" data-action="save">保存 ZIP 包</button></div>
    </section>
    <section data-step="saved" hidden>
      <p class="dialog-intro">把这个 ZIP 包分享给支持或研发人员。解压后打开 index.html 查看。</p>
      <p class="diagnostics-file" data-saved-name></p>
      <div class="dialog-actions"><button class="primary-button" type="button" data-action="close">关闭</button></div>
    </section>
    <p class="dialog-error" role="alert"></p></div>`
  document.body.append(dialog)
  const q = <T extends Element>(selector: string) => dialog.querySelector(selector) as T
  const heading = q<HTMLHeadingElement>('h2')
  const error = q<HTMLParagraphElement>('.dialog-error')
  const sections = dialog.querySelectorAll<HTMLElement>('section[data-step]')
  const box = (name: string) => q<HTMLInputElement>(`input[name="${name}"]`)
  const boxes = { conversation: box('conversation'), logs: box('logs'), system: box('system') }
  const generate = q<HTMLButtonElement>('[data-action="generate"]')
  const saveButton = q<HTMLButtonElement>('[data-action="save"]')
  const shareBack = q<HTMLButtonElement>('[data-back="menu"]')
  const summary = q<HTMLElement>('[data-ready-summary]')
  const warningLine = q<HTMLElement>('[data-ready-warning]')
  const savedName = q<HTMLElement>('[data-saved-name]')
  let controller: AbortController | undefined
  let result: CollectedDiagnostics | undefined
  let trigger: HTMLElement | undefined
  let disposed = false

  const show = (step: Step, title = TITLES[step]) => {
    for (const section of sections) section.hidden = section.dataset.step !== step
    heading.textContent = title
    error.textContent = ''
    dialog.querySelector<HTMLElement>(`[data-step="${step}"] :is(button, input):not(:disabled)`)?.focus()
  }
  const idle = () => {
    controller = undefined
    generate.disabled = false
    shareBack.disabled = false
    generate.textContent = '生成诊断包'
  }

  bindDismissibleDialog({
    dialog,
    cancel: q<HTMLButtonElement>('[data-action="cancel"]'),
    additional: dialog.querySelectorAll<HTMLButtonElement>('[data-action="close"]'),
    canClose: () => true,
    // Closing mid-generation aborts the collection; its late result is dropped by the `controller` check.
    // A finished ZIP (up to 64 MiB) is released right away rather than on the next open().
    close: () => {
      controller?.abort()
      idle()
      result = undefined
      summary.textContent = ''
      savedName.textContent = ''
      dialog.close()
    },
    restoreFocus: () => trigger?.focus(),
  })
  q<HTMLButtonElement>('[data-action="share"]').addEventListener('click', () => show('share'))
  for (const back of dialog.querySelectorAll<HTMLButtonElement>('[data-back]'))
    back.addEventListener('click', () => show(back.dataset.back as Step))

  generate.addEventListener('click', () => {
    if (controller) return
    const mine = new AbortController()
    controller = mine
    generate.disabled = true
    shareBack.disabled = true
    generate.textContent = '正在生成…'
    error.textContent = ''
    const include = {
      conversation: boxes.conversation.checked,
      logs: boxes.logs.checked,
      system: boxes.system.checked,
    }
    const input = {
      call: deps.call,
      ...deps.context(),
      browserLog: getBrowserLog(),
      browser: browserInfo(),
      now: new Date(),
    }
    collect(input, include, mine.signal).then(
      (value) => {
        if (controller !== mine) return
        idle()
        result = value
        summary.textContent = `${value.fileName}（${formatSize(value.zip.byteLength)}）`
        warningLine.hidden = value.bundle.warnings.length === 0
        show('ready')
      },
      (failure: unknown) => {
        if (controller !== mine) return
        idle()
        error.textContent = `生成诊断包失败：${message(failure)}`
      },
    )
  })

  saveButton.addEventListener('click', () => {
    const current = result
    if (!current || saveButton.disabled) return
    saveButton.disabled = true
    error.textContent = ''
    // No await before save(): showSaveFilePicker needs this click's user activation.
    void save(current.zip, current.fileName)
      .then(
        (outcome) => {
          if (outcome !== 'saved' || result !== current) return
          savedName.textContent = current.fileName
          show('saved', current.bundle.warnings.length ? '问题包已导出，部分资料不完整' : TITLES.saved)
        },
        (failure: unknown) => {
          if (result === current) error.textContent = `保存诊断分享包失败：${message(failure)}`
        },
      )
      .finally(() => {
        saveButton.disabled = false
      })
  })

  const dispose = () => {
    disposed = true
    controller?.abort()
    window.removeEventListener('pagehide', dispose)
    dialog.remove()
  }
  window.addEventListener('pagehide', dispose, { once: true })

  return {
    open(from) {
      if (disposed) return
      trigger = from
      controller?.abort()
      idle()
      result = undefined
      const hasSession = deps.context().sessionId !== null
      boxes.conversation.disabled = !hasSession
      boxes.conversation.checked = hasSession
      boxes.logs.checked = true
      boxes.system.checked = true
      show('menu')
      if (!dialog.open) dialog.showModal()
    },
    dispose,
  }
}

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAutoDismissDisclosure, bindDismissibleDialog } from '../src/binding.js'

/** The admin panes own pending-state policy; this helper owns only when a modal may be dismissed. */
function setup(canClose: () => boolean = () => true) {
  document.body.innerHTML = [
    '<dialog id="confirm">',
    '  <p id="body-text">需要确认</p>',
    '  <button id="cancel" type="button">取消</button>',
    '  <button id="alternative" class="alt" type="button">放弃修改</button>',
    '</dialog>',
  ].join('')
  const dialog = document.getElementById('confirm') as HTMLDialogElement
  const close = vi.fn()
  const restoreFocus = vi.fn()
  bindDismissibleDialog({
    dialog,
    cancel: document.getElementById('cancel') as HTMLButtonElement,
    additional: dialog.querySelectorAll<HTMLButtonElement>('button.alt'),
    canClose,
    close,
    restoreFocus,
  })
  return { dialog, close, restoreFocus }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('bindDismissibleDialog', () => {
  it('closes and restores focus from the cancel button', () => {
    const { close, restoreFocus } = setup()
    ;(document.getElementById('cancel') as HTMLButtonElement).click()
    expect(close).toHaveBeenCalledTimes(1)
    expect(restoreFocus).toHaveBeenCalledTimes(1)
  })

  it('closes from each additional dismissal control', () => {
    const { close, restoreFocus } = setup()
    ;(document.getElementById('alternative') as HTMLButtonElement).click()
    expect(close).toHaveBeenCalledTimes(1)
    expect(restoreFocus).toHaveBeenCalledTimes(1)
  })

  it('treats Escape as dismissal but keeps the default from leaking', () => {
    const { dialog, close, restoreFocus } = setup()
    const event = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(restoreFocus).toHaveBeenCalledTimes(1)
  })

  it('dismisses on a backdrop click but not on a click inside the dialog', () => {
    const { dialog, close } = setup()
    // A click landing on the dialog element itself is the backdrop.
    dialog.dispatchEvent(new Event('click', { bubbles: false }))
    expect(close).toHaveBeenCalledTimes(1)
    // A click inside the content bubbles up with a different target and must not dismiss.
    ;(document.getElementById('body-text') as HTMLElement).click()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('refuses every dismissal path while the caller is not closable', () => {
    const { dialog, close, restoreFocus } = setup(() => false)
    ;(document.getElementById('cancel') as HTMLButtonElement).click()
    ;(document.getElementById('alternative') as HTMLButtonElement).click()
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    dialog.dispatchEvent(new Event('click', { bubbles: false }))
    expect(close).not.toHaveBeenCalled()
    expect(restoreFocus).not.toHaveBeenCalled()
  })
})

/** 展开体在会话里会被反复创建，且"展开态被移除"不会触发 toggle —— 这两条决定了实现必须是委托。 */
describe('bindAutoDismissDisclosure', () => {
  const disclosure = (id: string, open: boolean): HTMLDetailsElement => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<details id="${id}"${open ? ' open' : ''}><summary>标题</summary><button class="inside" type="button">内层</button></details>`,
    )
    return document.getElementById(id) as HTMLDetailsElement
  }

  it('closes a registered disclosure on an outside click and keeps it open on an inside click', () => {
    const panel = disclosure('panel', true)
    bindAutoDismissDisclosure(panel)

    document.querySelector<HTMLButtonElement>('#panel .inside')?.click()
    expect(panel.open).toBe(true)

    document.body.click()
    expect(panel.open).toBe(false)
  })

  it('never closes a disclosure that was not registered', () => {
    const registered = disclosure('registered', true)
    const other = disclosure('other', true)
    bindAutoDismissDisclosure(registered)

    document.body.click()
    expect(registered.open).toBe(false)
    expect(other.open).toBe(true)
  })

  it('installs at most one document listener no matter how many disclosures register', () => {
    // 回归：按元素挂监听器的旧实现会"每个展开体一条 document 监听器"，且展开态被移除时
    // 永不释放。委托版不论注册多少个，document 上最多只有一条。
    const add = vi.spyOn(document, 'addEventListener')
    for (const id of ['a', 'b', 'c', 'd', 'e']) bindAutoDismissDisclosure(disclosure(id, false))
    const clickListeners = add.mock.calls.filter(([type]) => type === 'click')
    expect(clickListeners.length).toBeLessThanOrEqual(1)
    add.mockRestore()
  })

  it('keeps working for a live disclosure after another one is removed while open', () => {
    const removed = disclosure('removed', true)
    const kept = disclosure('kept', true)
    bindAutoDismissDisclosure(removed)
    bindAutoDismissDisclosure(kept)

    removed.remove()
    document.body.click()
    expect(kept.open).toBe(false)
  })
})

/** Keep modal cancellation keyboard-accessible while its caller owns pending-state policy. */
export function bindDismissibleDialog(options: {
  dialog: HTMLDialogElement
  cancel: HTMLButtonElement
  additional: NodeListOf<HTMLButtonElement>
  canClose(): boolean
  close(): void
  restoreFocus(): void
}): void {
  const dismiss = (): void => {
    if (!options.canClose()) return
    options.close()
    options.restoreFocus()
  }
  options.cancel.addEventListener('click', dismiss)
  for (const control of options.additional) control.addEventListener('click', dismiss)
  options.dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    dismiss()
  })
  // 点遮罩关闭：落在 dialog 自身（而非其内容）的点击即遮罩点击。
  options.dialog.addEventListener('click', (event) => {
    if (event.target === options.dialog) dismiss()
  })
}

/**
 * 展开体的"点外部关闭"。
 *
 * 内联展开体（会话用量、单次调用用量）此前只能靠再次点击标题收起，和弹窗
 * "点外部关闭"的行为不一致。面板自身是 details 的后代，所以路径包含 details 就够。
 *
 * 轮次过程块**不**在此列：运行中它被投影器每帧撑开，点外部收起会在下一帧被撑回
 * （表现为闪烁），且误伤面过宽——Web 端只认 summary 点击切换，不注册此机制
 * （见 packages/web/src/turns.ts）。
 *
 * 实现是**一次性的 document 级委托**，不是按元素挂/卸监听器：展开体在会话里会被反复创建
 * （每个回合两个），而"元素在展开态被移除"（换会话、点新会话、条目被替换）不会触发
 * `toggle` —— 按元素挂的写法会在 document 上永久留下监听器，并把它引用的整棵游离子树钉在
 * 内存里。委托版对"元素已被移除"天然免疫：它不在 `document.querySelectorAll` 的结果里。
 *
 * 注册幂等，调用方不需要（也没有办法）释放。
 */
const autoDismiss = new WeakSet<HTMLDetailsElement>()
let listening = false

export function bindAutoDismissDisclosure(details: HTMLDetailsElement): void {
  autoDismiss.add(details)
  if (listening) return
  listening = true
  document.addEventListener('click', (event) => {
    for (const open of document.querySelectorAll<HTMLDetailsElement>('details[open]')) {
      if (!autoDismiss.has(open)) continue
      if (event.composedPath().includes(open)) continue
      open.open = false
    }
  })
}

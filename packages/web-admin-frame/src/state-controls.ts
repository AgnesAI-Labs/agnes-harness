/**
 * 状态指示灯与 Switch 开关。
 *
 * 插件页与资源页（技能 / MCP）此前各自用一排文字 chip 表达「信任 / 期望 / 实际」，长度不一、
 * 扫读时要逐个读字；列表行里还混着一颗普通按钮来切期望状态。两个表面现在共用同一套原语：
 * 红绿灯给出瞬时判断，Switch 表达「我想要它开着还是关着」。
 */

/** 语义色档。颜色不进 JS，只作为 `data-tone`，由 style.css 里的 token 决定。 */
export type StateTone = 'ok' | 'warn' | 'off' | 'bad' | 'unknown'

export type StateLight = Readonly<{
  /** 这一格看的是什么：信任 / 期望 / 实际。 */
  label: string
  /** 这一格的取值（已翻译成用户可读文案）。 */
  value: string
  tone: StateTone
}>

/**
 * 一颗灯：`data-tone` 决定圆点颜色，完整语义留给 `title` 与无障碍文本。
 * 灯本身是纯装饰，所以圆点 aria-hidden，文字留在 DOM 里供读屏。
 */
export function createStateLights(states: readonly StateLight[]): HTMLElement {
  const group = document.createElement('div')
  group.className = 'state-lights'
  for (const state of states) {
    const light = document.createElement('span')
    light.className = 'state-light'
    light.dataset.tone = state.tone
    light.title = `${state.label}：${state.value}`
    const dot = document.createElement('span')
    dot.className = 'state-light-dot'
    dot.setAttribute('aria-hidden', 'true')
    const copy = document.createElement('span')
    copy.className = 'state-light-copy'
    const name = document.createElement('span')
    name.className = 'state-light-name'
    name.textContent = state.label
    const value = document.createElement('span')
    value.className = 'state-light-value'
    value.textContent = state.value
    copy.append(name, value)
    light.append(dot, copy)
    group.append(light)
  }
  return group
}

export type SwitchOptions = Readonly<{
  /** 无障碍名，例如「启用 GitHub」。 */
  label: string
  checked: boolean
  disabled: boolean
  /** 用户拨动开关时调用。调用方负责确认流程与忙碌态，本函数不改状态。 */
  onToggle(next: boolean): void
}>

/**
 * Switch 开关。用 `role="switch"` 而不是 checkbox：它在列表行里是一个动作，不是一个表单取值。
 * 开关只表达"意图"（期望状态），真实生效结果由本地后台回报，所以调用方必须先确认再提交。
 */
export function createSwitch(options: SwitchOptions): HTMLButtonElement {
  const control = document.createElement('button')
  control.type = 'button'
  control.className = 'switch'
  control.setAttribute('role', 'switch')
  control.setAttribute('aria-checked', String(options.checked))
  control.setAttribute('aria-label', options.label)
  control.title = options.label
  control.disabled = options.disabled
  const track = document.createElement('span')
  track.className = 'switch-track'
  track.setAttribute('aria-hidden', 'true')
  const knob = document.createElement('span')
  knob.className = 'switch-knob'
  track.append(knob)
  control.append(track)
  control.addEventListener('click', (event) => {
    // 行本身也是可点区域（打开详情）；拨开关不该顺带把详情弹出来。
    event.stopPropagation()
    if (control.disabled) return
    options.onToggle(control.getAttribute('aria-checked') !== 'true')
  })
  return control
}

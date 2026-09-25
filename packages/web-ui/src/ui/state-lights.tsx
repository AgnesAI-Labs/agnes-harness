import type { JSX } from 'react'

/**
 * 语义色档。颜色不进 JS，只作为 `data-tone`，由 style.css 里的 token 决定。
 */
export type StateTone = 'ok' | 'warn' | 'off' | 'bad' | 'unknown'

export type StateLight = Readonly<{
  /** 这一格看的是什么：信任 / 期望 / 实际。 */
  label: string
  /** 这一格的取值（已翻译成用户可读文案）。 */
  value: string
  tone: StateTone
}>

/**
 * 状态指示灯行。DOM 契约与 style.css 的 `.state-lights` 样式一一对应：灯本体是纯装饰，
 * 圆点 aria-hidden，完整语义留在 `title` 与可见文字里供读屏。
 */
export function StateLights({ states }: { states: readonly StateLight[] }): JSX.Element {
  return (
    <div className="state-lights">
      {states.map((state) => (
        <span key={state.label} className="state-light" data-tone={state.tone} title={`${state.label}：${state.value}`}>
          <span className="state-light-dot" aria-hidden="true" />
          <span className="state-light-copy">
            <span className="state-light-name">{state.label}</span>
            <span className="state-light-value">{state.value}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

export type StateSwitchProps = Readonly<{
  /** 无障碍名，例如「启用 GitHub」。 */
  label: string
  checked: boolean
  disabled: boolean
  /** 用户拨动开关时调用。调用方负责确认流程与忙碌态，本组件不改状态。 */
  onToggle(next: boolean): void
}>

/**
 * Switch 开关。用 `role="switch"` 而不是 checkbox：它在列表行里是一个动作，不是一个表单取值。
 * 开关只表达「意图」（期望状态），真实生效结果由本地后台回报，所以调用方必须先确认再提交。
 * 不采用 antd Switch：行内动作语义、title、stopPropagation 与 `.switch` 皮肤契约都要保真。
 */
export function StateSwitch({ label, checked, disabled, onToggle }: StateSwitchProps): JSX.Element {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        // 行本身也是可点区域（打开详情）；拨开关不该顺带把详情弹出来。
        event.stopPropagation()
        if (disabled) return
        onToggle(!checked)
      }}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  )
}

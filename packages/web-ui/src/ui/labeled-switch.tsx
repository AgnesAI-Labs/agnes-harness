import { fallbackT } from '../locales/index.js'
import { StateSwitch, type StateSwitchProps } from './state-lights.js'

export type LabeledSwitchProps = StateSwitchProps & {
  /** Visible state words; default to the shared On / Off. */
  onLabel?: string
  offLabel?: string
}

/** A switch that says what state it is in: the knob position is never the only signal. */
export function LabeledSwitch({ onLabel, offLabel, ...props }: LabeledSwitchProps) {
  return (
    <span className="agh-labeled-switch" data-checked={props.checked}>
      <span className="agh-labeled-switch-state" aria-hidden="true">
        {props.checked ? (onLabel ?? fallbackT('ui.on')) : (offLabel ?? fallbackT('ui.off'))}
      </span>
      <StateSwitch {...props} />
    </span>
  )
}

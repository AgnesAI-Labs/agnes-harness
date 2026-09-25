import { useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

export type SettingsSelectOption = { label: string; value: string }
export type SettingsSelectGroup = {
  label: string
  options: readonly SettingsSelectOption[]
}

type SelectContent = {
  options: readonly SettingsSelectOption[]
  groups: readonly SettingsSelectGroup[]
}

const OPTIONS_EVENT = 'agnes:settings-select-options'

function subscribe(select: HTMLSelectElement, update: (content: SelectContent) => void): () => void {
  const onOptions = (event: Event) => {
    const change = event as CustomEvent<SelectContent>
    change.preventDefault()
    flushSync(() => update(change.detail))
  }
  select.addEventListener(OPTIONS_EVENT, onOptions)
  return () => select.removeEventListener(OPTIONS_EVENT, onOptions)
}

function optionNodes(content: SelectContent) {
  return (
    <>
      {content.options.map(({ label, value }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
      {content.groups
        .filter(({ options }) => options.length > 0)
        .map(({ label, options }) => (
          <optgroup key={label} label={label}>
            {options.map(({ label: optionLabel, value }) => (
              <option key={value} value={value}>
                {optionLabel}
              </option>
            ))}
          </optgroup>
        ))}
    </>
  )
}

/** Update React-owned options before the host's native picker synchronously reads the select. */
export function setSettingsSelectOptions(
  select: HTMLSelectElement,
  options: readonly SettingsSelectOption[],
  groups: readonly SettingsSelectGroup[] = [],
): void {
  const EventConstructor = select.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
  const event = new EventConstructor(OPTIONS_EVENT, {
    bubbles: false,
    cancelable: true,
    detail: { options, groups },
  })
  if (select.dispatchEvent(event)) throw new Error(`settings select #${select.id} is not mounted by React`)
}

export function SettingsOptionSelect({ id }: { id: string }) {
  const ref = useRef<HTMLSelectElement>(null)
  const [content, setContent] = useState<SelectContent>({
    options: [],
    groups: [],
  })

  useLayoutEffect(() => {
    const select = ref.current
    if (!select) return
    return subscribe(select, setContent)
  }, [])

  return (
    <select id={id} ref={ref}>
      {optionNodes(content)}
    </select>
  )
}

/** Render options in the static settings fixture used by non-React hosts and controller tests. */
export function mountSettingsSelectOptions(select: HTMLSelectElement): () => void {
  const root = createRoot(select)
  function FixtureOptions() {
    const [content, setContent] = useState<SelectContent>({
      options: [],
      groups: [],
    })
    useLayoutEffect(() => {
      return subscribe(select, setContent)
    }, [])
    return optionNodes(content)
  }
  flushSync(() => root.render(<FixtureOptions />))
  return () => root.unmount()
}

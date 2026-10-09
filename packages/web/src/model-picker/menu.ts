import { tr } from '@agnes/web-foundation/locale-bridge'
import { createElement, type ReactNode } from 'react'
import { sameOption } from './state.js'
import type { ModelPickerOption, ModelPickerState } from './types.js'

export function modelOption(
  option: ModelPickerOption,
  index: number,
  state: ModelPickerState,
  activeIndex: number,
  openedIndex: number | undefined,
  selecting: boolean,
  onSelect: (index: number) => void,
  onHover: (index: number) => void,
): ReactNode {
  return createElement(
    'div',
    {
      id: `model-picker-option-${index}`,
      key: `${option.route}:${option.id}`,
      className: 'model-picker-option',
      role: 'option',
      'aria-selected': sameOption(option, state.selected),
      'aria-disabled': state.pending || selecting,
      // 详情子菜单开着的那一行保持高亮，一眼能看出右边那块是从哪来的。
      'data-active': index === activeIndex,
      'data-open': index === openedIndex,
      onClick: () => onSelect(index),
      // 悬停即展开这一行的会话设置；点选仍然是切换模型。
      onMouseEnter: () => onHover(index),
    },
    createElement('span', { className: 'model-picker-model' }, option.id),
    createElement(
      'span',
      { className: 'model-picker-route' },
      option.label ?? tr('settings.modelPicker.configuredAccount'),
    ),
  )
}

export function modelOptions(
  state: ModelPickerState,
  activeIndex: number,
  openedIndex: number | undefined,
  selecting: boolean,
  onSelect: (index: number) => void,
  onHover: (index: number) => void,
): ReactNode[] {
  return state.options.map((option, index) =>
    modelOption(option, index, state, activeIndex, openedIndex, selecting, onSelect, onHover),
  )
}

/** 详情里的一行：左边名称，右边当前值，可继续展开的行带 ›。 */
export function detailRow(options: {
  id: string
  label: string
  value: string
  active: boolean
  nested: boolean
  onOpen?: () => void
  onHover?: () => void
}): ReactNode {
  const { id, label, value, active, nested, onOpen, onHover } = options
  return createElement(
    'div',
    {
      id,
      key: id,
      className: 'model-picker-detail-row',
      role: nested ? 'button' : undefined,
      tabIndex: nested ? -1 : undefined,
      'aria-haspopup': nested ? 'listbox' : undefined,
      'data-active': active,
      'data-nested': nested,
      onClick: onOpen,
      onMouseEnter: onHover,
    },
    createElement('span', { className: 'model-picker-detail-label' }, label),
    createElement('span', { className: 'model-picker-detail-value' }, value),
    nested
      ? createElement(
          'svg',
          {
            className: 'icon model-picker-chevron',
            'data-agnes-region': 'icon',
            viewBox: '0 0 24 24',
            'aria-hidden': true,
          },
          createElement('path', { d: 'm9 6 6 6-6 6' }),
        )
      : undefined,
  )
}

/** 第三级的候选项：档位与预算预设共用同一行样式。 */
export function levelOption(
  option: { label: string; value: string },
  index: number,
  active: boolean,
  selected: boolean,
  busy: boolean,
  onSelect: () => void,
): ReactNode {
  return createElement(
    'div',
    {
      id: `model-level-option-${index}`,
      key: option.value || 'auto',
      className: 'model-picker-level',
      role: 'option',
      'aria-selected': selected,
      'aria-disabled': busy,
      'data-active': active,
      onClick: onSelect,
    },
    option.label,
  )
}

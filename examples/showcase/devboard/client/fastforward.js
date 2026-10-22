import { Select } from '@agnes/web-ui'
import { guided, h, openWork } from './board.js'

/** [gate, label] in the order the sample project passes them; DONE is ADCP approved. */
export const FAST_FORWARD = [
  ['CDCP', 'CDCP 待批'],
  ['TR1', 'TR1 待批'],
  ['TR3', 'TR3 待批'],
  ['TR5', 'TR5 待批'],
  ['TR3_CHANGE', 'TR3 待批 + 客户变更'],
  ['TR5_DEFECT', 'TR5 待批 + A 类缺陷'],
  ['DONE', '已完成'],
]

/** Choosing a gate opens the coordinator with the "fast-forward" draft; the presenter sends it. */
export function FastForward({ board }) {
  return guided(
    'overview-fastforward',
    h(Select, {
      'aria-label': '快进演示到…',
      placeholder: '快进演示到…',
      title: '选一道评审门：打开研发协调员并预填请求，点发送后新建一个停在该门的现场项目',
      value: null,
      disabled: board.busy,
      onChange: (gate) => openWork(board, 'fast-forward', { type: 'fastforward', id: gate }),
      options: FAST_FORWARD.map(([value, label]) => ({ value, label })),
      style: { minWidth: 230 },
    }),
  )
}

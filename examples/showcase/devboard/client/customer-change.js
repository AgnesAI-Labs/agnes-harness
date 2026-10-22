import { Button } from '@agnes/web-ui'
import { h, openWork } from './board.js'
import { showCustomerChange } from './delivery.js'

/** Opens the coordinator with the "customer-change" draft for this project; the presenter sends it. */
export function CustomerChange({ board, project }) {
  if (!showCustomerChange(project)) return null
  return h(
    'div',
    { className: 'devboard-buttons', 'data-guide': 'projects-customer-change' },
    h(
      Button,
      {
        disabled: board.busy,
        title: '打开研发协调员并预填一条客户变更：登记变更、推算影响、提交 CCB，点发送后在「我的待办」批准',
        onClick: () => openWork(board, 'customer-change', { type: 'project', id: project.id }),
      },
      '客户提出变更',
    ),
  )
}

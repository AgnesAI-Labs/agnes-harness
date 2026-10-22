import { Button, Field } from '@agnes/web-ui'
import React from 'react'
import { h, NoteField, openWork } from './board.js'
import { showCustomerChange } from './delivery.js'
import { workOf } from './entries.js'

/**
 * "Customer asks for a change": the presenter writes the title, the customer's reason and the agreement
 * clause, the board registers that change (SUBMITTED, source CUSTOMER) and only then hands it to the
 * coordinator, which traces the impact and starts the ECR. Nothing is sent without the presenter's click.
 */
export function CustomerChange({ board, project, role }) {
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [clause, setClause] = React.useState('')
  if (!showCustomerChange(project)) return null
  const ready = title.trim() && reason.trim()
  const submit = async () => {
    const out = await board.run(
      'devboard.create',
      {
        kind: 'change',
        by: role,
        projectId: project.id,
        title: title.trim(),
        reason: reason.trim(),
        source: { type: 'CUSTOMER', ...(clause.trim() ? { ref: clause.trim() } : {}) },
      },
      '已登记客户变更，正在打开研发协调员',
    )
    const id = out?.result?.id
    if (!id) return
    setOpen(false)
    setTitle('')
    setReason('')
    setClause('')
    const { action, object } = workOf('customerChange', { id })
    openWork(board, action, object)
  }
  return h(
    'div',
    { className: 'devboard-actions', 'data-guide': 'projects-customer-change' },
    h(
      'div',
      { className: 'devboard-buttons' },
      h(
        Button,
        {
          disabled: board.busy,
          'aria-expanded': open,
          title: '先登记客户的变更，再打开研发协调员：推算影响、提交 CCB，点发送后在「我的待办」批准',
          onClick: () => setOpen(!open),
        },
        '客户提出变更',
      ),
    ),
    open &&
      h(
        'section',
        { 'aria-label': '客户变更', className: 'devboard-form' },
        h(
          Field,
          { label: '变更标题', htmlFor: 'devboard-cc-title' },
          h('input', {
            id: 'devboard-cc-title',
            className: 'devboard-note',
            value: title,
            maxLength: 200,
            placeholder: '例如：预警排行默认条数改为 20',
            onChange: (e) => setTitle(e.target.value),
          }),
        ),
        h(NoteField, {
          id: 'devboard-cc-reason',
          label: '客户的理由（原话）',
          value: reason,
          onChange: setReason,
        }),
        h(
          Field,
          { label: '技术协议条款（可选）', htmlFor: 'devboard-cc-clause' },
          h('input', {
            id: 'devboard-cc-clause',
            className: 'devboard-note',
            value: clause,
            maxLength: 64,
            placeholder: '例如：TA §3.2',
            onChange: (e) => setClause(e.target.value),
          }),
        ),
        h(
          'div',
          { className: 'devboard-buttons' },
          h(
            Button,
            { appearance: 'primary', disabled: board.busy || !ready, onClick: submit },
            '登记并交给研发协调员',
          ),
          h(
            'span',
            { className: 'devboard-muted' },
            '变更会先登记在看板上，研发协调员读取它之后补齐影响分析；草稿由你点发送。',
          ),
        ),
      ),
  )
}

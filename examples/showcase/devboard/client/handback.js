import { Button } from '@agnes/web-ui'
import { h, time } from './board.js'
import { handbackWork } from './entries.js'
import { WorkButton } from './work.js'

/**
 * What people decided that the coordinator has not picked up yet: a decided gate, a finished approval flow
 * or an answered intervention. One click opens the composer with the hand-off attached; sending stays with
 * the person, and the card goes away once the coordinator has written for the same project.
 */
export function HandbackCards({ data, board, role }) {
  const cards = (data.handbacks ?? []).filter((c) => handbackWork(c))
  if (!cards.length) return null
  return h(
    'section',
    {
      className: 'devboard-card devboard-handback',
      'aria-label': '待交回研发协调员',
      'data-guide': 'handback-cards',
    },
    h('h2', null, `待交回研发协调员（${cards.length}）`),
    h(
      'ul',
      { className: 'devboard-todo-list' },
      cards.map((c) => {
        const { action, object, label } = handbackWork(c)
        return h(
          'li',
          { key: c.id, className: 'devboard-todo-item' },
          h('span', null, c.text),
          h('span', { className: 'devboard-muted' }, `${c.projectId ?? '—'} · ${time(c.at)}`),
          h(
            'div',
            { className: 'devboard-buttons' },
            h(WorkButton, { board, action, object, appearance: 'primary' }, label),
            h(
              Button,
              {
                size: 'small',
                disabled: board.busy,
                title: '不交回，把这张卡片收起',
                onClick: () => board.run('devboard.handback', { id: c.id, by: role }, '已收起'),
              },
              '忽略',
            ),
          ),
        )
      }),
    ),
  )
}

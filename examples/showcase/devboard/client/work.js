import { Button } from '@agnes/web-ui'
import React from 'react'
import { h, openDraft, openWork } from './board.js'

/**
 * The hand-off (summary and continue draft) of an object, read from the plugin (devboard.handoff) before anything is sent. The
 * work object the platform carries holds only a type and an id, so the summary is shown here, next to the
 * button, and the coordinator reads the same content itself with devboard_handoff.
 */
export function useHandoff(board, object) {
  const [text, setText] = React.useState({ summary: '', draft: '' })
  const { query } = board
  const revision = board.data?.revision
  // the summary is read again when the object or the board revision changes
  // A different object starts empty instead of showing the previous one's summary until its own arrives.
  React.useEffect(() => setText({ summary: '', draft: '' }), [object.type, object.id])
  React.useEffect(() => {
    let live = true
    Promise.resolve(query('devboard.handoff', { type: object.type, id: object.id }))
      .then(
        (out) =>
          live &&
          setText({
            summary: typeof out?.summary === 'string' ? out.summary : '',
            draft: typeof out?.draft === 'string' ? out.draft : '',
          }),
      )
      .catch(() => live && setText({ summary: '', draft: '' }))
    return () => {
      live = false
    }
  }, [query, object.type, object.id, revision])
  return text
}

/** A button that opens the coordinator with the project's real hand-off as a draft (the action and work object when there is none); it shows what will be handed over. Never sends. */
export function WorkButton({ board, action, object, children, appearance, title, guide }) {
  const { summary, draft } = useHandoff(board, object)
  return h(
    'div',
    { className: 'devboard-buttons', 'data-guide': guide },
    h(
      Button,
      {
        appearance,
        disabled: board.busy,
        title,
        onClick: () => (draft ? openDraft(board, draft) : openWork(board, action, object)),
      },
      children,
    ),
    summary && h('span', { className: 'devboard-muted devboard-handoff' }, `将交给研发协调员：${summary}`),
  )
}

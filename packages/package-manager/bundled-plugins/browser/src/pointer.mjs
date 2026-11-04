import { failure } from './policy.mjs'

export const point = (item, input) => {
  if (
    ![input.x, input.y].every(Number.isFinite) ||
    input.x < 0 ||
    input.y < 0 ||
    input.x > item.viewport.width ||
    input.y > item.viewport.height
  )
    throw failure('INVALID_INPUT', 'Point outside viewport.')
}

export async function pointerInput(item, input) {
  point(item, input)
  if (input.type === 'hover') {
    if (!item.gesture) await item.page.mouse.move(input.x, input.y)
    return
  }
  if (
    !['down', 'move', 'up'].includes(input.phase) ||
    typeof input.gesture !== 'string' ||
    input.gesture.length > 100
  )
    throw failure('INVALID_INPUT', 'Invalid pointer gesture.')
  if (input.phase === 'down') {
    if (item.gesture) throw failure('INVALID_INPUT', 'Finish the current drag first.')
    item.gesture = input.gesture
  } else if (item.gesture !== input.gesture) throw failure('STALE_INPUT', 'The drag is no longer active.')
  try {
    await item.page.mouse.move(input.x, input.y)
    if (input.phase === 'down') await item.page.mouse.down()
    if (input.phase === 'up') {
      // HTML drag-and-drop needs dragover before drop, even for a quick gesture.
      await item.page.mouse.move(input.x, input.y)
      await item.page.mouse.up()
      item.gesture = undefined
    }
  } catch (error) {
    await item.page.mouse.up().catch(() => {})
    item.gesture = undefined
    throw error
  }
}

// Append release after any in-flight mouse.down. It must also precede the next
// controller's actions, including disconnect during a drag or aborted input.
export function releaseInput(item) {
  item.gesture = undefined
  const pending = item.queue
    .catch(() => {})
    .then(async () => {
      const failed = () => {
        if (!item.page.isClosed()) item.uncertain = true
      }
      for (const key of ['Shift', 'Control', 'Alt', 'Meta']) await item.page.keyboard.up(key).catch(failed)
      await item.page.mouse.up().catch(failed)
      item.gesture = undefined
    })
  item.queue = pending
  return pending
}

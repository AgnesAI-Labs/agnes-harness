import { failure } from './policy.mjs'

export async function extraAction(item, input, handle) {
  if (!handle) throw failure('STALE_TARGET', 'Use a current element ref returned by inspect.')
  if (input.action === 'hover') return handle.hover({ timeout: 10_000 })
  if (input.action === 'select') {
    if (
      !Array.isArray(input.values) ||
      !input.values.length ||
      input.values.length > 100 ||
      input.values.some((value) => typeof value !== 'string')
    )
      throw failure('INVALID_INPUT', 'select requires an array of option values.')
    return handle.selectOption(input.values, { timeout: 10_000 })
  }
  const target = item.refs.get(input.targetRef)
  if (!target || (await handle.ownerFrame()) !== (await target.ownerFrame()))
    throw failure('STALE_TARGET', 'Drag requires two current refs in the same frame.')
  await handle.hover({ timeout: 10_000 })
  try {
    await item.page.mouse.down()
    await target.hover({ timeout: 10_000 })
    await target.hover({ timeout: 10_000 })
  } finally {
    await item.page.mouse.up()
  }
}

export function receiveDialog(item, dialog, event) {
  event('dialog', dialog.type() + ': ' + dialog.message())
  const plan = item.dialogPlan
  const matches =
    plan &&
    !plan.used &&
    !plan.signal?.aborted &&
    plan.type === dialog.type() &&
    plan.message === dialog.message()
  if (matches) plan.used = true
  const pending = matches && plan.response === 'accept' ? dialog.accept(plan.text) : dialog.dismiss()
  if (matches) plan.pending = pending
  void pending.catch(() => {})
}

export async function withDialog(item, input, signal, work) {
  if (
    input &&
    (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(input.type) ||
      !['accept', 'dismiss'].includes(input.response) ||
      typeof input.message !== 'string')
  )
    throw failure('INVALID_INPUT', 'A dialog policy requires the exact expected type, message and response.')
  const plan = input ? { ...input, signal, used: false } : undefined
  item.dialogPlan = plan
  try {
    const result = await work()
    await plan?.pending
    return result
  } finally {
    if (item.dialogPlan === plan) item.dialogPlan = undefined
  }
}

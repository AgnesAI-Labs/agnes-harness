import type { Fiber } from './fiber.js'

export type AwaitableFiber = Fiber & PromiseLike<Fiber>

interface MountingControl {
  readonly commits: Array<() => () => void>
  readonly rollbacks: Array<() => void>
  attach(): AwaitableFiber
  announce(): void
  activate(): void
  abort(): Promise<void>
}

const controls = new WeakMap<Fiber, MountingControl>()

export function registerMountingFiber(
  fiber: Fiber,
  control: Omit<MountingControl, 'commits' | 'rollbacks'>,
): void {
  controls.set(fiber, { ...control, commits: [], rollbacks: [] })
}

export function queueMountingCommit(fiber: Fiber, commit: () => () => void): boolean {
  const control = controls.get(fiber)
  if (!control) return false
  control.commits.push(commit)
  return true
}

export function commitMountingFiber(fiber: Fiber): void {
  const control = controls.get(fiber)
  if (!control) throw new Error('fiber is not awaiting publication')
  try {
    for (const commit of control.commits.splice(0)) control.rollbacks.push(commit())
  } catch (error) {
    for (const rollback of control.rollbacks.splice(0).reverse()) rollback()
    throw error
  }
}

export function attachMountingFiber(fiber: Fiber): AwaitableFiber {
  const control = controls.get(fiber)
  if (!control) throw new Error('fiber is not awaiting publication')
  return control.attach()
}

export function announceMountingFiber(fiber: Fiber): void {
  const control = controls.get(fiber)
  if (!control) throw new Error('fiber is not awaiting publication')
  control.announce()
}

export function activateMountingFiber(fiber: Fiber): void {
  const control = controls.get(fiber)
  if (!control) throw new Error('fiber is not awaiting publication')
  control.activate()
  control.rollbacks.length = 0
  controls.delete(fiber)
}

export async function abortMountingFiber(fiber: Fiber): Promise<void> {
  const control = controls.get(fiber)
  if (!control) {
    await fiber.dispose()
    return
  }
  controls.delete(fiber)
  for (const rollback of control.rollbacks.splice(0).reverse()) rollback()
  await control.abort()
}

export function asAwaitableFiber(fiber: Fiber): AwaitableFiber {
  const wrapped = Object.create(fiber) as AwaitableFiber
  // biome-ignore lint/suspicious/noThenProperty: Cordis intentionally exposes awaitable fibers.
  wrapped.then = (onFulfilled, onRejected) => fiber.await().then(onFulfilled, onRejected)
  return wrapped
}

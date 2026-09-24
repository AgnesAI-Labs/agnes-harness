import type { ComputerUseTarget, NormalizedComputerUseArgs } from './backend.js'
import { isInputAction } from './safety.js'

export type SnapshotTokens = ReadonlyMap<number, string>
const PRIVATE_FIELDS = new Set([
  'app',
  'pid',
  'window_id',
  'element_token',
  'from_element_token',
  'to_element_token',
  'target',
])

/** Translate model indices to capabilities from the current snapshot without changing the public schema. */
export function bindStickySnapshot(
  args: Readonly<NormalizedComputerUseArgs>,
  target: ComputerUseTarget | undefined,
  tokens: SnapshotTokens,
): NormalizedComputerUseArgs {
  if (!isInputAction(args.action)) return { ...args }
  const output = Object.fromEntries(
    Object.entries(args).filter(([field]) => !PRIVATE_FIELDS.has(field)),
  ) as unknown as NormalizedComputerUseArgs
  if (target) output.target = target
  const bindings = [
    ['element', 'element_token'],
    ['from_element', 'from_element_token'],
    ['to_element', 'to_element_token'],
  ] as const
  for (const [indexField, tokenField] of bindings) {
    const index = args[indexField]
    const token = index === undefined ? undefined : tokens.get(index)
    if (token !== undefined) output[tokenField] = token
  }
  return output
}

export function targetMatchesApp(target: ComputerUseTarget | undefined, requested: string): boolean {
  const current = target?.app?.trim().toLocaleLowerCase()
  const wanted = requested.trim().toLocaleLowerCase()
  return !current || !wanted || current.includes(wanted) || wanted.includes(current)
}

export function exactCaptureArgs(
  target: ComputerUseTarget | undefined,
  mode: 'som' | 'vision' | 'ax',
): NormalizedComputerUseArgs {
  return {
    action: 'capture',
    mode,
    ...(target?.pid === undefined ? {} : { pid: target.pid }),
    ...(target?.windowId === undefined ? {} : { window_id: target.windowId }),
    ...(target?.pid !== undefined || target?.windowId !== undefined || !target?.app
      ? {}
      : { app: target.app }),
  }
}

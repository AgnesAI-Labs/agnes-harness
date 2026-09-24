import type { ResolvedToolCallPolicy } from '@agnes/extension-api'
import type { NormalizedComputerUseArgs } from './backend.js'
import type { ComputerUseArgs } from './schema.js'

const READ_ACTIONS = new Set(['capture', 'wait', 'list_apps', 'list_windows'])
const FULL_SCREEN_CAPTURE_TARGETS = new Set(['screen', 'desktop'])
const INPUT_ACTIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'set_value',
])
const dispatch = ['action', 'app', 'delivery_mode', 'bring_to_front', 'capture_after']
const point = ['element', 'coordinate']
const modified = ['modifiers']
const fields = (...groups: readonly string[][]): ReadonlySet<string> => new Set(groups.flat())
const ACTION_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  capture: fields(['action', 'mode', 'app', 'pid', 'window_id']),
  click: fields(dispatch, point, modified, ['button']),
  double_click: fields(dispatch, point, modified, ['button']),
  right_click: fields(dispatch, point, modified),
  middle_click: fields(dispatch, point, modified),
  drag: fields(dispatch, modified, [
    'from_element',
    'to_element',
    'from_coordinate',
    'to_coordinate',
    'button',
  ]),
  scroll: fields(dispatch, point, modified, ['direction', 'amount']),
  type: fields(dispatch, point, ['text']),
  key: fields(dispatch, point, ['keys']),
  set_value: fields(dispatch, ['element', 'value']),
  wait: fields(['action', 'seconds']),
  list_apps: fields(['action']),
  list_windows: fields(['action']),
  launch_app: fields(['action', 'app']),
  focus_app: fields(['action', 'app', 'raise_window', 'capture_after']),
}

type Modifier = 'cmd' | 'shift' | 'option' | 'ctrl' | 'fn' | 'win'
const MODIFIER_ALIASES = new Map<string, Modifier>([
  ['cmd', 'cmd'],
  ['command', 'cmd'],
  ['⌘', 'cmd'],
  ['shift', 'shift'],
  ['option', 'option'],
  ['alt', 'option'],
  ['⌥', 'option'],
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['fn', 'fn'],
  ['win', 'win'],
  ['windows', 'win'],
  ['super', 'win'],
  ['meta', 'win'],
])
const BLOCKED_KEY_COMBOS = [
  ['cmd', 'shift', 'backspace'],
  ['cmd', 'option', 'backspace'],
  ['cmd', 'ctrl', 'q'],
  ['cmd', 'shift', 'q'],
  ['cmd', 'option', 'shift', 'q'],
  ['win', 'l'],
  ['ctrl', 'option', 'delete'],
  ['ctrl', 'option', 'del'],
  ['option', 'f4'],
].map((keys) => new Set(keys))
const BLOCKED_TYPE_PATTERNS = [
  /curl\s+[^|]*\|\s*bash/i,
  /curl\s+[^|]*\|\s*sh/i,
  /wget\s+[^|]*\|\s*bash/i,
  /\bsudo\s+rm\s+-[rf]/i,
  /\brm\s+-rf\s+\/\s*$/i,
  /:\s*\(\)\s*\{\s*:\|:\s*&\s*\}/i,
]

export type SafetyRefusal = Readonly<{ code: string; message: string }>

function canonicalKeys(keys: string): Set<string> {
  return new Set(
    keys
      .toLowerCase()
      .split(/\s*[+-]\s*/)
      .filter(Boolean)
      .map((key) => MODIFIER_ALIASES.get(key) ?? key),
  )
}

export function rejectUnsafe(args: Readonly<ComputerUseArgs>): SafetyRefusal | undefined {
  const incompatible = Object.keys(args).find((field) => !ACTION_FIELDS[args.action]?.has(field))
  if (incompatible)
    return {
      code: 'invalid_action_field',
      message: `${incompatible} is not valid for action ${args.action}`,
    }
  const invalidModifier = args.modifiers?.find((modifier) => !MODIFIER_ALIASES.has(modifier))
  if (invalidModifier)
    return {
      code: 'invalid_modifier',
      message: `unsupported modifier: ${invalidModifier}`,
    }
  if (args.action === 'type') {
    const blocked = BLOCKED_TYPE_PATTERNS.find((pattern) => pattern.test(args.text ?? ''))
    if (blocked) return { code: 'blocked_type_pattern', message: `blocked pattern: ${blocked.source}` }
  }
  if (args.action === 'key') {
    const keys = canonicalKeys(args.keys ?? '')
    const blocked = BLOCKED_KEY_COMBOS.find((combo) => [...combo].every((key) => keys.has(key)))
    if (blocked)
      return { code: 'blocked_key_combo', message: `blocked key combo: ${[...blocked].sort().join('+')}` }
  }
  if (args.bring_to_front && args.delivery_mode !== 'foreground')
    return {
      code: 'bring_to_front_requires_foreground',
      message: "bring_to_front requires delivery_mode='foreground'",
    }
  return undefined
}

export function normalizeComputerUseArgs(args: Readonly<ComputerUseArgs>): NormalizedComputerUseArgs {
  const allowed = ACTION_FIELDS[args.action] ?? fields(['action'])
  const output = Object.fromEntries(
    Object.entries(args).filter(([field]) => field !== 'modifiers' && allowed.has(field)),
  ) as unknown as NormalizedComputerUseArgs
  const modifiers = args.modifiers
    ?.map((modifier) => MODIFIER_ALIASES.get(modifier))
    .filter((value): value is Modifier => value !== undefined)
  if (allowed.has('modifiers') && modifiers?.length) output.modifiers = [...new Set(modifiers)]
  if (args.action === 'capture') output.mode ??= 'som'
  if (args.action === 'click' || args.action === 'double_click' || args.action === 'drag')
    output.button ??= 'left'
  if (args.action === 'right_click') output.button = 'right'
  if (args.action === 'middle_click') output.button = 'middle'
  if (args.action === 'scroll') {
    output.amount = Math.max(1, Math.min(50, args.amount ?? 3))
    output.direction ??= 'down'
  }
  if (args.action === 'wait') output.seconds = Math.max(0, Math.min(30, args.seconds ?? 1))
  if (args.action === 'type') output.text ??= ''
  if (args.action === 'key') output.keys ??= ''
  if (args.action === 'focus_app') output.raise_window ??= false
  if (INPUT_ACTIONS.has(args.action)) output.delivery_mode ??= 'background'
  return output
}

export function classifyComputerUse(args: Readonly<ComputerUseArgs>): ResolvedToolCallPolicy {
  if (READ_ACTIONS.has(args.action))
    return {
      isReadOnly: true,
      isDestructive: false,
      replay:
        args.action === 'capture' && FULL_SCREEN_CAPTURE_TARGETS.has(args.app?.trim().toLowerCase() ?? '')
          ? 'idempotent'
          : 'safe',
      requiresApproval: 'never',
      approvalScopes: [],
    }
  const foreground =
    args.action === 'focus_app' && args.raise_window ? 'foreground' : (args.delivery_mode ?? 'background')
  return {
    isReadOnly: false,
    isDestructive: true,
    replay: 'never',
    requiresApproval: 'destructive',
    approvalScopes: [
      `cua:${args.action}:${foreground}`,
      ...(args.bring_to_front || (args.action === 'focus_app' && args.raise_window)
        ? ['cua:bring_to_front']
        : []),
    ],
  }
}

export const isInputAction = (action: string): boolean => INPUT_ACTIONS.has(action)
export const isStateChanging = (action: string): boolean => !READ_ACTIONS.has(action)

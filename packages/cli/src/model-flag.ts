import { SLOT_NAMES } from '@agnes/protocol/command-line'
import { UsageError } from './errors.js'
import type { ModelSel } from './types.js'

export function parseModel(v: string | undefined): ModelSel {
  const m = v === undefined ? null : /^([A-Za-z_]+)=([^/]+)\/(.+)$/.exec(v)
  if (!m) throw new UsageError('--model expects <slot>=<route>/<model>')
  const slot = m[1] as string
  if (!(SLOT_NAMES as readonly string[]).includes(slot))
    throw new UsageError(`--model slot must be one of ${SLOT_NAMES.join(', ')}, got ${slot}`)
  return { slot: slot as ModelSel['slot'], route: m[2] as string, model: m[3] as string }
}

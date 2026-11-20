import { SystemOneAdapter } from '../jev/index.js'
import type { PayloadAdapterOptions } from '../payload-wire-adapter.js'
import { AGNES_AI_BASE_URL } from '../pi/providers/agnes-ai.js'

export const AGNES_SYS1_WIRE_API = 'agnes-sys1'
export const AGNES_SYS1_ADAPTER_VERSION = '1.0.0'
export const AGNES_SYS1_BASE_URL = AGNES_AI_BASE_URL

/** The Agnes gateway implements the System One payload envelope under its own route identity. */
export class AgnesSys1Adapter extends SystemOneAdapter {
  override readonly version = AGNES_SYS1_ADAPTER_VERSION

  constructor(opts: PayloadAdapterOptions) {
    super(AGNES_SYS1_WIRE_API, opts)
  }
}

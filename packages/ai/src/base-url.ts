import type { RouteDecl } from '@agnes/protocol'
import { JEV_WIRE_API } from './adapters/jev/wire.js'
import { OPENAI_AUDIO_WIRE_API } from './adapters/openai-audio/wire.js'
import { checkedPayloadBase } from './adapters/payload-wire.js'
import { requireAbsoluteHttpUrl } from './adapters/pi/index.js'
import { AiSetupError } from './errors.js'

/** Validate with the serving adapter's policy, without opening a transport or echoing input. */
export function validateModelBaseUrl(decl: Pick<RouteDecl, 'api' | 'route' | 'baseUrl'>): void {
  if (decl.api !== JEV_WIRE_API && decl.api !== OPENAI_AUDIO_WIRE_API) {
    requireAbsoluteHttpUrl(decl)
    return
  }
  const result = checkedPayloadBase(decl.baseUrl)
  if (typeof result === 'string')
    throw new AiSetupError('INVALID_BASE_URL', { route: decl.route, reason: result })
}

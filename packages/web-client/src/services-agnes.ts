import { type Context, Service } from '@agnes/cordis'
import type { ClientEffectCaller, ClientServiceCaller, HostAgnesClient } from './service-contracts.js'

export class AgnesClientService extends Service {
  constructor(
    ctx: Context,
    readonly client: HostAgnesClient,
    readonly serviceCaller?: ClientServiceCaller,
    readonly effectCaller?: ClientEffectCaller,
  ) {
    super(ctx, 'agnes')
  }
}

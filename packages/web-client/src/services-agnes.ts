import type { HostAgnesClient, ClientServiceCaller, ClientEffectCaller } from './service-contracts.js'
import { type Context, Service } from '@agnes/cordis'

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

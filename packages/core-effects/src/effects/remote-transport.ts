export type { RemoteTransport } from '@agnes/extension-api'

export class RemoteTransportClosed extends Error {
  override name = 'RemoteTransportClosed'
  constructor() {
    super('the remote transport is closed')
  }
}

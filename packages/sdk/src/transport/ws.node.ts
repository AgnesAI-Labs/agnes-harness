import { MAX_FRAME_BYTES } from '@agnes/protocol'
import WebSocket from 'ws'
import { wsTransport as sharedTransport, type WebSocketLike, type WsOptions } from './ws.js'

export function wsTransport(options: WsOptions) {
  return sharedTransport({
    ...options,
    socketFactory:
      options.socketFactory ??
      ((url, socketOptions) => {
        const { protocols, ...nodeOptions } = socketOptions
        return new WebSocket(url, protocols, {
          ...nodeOptions,
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false,
        }) as unknown as WebSocketLike
      }),
  })
}

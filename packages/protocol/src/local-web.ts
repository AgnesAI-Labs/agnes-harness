/** Same-origin launcher route that hands a signed-in page a single-use WebSocket ticket. */
export const LOCAL_WEB_TICKET_PATH = '/api/ws-ticket'
/** WebSocket subprotocol prefix that carries that ticket to the daemon. */
export const LOCAL_WEB_TICKET_PROTOCOL_PREFIX = 'agnes-ticket.'
/** Launch-URL query parameter that carries the one-time code from the terminal to the browser. */
export const LOCAL_WEB_CODE_PARAM = 'code'

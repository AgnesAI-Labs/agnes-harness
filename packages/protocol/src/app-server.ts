export { ADMIN_METHODS, AppServerError, AppServerErrorCause } from '../gen/ts/app-server.js'

import type { ADMIN_METHODS } from '../gen/ts/app-server.js'
export const APP_SERVER_VERSION = 1
export type AdminMethodName = keyof typeof ADMIN_METHODS

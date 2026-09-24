// The closed set of error codes an extension author can ever see. Anything the host or the
// kernel throws at extension code is an ExtensionError carrying one of these codes, so authors
// branch on `e.code` instead of matching message text.
// Object.freeze, not just `as const`: `as const` only makes the array readonly to the type
// checker, while the runtime array can still be pushed to. A closed set has to stay closed at
// runtime too. Freezing keeps the same readonly-tuple type, so ExtensionErrorCode is unchanged.
export const EXTENSION_ERROR_CODES = Object.freeze([
  'E_SERVICE_DEF',
  'E_PROJECTION_DEF',
  'E_PROJECTION_STATE',
  'E_CAPABILITY_UNDECLARED', // called an API the manifest did not declare (thrown synchronously)
  'E_LEASE_EXPIRED', // the lease expired, ran out of budget, or was revoked
  'E_TOOLDEF_META', // tool def rejected: incomplete meta, bad name grammar, or missing prefix
  'E_REGISTRY_DUPLICATE', // duplicate tool name or duplicate extension id, at startup
  'E_SLOT_PAYLOAD', // slot payload holds a function, fails its schema, or exceeds 64 KB
  'E_EVENT_NAMESPACE', // events.append got an illegal name, or data exceeding 64 KB
  'E_HOOK_RETURN', // a hook returned a value that fails that event's schema
  'E_API_RANGE', // the manifest's apiRange does not admit this API_VERSION
  'E_CEILING_EXCEEDED', // declared capabilities exceed the deployment's ceiling, at load time
] as const)
export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number]

export class ExtensionError extends Error {
  override readonly name = 'ExtensionError'
  readonly code: ExtensionErrorCode
  readonly extId: string | undefined
  readonly detail: Record<string, unknown> | undefined
  // `cause` is handed straight to Error so a wrapper does not have to bury the original
  // exception in `detail`: whoever catches the ExtensionError still has the underlying stack.
  // With no cause given the property is left absent rather than set to undefined.
  constructor(
    code: ExtensionErrorCode,
    message: string,
    opts: { extId?: string; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(`${code}: ${message}`, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.code = code
    this.extId = opts.extId
    this.detail = opts.detail
  }
}

export function isExtensionError(e: unknown): e is ExtensionError {
  return e instanceof ExtensionError
}

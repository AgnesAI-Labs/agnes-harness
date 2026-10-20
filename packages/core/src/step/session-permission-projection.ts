import type { SessionImpl } from './session.js'

/** Wake live projection readers; this row deliberately carries no permission or principal. */
export function invalidatePermissionProjection(session: SessionImpl): void {
  // Never precede the session header or write to a closing session.
  if (!session.state.session || session.closingOrClosed) return
  void session.d.log
    .append([session.ev('x/core/permission-projection-invalidated', {}, { ignorable: true })])
    .catch((error: unknown) => {
      // Authority has already changed synchronously; notification failure cannot undo revocation.
      session.d.logger.warn('permission projection invalidation failed', { message: String(error) })
    })
}

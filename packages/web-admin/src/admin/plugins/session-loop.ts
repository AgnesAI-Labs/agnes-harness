/** Legacy session DTOs omit the binding; never substitute the current default. */
export function sessionLoopSelection(session: unknown): { id: string; version: string } | undefined {
  if (!session || typeof session !== 'object' || !('loop' in session)) return undefined
  const loop = session.loop
  if (
    !loop ||
    typeof loop !== 'object' ||
    !('id' in loop) ||
    !('version' in loop) ||
    typeof loop.id !== 'string' ||
    !loop.id ||
    typeof loop.version !== 'string' ||
    !loop.version
  )
    return undefined
  return { id: loop.id, version: loop.version }
}

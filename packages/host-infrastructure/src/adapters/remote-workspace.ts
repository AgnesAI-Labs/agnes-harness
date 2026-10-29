import type { RemoteTransport } from './remote-transport.js'

/**
 * One session, one remote directory: made on open, removed on close unless the deployment asked to
 * keep it. The session key goes in the name so a directory left behind by a killed process can be
 * recognised later - Stage A only makes orphans identifiable, it does not reap them.
 */
export async function openRemoteWorkspace(
  t: RemoteTransport,
  opts: { sessionKey: string; rootTemplate: string; keepOnClose: boolean; signal?: AbortSignal },
): Promise<{ root: string; close(): Promise<void> }> {
  const safe = opts.sessionKey.replace(/[^A-Za-z0-9_-]/g, '-')
  const root = opts.rootTemplate.replace('{session}', safe)
  const made = await t.exec(['mkdir', '-p', root], {
    cwd: '/',
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (made.code !== 0) throw new Error(`could not create the remote workspace ${root}: ${made.stderr}`)
  return {
    root,
    async close() {
      if (opts.keepOnClose) return
      const gone = await t.exec(['rm', '-rf', root], { cwd: '/' })
      if (gone.code !== 0) throw new Error(`could not remove the remote workspace ${root}: ${gone.stderr}`)
    },
  }
}

import type { HostSession } from '@agnes/host'
import { type FileUploadRequest, rpcError } from '@agnes/protocol'
import { FileUploadStore, UploadError } from './file-upload-store.js'
import { assertWorkspacePublicRoot } from './workspace-files.js'

const stores = new WeakMap<HostSession, FileUploadStore>()
export async function sessionFileUpload(session: HostSession, input: FileUploadRequest) {
  const port = session.d.workspaceInvocation
  if (!port) throw rpcError('CAPABILITY_DENIED', { reason: 'UPLOAD_WORKSPACE_DENIED' })
  let store = stores.get(session)
  if (!store) {
    store = new FileUploadStore(session.key)
    stores.set(session, store)
  }
  const upload = store
  const invoke = async (view: Parameters<Parameters<typeof port.run>[0]>[0]) => {
    try {
      await assertWorkspacePublicRoot(view.root, view.fs())
      await upload.recover(view.root, view.fs())
      return await upload.request(input, view.root, view.fs())
    } catch (error) {
      throw rpcError('SEMANTIC_REJECTED', {
        reason: error instanceof UploadError ? error.code : 'UPLOAD_WORKSPACE_DENIED',
      })
    }
  }
  return session.d.workspacePublication
    ? session.d.workspacePublication.workspace(() => ({ port, handler: invoke }))
    : port.run(invoke)
}
export async function closeSessionFileUploads(session: HostSession): Promise<void> {
  await stores.get(session)?.close()
  stores.delete(session)
}

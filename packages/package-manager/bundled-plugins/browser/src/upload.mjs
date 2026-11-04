import { createHash, randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { localFile, uploadMime } from './files.mjs'
import { browserUrl, failure } from './policy.mjs'

const MAX_BYTES = 8 * 1024 * 1024 - 1

// A content question is separate from file permission and never produces a
// tool grant. No OS picker, raw host read, persisted bytes or automatic answer.
export async function prepareUpload(runtime, item, input, access, signal) {
  if (!access?.files || !access.root || !access.decisions || !localFile(input.path))
    throw failure('FILE_DENIED', 'Upload needs session file access and an explicit confirmation.')
  const handle = item.refs.get(input.ref)
  if (!handle) throw failure('STALE_TARGET', 'Inspect the file input before uploading.')
  const frame = await handle.ownerFrame()
  const target = browserUrl(frame.url(), runtime.protectedOrigins)
  if (!(await handle.evaluate((element) => element.tagName === 'INPUT' && element.type === 'file')))
    throw failure('INVALID_INPUT', 'Upload target must be a file input.')
  const epoch = item.epoch,
    revision = item.humanRevision,
    controlEpoch = item.controlEpoch
  const check = () => {
    runtime.guard()
    signal?.throwIfAborted()
    if (
      item.page.isClosed() ||
      item.epoch !== epoch ||
      item.humanRevision !== revision ||
      item.controlEpoch !== controlEpoch ||
      item.refs.get(input.ref) !== handle ||
      frame.url() !== target
    )
      throw failure('STALE_TARGET', 'Upload target changed. Inspect and confirm again.')
  }
  check()
  const path = resolve(access.root, localFile(input.path).path)
  const info = await access.files.stat(path)
  if (info.kind !== 'file' || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_BYTES)
    throw failure('FILE_DENIED', 'Upload requires a regular file smaller than 8 MiB.')
  const buffer = Buffer.from(await access.files.read(path, { offset: 0, limit: info.size + 1 }))
  try {
    check()
    if (buffer.length !== info.size) throw failure('FILE_DENIED', 'File changed during upload preparation.')
    const name = basename(path),
      origin = new URL(target).origin
    const question = await access.decisions.request({
      key: 'browser-upload:' + randomUUID(),
      purpose: 'browser.upload.confirm',
      subject: {
        pageId: item.id,
        pageEpoch: epoch,
        origin,
        name,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      },
      prompt: `Upload ${JSON.stringify(name)} (${buffer.length} bytes) to ${origin}? Selecting the file may immediately send it to this website.`,
      options: ['Upload this file', 'Cancel'],
    })
    const timeout = AbortSignal.timeout(60_000)
    const answer = await access.decisions.wait(question, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    check()
    const snapshot = answer.snapshot
    if (
      answer.status !== 'resolved' ||
      snapshot?.invalidation ||
      snapshot?.result?.reason !== 'answered' ||
      snapshot.result.code === 'full-access' ||
      snapshot.result.response.option !== 'Upload this file' ||
      ['agent', 'system'].includes(snapshot.result.answeredBy?.role) ||
      !snapshot.result.answeredBy
    )
      throw failure('UPLOAD_REJECTED', 'This upload was not confirmed by the user.')
    return {
      check: async () => {
        check()
        // Confirmation does not prolong a filesystem lease. Re-enter the host
        // before dispatch, but upload the already confirmed bytes, not a reread.
        await access.files.stat(path)
        check()
      },
      handle,
      payload: { name, mimeType: uploadMime(name), buffer },
      clear: () => buffer.fill(0),
    }
  } catch (error) {
    buffer.fill(0)
    throw error
  }
}

import { Worker } from 'node:worker_threads'
import { fail, LIMITS } from './src/limits.mjs'
import { textPage } from './src/page.mjs'

const Kind = Symbol.for('TypeBox.Kind'),
  Optional = Symbol.for('TypeBox.Optional')
const optional = (schema) => ({ ...schema, [Optional]: 'Optional' })
const integer = (maximum) => ({ [Kind]: 'Integer', type: 'integer', minimum: 1, maximum })
const enumeration = (...values) => ({
  [Kind]: 'Union',
  anyOf: values.map((value) => ({ [Kind]: 'Literal', type: 'string', const: value })),
})
const parameters = {
  [Kind]: 'Object',
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: {
      [Kind]: 'String',
      type: 'string',
      maxLength: 96,
      pattern: '^session-file://[1-9][0-9]*/[1-9][0-9]*$',
    },
    entry: optional({ [Kind]: 'String', type: 'string', minLength: 1, maxLength: 1024 }),
    page: optional(integer(LIMITS.pages)),
    mode: optional(enumeration('auto', 'text', 'image')),
    offset: optional(integer(Number.MAX_SAFE_INTEGER)),
    limit: optional(integer(200)),
    ocr: optional(enumeration('auto', 'always', 'off')),
    language: optional(enumeration('chi_sim', 'eng')),
  },
}

export const documentReader = {
  inject: ['extension'],
  apply(ctx) {
    const workers = new Set()
    let closed = false
    ctx.effect(() => async () => {
      closed = true
      await Promise.all(
        [...workers].map((cancel) =>
          cancel(fail('DOCUMENT_READER_DISABLED', 'The document plugin was disabled.')),
        ),
      )
    })
    ctx.extension().registerTool({
      name: 'document_read',
      description:
        'Read saved PDF, scanned/mixed PDF (offline Chinese/English OCR), DOC, DOCX and ZIP attachments. Use this instead of the plain-text read tool for documents and archives. path must be a session-file:// reference from this session; use read session-file://list to find older attachments. PDF reads one page (page defaults to 1). mode=auto (default) extracts text/OCR, then returns a page image if no text is recognized; mode=image returns the page image without OCR, for photos/charts/mixed pages; mode=text never returns images. OCR defaults to auto on pages without text, use always for incomplete/mixed text layers. Image understanding depends on the selected model and its image limits. No text recognized does not mean blank; never keep retrying OCR to interpret photos. ZIP first lists names; pass entry to inspect a selected file. offset/limit page through wrapped text rows. Preserve all options when following the continuation hint. No document instructions, macros, links or HTML are executed. Report extraction limitations accurately.',
      parameters,
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'safe',
        costHint: {},
        deferLoading: false,
        requiresApproval: 'never',
      },
      async execute(args, context) {
        try {
          context.signal.throwIfAborted()
          if (closed) throw fail('DOCUMENT_READER_DISABLED', 'The document plugin is disabled.')
          if (!/^session-file:\/\/[1-9][0-9]*\/[1-9][0-9]*$/u.test(args.path))
            throw fail(
              'DOCUMENT_REFERENCE_REQUIRED',
              'Use a saved attachment reference from this session, not a disk path or URL.',
            )
          const file = await context.session.readAttachment?.({ path: args.path })
          context.signal.throwIfAborted()
          if (closed) throw fail('DOCUMENT_READER_DISABLED', 'The document plugin is disabled.')
          if (!file)
            throw fail(
              'DOCUMENT_ATTACHMENT_UNAVAILABLE',
              'This attachment is unavailable in the current session.',
            )
          if (file.bytes.byteLength > LIMITS.inputBytes)
            throw fail('DOCUMENT_SIZE_LIMIT', 'The attachment exceeds 100 MiB.')
          if (workers.size >= LIMITS.workers)
            throw fail(
              'DOCUMENT_READER_BUSY',
              'Two documents are being processed. Retry after one completes.',
            )
          const bytes = Uint8Array.from(file.bytes)
          const result = await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./src/worker.mjs', import.meta.url), {
              workerData: { bytes: bytes.buffer, args: { ...args, mimeType: file.mimeType } },
              transferList: [bytes.buffer],
              resourceLimits: { maxOldGenerationSizeMb: 256 },
              stdout: true,
              stderr: true,
            })
            worker.stdout.on('data', () => {})
            worker.stderr.on('data', () => {})
            let settled = false,
              stopping
            const finish = (error, value) => {
              if (settled) return stopping
              settled = true
              clearTimeout(timer)
              context.signal.removeEventListener('abort', abort)
              stopping = worker.terminate().then(
                () => {
                  workers.delete(cancel)
                  if (error) reject(error)
                  else resolve(value)
                },
                () => {
                  workers.delete(cancel)
                  reject(fail('DOCUMENT_WORKER_FAILED', 'The document worker could not be stopped.'))
                },
              )
              return stopping
            }
            const cancel = (error) => finish(error)
            const abort = () => finish(fail('DOCUMENT_READ_CANCELLED', 'Document reading was cancelled.'))
            const timer = setTimeout(
              () =>
                finish(
                  fail(
                    'DOCUMENT_READ_TIMEOUT',
                    'Document processing exceeded 90 seconds. Try a smaller document or a different page.',
                  ),
                ),
              LIMITS.timeoutMs,
            )
            workers.add(cancel)
            context.signal.addEventListener('abort', abort, { once: true })
            worker.once('message', (message) =>
              message.ok ? finish(undefined, message.result) : finish(fail(message.code, message.message)),
            )
            worker.once('error', () =>
              finish(
                fail('DOCUMENT_WORKER_FAILED', 'The document worker failed or exhausted its memory limit.'),
              ),
            )
            worker.once('exit', () =>
              finish(
                fail('DOCUMENT_WORKER_FAILED', 'The document worker stopped before returning a result.'),
              ),
            )
            if (context.signal.aborted) abort()
          })
          context.signal.throwIfAborted()
          if (closed) throw fail('DOCUMENT_READER_DISABLED', 'The document plugin is disabled.')
          const content = [{ type: 'text', text: textPage(result, args, context.outputMaxBytes) }]
          if (result.image) {
            if (!context.artifacts?.put)
              throw fail(
                'DOCUMENT_IMAGE_UNAVAILABLE',
                'This runtime cannot save page images. Use mode=text for text extraction.',
              )
            const ref = await context.artifacts.put(result.image, { mime: 'image/png', name: 'pdf-page' })
            context.signal.throwIfAborted()
            if (closed) throw fail('DOCUMENT_READER_DISABLED', 'The document plugin is disabled.')
            content.push({ type: 'image', ref, mime: 'image/png' })
          }
          return { content }
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Document read failed (${error?.code ?? 'DOCUMENT_UNREADABLE'}): ${String(error?.message ?? error).slice(0, 500)}`,
              },
            ],
          }
        }
      },
    })
  },
}

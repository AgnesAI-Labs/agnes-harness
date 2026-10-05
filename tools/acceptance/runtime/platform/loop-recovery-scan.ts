import type {
  BoundService,
  CallContext,
  Outcome,
} from '../../../../packages/extension-api/src/runtime/index.js'
import type * as W from '../../../../packages/protocol/src/runtime/index.js'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '../../../../packages/protocol/src/runtime/index.js'

const schemas = RuntimeMethodSchemaRefs['agh.state'].scan
const limits = { maxBytes: 262_144, maxDepth: 64, maxMembers: 16384 }
class ReadFault extends Error {
  readonly error: W.RuntimeError
  constructor(detailCode: string, code: W.RuntimeError['code'] = 'invalid_input') {
    super(detailCode)
    this.error = {
      code,
      detailCode,
      message: 'Loop recovery scan refused',
      diagnosticId: 'loop-recovery-scan',
      retryAdvice: { kind: 'never' },
    }
  }
}
function require(value: unknown, code: string): asserts value {
  if (!value) throw new ReadFault(code)
}
function json(value: unknown) {
  const result = boundedCanonicalJson(value, limits)
  require(result.ok, 'loop_recovery_scan_payload_limit')
  return result.value
}
function inline(value: W.StateScanRequest): W.DataRef {
  const body = json(value)
  return {
    kind: 'inline',
    schema: schemas.input,
    value: body.json,
    bytes: body.bytes,
    digest: canonicalJsonDigest(body.json),
  }
}

/** Read preparation only. These references are not a RunFrame or proof of durable Loop recovery.
 * The installed State query and data resolver must enforce current authorization; this consumer
 * neither opens a local StateStoreControl nor fabricates a caller context or record projection.
 */
export async function scanLoopRecoveryRecords(
  state: BoundService,
  input: W.StateScanRequest,
  context: CallContext,
  resolve: (ref: W.DataRef, context: CallContext) => Promise<Outcome<W.JsonValue>>,
): Promise<Outcome<readonly { reference: W.DataRef; value: W.JsonValue }[]>> {
  const { signal, ...wire } = context
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    require(validateRuntime('CallContextWire', wire).ok, 'loop_recovery_scan_context')
    const request = structuredClone(input),
      captured = structuredClone(wire),
      call = { ...captured, signal },
      binding = structuredClone(state.binding)
    require(validateRuntime('StateScanRequest', request).ok &&
      validateRuntime('BindingRef', binding).ok, 'loop_recovery_scan_request')
    require(binding.contract === 'agh.state' &&
      call.bindingId === binding.bindingId &&
      'runId' in call.scope &&
      request.snapshot.sessionId === call.scope.sessionId, 'loop_recovery_scan_scope')
    require(request.collection === 'records' &&
      Object.keys(request.filter).every((key) => key === 'typeIds') &&
      request.cursor === null &&
      request.limit > 0 &&
      request.limit <= 500, 'loop_recovery_scan_request')
    const deadline = Math.min(Date.parse(call.deadline), Date.parse(request.snapshot.expiresAt))
    const check = () => {
      if (signal.aborted) throw new ReadFault('loop_recovery_scan_cancelled', 'cancelled')
      if (Date.now() >= deadline) throw new ReadFault('loop_recovery_scan_expired', 'timeout')
    }
    check()
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new ReadFault('loop_recovery_scan_cancelled', 'cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => reject(new ReadFault('loop_recovery_scan_expired', 'timeout')),
        Math.min(2_147_483_647, Math.max(0, deadline - Date.now())),
      )
    })
    // A rejection between reads must still have a handler.
    void stopped.catch(() => {})
    async function read<T>(operation: () => Promise<Outcome<T>>): Promise<T> {
      check()
      const result = await Promise.race([operation(), stopped])
      check()
      if (!result.ok) {
        const error = new ReadFault(result.error.detailCode, result.error.code)
        Object.assign(error.error, structuredClone(result.error))
        throw error
      }
      return result.value
    }
    async function data(ref: W.DataRef) {
      const body = json(
        await read(() => resolve(structuredClone(ref), { ...structuredClone(captured), signal })),
      )
      const identity = ref.kind === 'inline' ? ref : ref.blob
      require(body.bytes === identity.bytes &&
        canonicalJsonDigest(body.json) === identity.digest, 'loop_recovery_scan_integrity')
      return body
    }
    const seen = new Set<string>(),
      records = new Set<string>()
    const result: { reference: W.DataRef; value: W.JsonValue }[] = []
    let bytes = 0
    for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
      const reply = structuredClone(
        await read(() =>
          state.query(
            {
              target: structuredClone(binding),
              method: 'scan',
              snapshot: request.snapshot.snapshotId,
              input: inline(request),
            },
            { ...structuredClone(captured), signal },
          ),
        ),
      )
      require(reply.kind === 'value' &&
        reply.snapshot === request.snapshot.snapshotId, 'loop_recovery_scan_snapshot')
      require(validateRuntime('DataRef', reply.output).ok &&
        canonicalJsonDigest(reply.output.schema) ===
          canonicalJsonDigest(schemas.output), 'loop_recovery_scan_schema')
      const decoded = validateRuntime('StateScanResult', (await data(reply.output)).json)
      require(decoded.ok, 'loop_recovery_scan_page')
      const page = decoded.value
      require(page.snapshot === request.snapshot.snapshotId &&
        page.items.length <= request.limit, 'loop_recovery_scan_snapshot')
      require(page.complete
        ? page.nextCursor === null
        : page.nextCursor !== null && !seen.has(page.nextCursor), 'loop_recovery_scan_cursor')
      for (const ref of page.items) {
        const key = canonicalJsonDigest(ref)
        require(!records.has(key), 'loop_recovery_scan_duplicate')
        records.add(key)
        const body = await data(ref)
        bytes += body.bytes
        require(result.length < 4096 && bytes <= 4_194_304, 'loop_recovery_scan_limit')
        result.push({ reference: structuredClone(ref), value: body.json })
      }
      if (page.complete) {
        check()
        return { ok: true, value: result }
      }
      const cursor = page.nextCursor
      require(cursor !== null, 'loop_recovery_scan_cursor')
      seen.add(cursor)
      request.cursor = cursor
    }
    throw new ReadFault('loop_recovery_scan_page_limit', 'quota')
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ReadFault
          ? error.error
          : new ReadFault('loop_recovery_scan_unavailable', 'internal').error,
    }
  } finally {
    signal.removeEventListener('abort', abort)
    clearTimeout(timer)
  }
}

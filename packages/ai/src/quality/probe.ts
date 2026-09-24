import { inspectJsonData, type ProbeReport, validateAgainst } from '@agnes/protocol'
import { ProbeReport as ReportSchema } from '@agnes/protocol/gen/model'
import type { WireAdapter } from '../adapter.js'

/** A bounded adapter invocation; missing or invalid evidence is never a successful probe. */
export async function probeAdapter(
  adapter: WireAdapter,
  route: string,
  opts: { signal: AbortSignal; timeoutMs?: number },
): Promise<ProbeReport> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new RangeError('invalid probe timeout')
  const failed = (detail: string): ProbeReport => ({
    route,
    ok: false,
    latencyMs: 0,
    checks: [{ name: 'probe', ok: false, detail }],
  })
  if (opts.signal.aborted) return failed('probe aborted')
  if (!adapter.probe) return failed('adapter does not implement probe')
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const onParentAbort = () => ac.abort()
  let onAbort: () => void = () => {}
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('interrupted'))
      ac.signal.addEventListener('abort', onAbort, { once: true })
    })
    opts.signal.addEventListener('abort', onParentAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, timeoutMs)
    const raw = await Promise.race([
      Promise.resolve().then(() => {
        ac.signal.throwIfAborted()
        return adapter.probe?.(route, ac.signal)
      }),
      interrupted,
    ])
    ac.signal.throwIfAborted()
    const inspected = inspectJsonData(raw)
    if (!inspected.ok || !validateAgainst(ReportSchema, inspected.value).ok)
      return failed('adapter returned an invalid probe report')
    const report = inspected.value as ProbeReport
    if (
      report.route !== route ||
      report.checks.length === 0 ||
      (report.ok && report.checks.some((check) => !check.ok))
    )
      return failed('adapter returned inconsistent probe evidence')
    return report
  } catch {
    return failed(timedOut ? 'probe deadline exceeded' : ac.signal.aborted ? 'probe aborted' : 'probe failed')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    opts.signal.removeEventListener('abort', onParentAbort)
    ac.signal.removeEventListener('abort', onAbort)
    ac.abort()
  }
}

import type { CodeRuntime } from '@agnes/extension-api'
import { inspectJsonData } from '@agnes/protocol'

export type DoctorCheck = { id: string; status: 'ok' | 'warn' | 'fail'; detail: string }
export type DoctorSection = { name: 'code-runtime'; status: 'ok' | 'warn' | 'fail'; checks: DoctorCheck[] }
const report = (checks: DoctorCheck[]): DoctorSection => ({
  name: 'code-runtime',
  status: checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok',
  checks,
})
const fail = (detail: string): DoctorCheck => ({ id: 'probe', status: 'fail', detail })

async function probeRuntime(rt: CodeRuntime): Promise<DoctorCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => rt.probe()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), 5000)
      }),
    ])
    const inspected = inspectJsonData(raw, 8192)
    if (
      !inspected.ok ||
      !inspected.value ||
      typeof inspected.value !== 'object' ||
      Array.isArray(inspected.value)
    )
      return fail('runtime probe returned an invalid report')
    const p = inspected.value
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048
    if (p.ok === true && text(p.version) && Object.keys(p).every((k) => k === 'ok' || k === 'version'))
      return { id: 'probe', status: 'ok', detail: `runtime probe ready, version ${p.version}` }
    if (
      p.ok === false &&
      text(p.reason) &&
      (p.installHint === undefined || text(p.installHint)) &&
      Object.keys(p).every((k) => ['ok', 'reason', 'installHint'].includes(k))
    )
      return fail(`${p.reason}${p.installHint ? ` - ${p.installHint}` : ''}`)
    return fail('runtime probe returned an invalid report')
  } catch {
    return fail('runtime probe failed or exceeded the 5000ms deadline')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Read-only diagnostics. Method availability is not execution, isolation or recovery evidence. */
export async function runtimeDoctor(rt: CodeRuntime | undefined): Promise<DoctorSection> {
  if (!rt)
    return report([
      { id: 'installed', status: 'fail', detail: 'no code runtime is installed for this profile' },
    ])
  const checks: DoctorCheck[] = [{ id: 'installed', status: 'ok', detail: 'runtime backend present' }]
  checks.push(await probeRuntime(rt))
  try {
    const { language, state, isolation } = rt
    const valid =
      ['python', 'typescript'].includes(language) &&
      ['persistent', 'stateless'].includes(state) &&
      ['process', 'worker-thread', 'container'].includes(isolation)
    checks.push({
      id: 'descriptors',
      status: valid ? 'ok' : 'fail',
      detail: valid
        ? `${language} / ${state} / ${isolation} (declared descriptors; isolation is not verified)`
        : 'runtime descriptors are invalid',
    })
    if (state === 'persistent') {
      const present = [rt.snapshot, rt.restore, rt.listNames].every((method) => typeof method === 'function')
      checks.push({
        id: 'persistence',
        status: present ? 'ok' : 'warn',
        detail: present
          ? 'snapshot, restore and listNames interfaces available; recovery is not verified'
          : 'persistent runtime is missing snapshot, restore or listNames',
      })
    } else if (state === 'stateless')
      checks.push({ id: 'persistence', status: 'ok', detail: 'runtime declares stateless execution' })
  } catch {
    checks.push({ id: 'descriptors', status: 'fail', detail: 'runtime descriptors could not be read' })
  }
  return report(checks)
}

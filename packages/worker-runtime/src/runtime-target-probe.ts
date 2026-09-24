import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { decodeCanonicalRuntimeTargetBytes, type RuntimeTarget } from '@agnes/plugin-runtime/host'

const PROBE_KEY = /^@probe:(sha256-[0-9a-f]{64})$/
const MAX_CANONICAL_TARGET_BYTES = 12 * 1024 * 1024

function probeError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/** Validate the isolated probe environment and the exact canonical target file it names. */
export async function runRuntimeTargetProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RuntimeTarget> {
  if (env.AGNES_WORKER_KIND !== 'probe') {
    throw probeError('E_RUNTIME_PROBE_ENV', 'AGNES_WORKER_KIND must be probe')
  }
  const keyMatch = PROBE_KEY.exec(env.AGNES_WORKER_KEY ?? '')
  if (!keyMatch?.[1]) throw probeError('E_RUNTIME_PROBE_ENV', 'invalid probe worker key')
  const file = env.AGNES_RUNTIME_TARGET_FILE
  if (!file) throw probeError('E_RUNTIME_PROBE_ENV', 'AGNES_RUNTIME_TARGET_FILE is required')

  const metadata = await lstat(file)
  if (!metadata.isFile()) throw probeError('E_RUNTIME_PROBE_FILE', 'target must be a regular file')
  if (metadata.size <= 0 || metadata.size > MAX_CANONICAL_TARGET_BYTES) {
    throw probeError('E_RUNTIME_PROBE_FILE', 'target file size is outside the accepted range')
  }
  const bytes = await readFile(file)
  const digest = `sha256-${createHash('sha256').update(bytes).digest('hex')}`
  if (digest !== keyMatch[1]) {
    throw probeError('E_RUNTIME_PROBE_DIGEST', 'probe key does not match target bytes')
  }
  return decodeCanonicalRuntimeTargetBytes(bytes)
}

/** Executable entry: successful validation exits naturally without opening any business runtime. */
export async function runRuntimeTargetProbeExecutable(): Promise<void> {
  await runRuntimeTargetProbe(process.env)
}

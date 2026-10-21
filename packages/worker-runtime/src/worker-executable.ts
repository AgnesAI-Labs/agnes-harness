import { createReadStream } from 'node:fs'
import { agnesHome } from '@agnes/host'
import { runWorker, type WorkerHostDeps } from './main.js'
import { workerByteAdmission } from './package-byte-admission.js'
import { connectSupervisor } from './supervisor-connection.js'

/** Start the worker wire loop with executable-owned package composition. */
export async function runWorkerExecutable(deps: WorkerHostDeps = {}): Promise<void> {
  const env = { ...process.env }
  const gateFd = Number(process.env.AGNES_GATE_FD ?? 3)
  const gate = Number.isInteger(gateFd) && gateFd >= 0 ? createReadStream('', { fd: gateFd }) : null
  const bytes = await workerByteAdmission(env, agnesHome(env))
  const start = () =>
    runWorker(
      env,
      {
        connect: (path) => connectSupervisor(path, env),
        gate,
        ...(bytes ? { byteVerification: bytes.owner } : {}),
      },
      deps,
    )
  if (!bytes) return start()
  try {
    return await bytes.owner.run(() => bytes.owner.boot(bytes.admission, start))
  } catch (error) {
    await bytes.owner.close()
    throw error
  }
}

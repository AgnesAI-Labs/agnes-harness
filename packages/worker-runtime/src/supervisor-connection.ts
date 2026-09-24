import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { connectWindowsPipe } from '@agnes/system-node/windows-pipe'

/** The spawning supervisor supplies identity; no worker token is written before verification. */
export async function connectSupervisor(path: string, env: NodeJS.ProcessEnv): Promise<Duplex> {
  if (path.startsWith('\\\\.\\pipe\\')) {
    const pidText = env.AGNES_SUPERVISOR_PID ?? ''
    const processStartId = env.AGNES_SUPERVISOR_START_ID ?? ''
    const pid = Number(pidText)
    if (
      !/^[1-9]\d{0,9}$/.test(pidText) ||
      !Number.isSafeInteger(pid) ||
      pid > 0xffffffff ||
      !/^[1-9]\d{0,19}$/.test(processStartId)
    )
      throw new Error('Windows supervisor identity is missing or invalid')
    return connectWindowsPipe({ path, pid, processStartId })
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

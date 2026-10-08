import type { ComputerUseDriverLock } from './driver-lock.js'
import {
  type ComputerUseDownloadTransport,
  downloadLockedComputerUseDriver,
} from './windows-driver-download.js'

export function downloadLockedMacOSComputerUseDriver(
  lock: ComputerUseDriverLock,
  options: Readonly<{ signal?: AbortSignal; transport?: ComputerUseDownloadTransport }> = {},
): Promise<Uint8Array> {
  return downloadLockedComputerUseDriver(lock, 'darwin', options)
}

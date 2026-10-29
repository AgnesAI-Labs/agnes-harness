import type { ComputerUseDoctorParams } from '@agnes/protocol'
import type {
  ComputerUseDriverOperationKind,
  ComputerUseDriverOperationSnapshot,
} from './driver-operation-runtime.js'
import type { ComputerUseAvailability } from './lazy-runtime.js'

export type HostComputerUseRuntimeStatus = Readonly<{
  platform: 'win32' | 'darwin' | 'linux'
  version: string
  publisher: string
  activeSessions: number
  startAttempted: boolean
}>

export type HostComputerUseStatusSource = Readonly<{
  status(): HostComputerUseRuntimeStatus | Readonly<{ availability: ComputerUseAvailability }>
  doctor(params?: ComputerUseDoctorParams): Promise<void>
  permissionsStatus(): Promise<Readonly<{ accessibility: boolean; screenRecording: boolean }> | null>
  permissionsGrant(): Promise<Readonly<{ accessibility: boolean; screenRecording: boolean }> | null>
  setSessionYolo(session: Readonly<{ key: string; lane: string }>, enabled: boolean): Promise<void>
  operationStart(kind: ComputerUseDriverOperationKind): ComputerUseDriverOperationSnapshot
  operationStatus(operationId?: string): ComputerUseDriverOperationSnapshot | undefined
  operationCancel(operationId: string): ComputerUseDriverOperationSnapshot | undefined
}>

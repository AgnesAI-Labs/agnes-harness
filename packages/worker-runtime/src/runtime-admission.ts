import type { Host } from '@agnes/host'
import type { RuntimeRunCommandFrame } from './frames.js'

/** Admission-only entry. It never opens a legacy session or executes a model/tool turn. */
export function handleRuntimeRunCommand(host: Host, command: RuntimeRunCommandFrame) {
  switch (command.method) {
    case 'runtime.run.create':
      return host.runtimeServices.runAdmission({ operation: 'create', request: command.params?.request })
    case 'runtime.run.cancel':
      return host.runtimeServices.runAdmission({ operation: 'cancel', request: command.params?.request })
    case 'runtime.run.status':
      return host.runtimeServices.runAdmission({ operation: 'status', request: command.params?.request })
    case 'runtime.run.probe':
      return host.runtimeServices.runAdmission({ operation: 'probe', request: command.params?.request })
  }
}

export function isRuntimeRunMethod(method: string): method is RuntimeRunCommandFrame['method'] {
  return ['runtime.run.create', 'runtime.run.status', 'runtime.run.cancel', 'runtime.run.probe'].includes(
    method,
  )
}

import type { Host } from '@agnes/host'
import type { RuntimeRunCommandFrame } from './frames.js'

/** Explicit runtime entry. Installed execution follows confirmed admission and never opens a legacy session. */
export async function handleRuntimeRunCommand(host: Host, command: RuntimeRunCommandFrame) {
  switch (command.method) {
    case 'runtime.run.create': {
      const admitted = await host.runtimeServices.runAdmission({
        operation: 'create',
        request: command.params?.request,
      })
      if (!admitted.ok || admitted.value.state !== 'created' || !host.runtimeServices.runLoop) return admitted
      const started = await host.runtimeServices.runLoop(command.params.request)
      return started.ok ? admitted : started
    }
    case 'runtime.run.cancel': {
      const cancelled = await host.runtimeServices.runAdmission({
        operation: 'cancel',
        request: command.params?.request,
      })
      if (cancelled.ok) await host.runtimeServices.cancelLoop?.(command.params.request.ticketId)
      return cancelled
    }
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

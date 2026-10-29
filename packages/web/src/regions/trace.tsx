import { SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createRegionRenderer } from '@agnes/web-ui'
import type { TracePanelOptions } from '@agnes/web-units/shell'
import { Trace, type TraceHandle } from '@agnes/web-units/shell'
import { flushSync } from 'react-dom'
import type { EmptyStateRegionMount } from './contracts.js'
import { TRACE_SLOT } from './contracts.js'
/** The trace pane retains outer visibility semantics while its renderer owns a slot leaf. */
export function mountTraceRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: TraceRegionOptions,
): TraceRegionMount {
  registry.declare(TRACE_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const handle = { current: null as TraceHandle | null }
  const removeBuiltin = registry.register(
    { name: TRACE_SLOT as string, id: 'builtin-trace', owner: '@agnes/web-trace', priority: 0 },
    () => <Trace ref={handle} root={container} options={options} />,
  )
  const root = createRegionRenderer(container)
  flushSync(() => {
    root.render(
      <SlotsProvider registry={registry}>
        <SlotOutlet name={TRACE_SLOT} />
      </SlotsProvider>,
    )
  })
  let disposed = false
  return {
    render(nodes, turns, meta) {
      handle.current?.render(nodes, turns, meta)
    },
    setOpen(open) {
      handle.current?.setOpen(open)
    },
    isOpen() {
      return handle.current?.isOpen() ?? false
    },
    selectTool(sessionId, callSeq, resultSeq) {
      return handle.current?.selectTool?.(sessionId, callSeq, resultSeq) ?? false
    },
    focusFact(params) {
      return handle.current?.focusFact?.(params) ?? false
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}
export type TraceRegionOptions = Omit<TracePanelOptions, 'root'>
export interface TraceRegionMount extends EmptyStateRegionMount, TraceHandle {}

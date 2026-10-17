import type { ComponentType } from 'react'
import type { PlotProps } from './chart-plot.js'

declare const __AGNES_WEB_BUNDLE__: boolean
type ChartModule = typeof import('./chart-module.js')
type BodyProps = Omit<PlotProps, 'engine'>
let pending: Promise<{ default: ComponentType<BodyProps> }> | undefined
let attempt = 0

/** A self-contained optional asset can recover from a cached module-fetch failure. */
export function loadChart(): Promise<{ default: ComponentType<BodyProps> }> {
  pending ??= (
    typeof __AGNES_WEB_BUNDLE__ !== 'undefined' && __AGNES_WEB_BUNDLE__
      ? (import(
          new URL(`./recharts.js${attempt++ ? `?retry=${attempt}` : ''}`, import.meta.url).href
        ) as Promise<ChartModule>)
      : import('./chart-module.js')
  )
    .then((engine) => ({
      default: function LoadedPlot(props: BodyProps) {
        return <engine.default {...props} engine={engine} />
      },
    }))
    .catch((error: unknown) => {
      pending = undefined
      throw error
    })
  return pending
}

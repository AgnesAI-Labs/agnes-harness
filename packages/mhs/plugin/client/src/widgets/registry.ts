/**
 * Which widget draws which source (mhs-ui-design section 7): every widget scores a source, the
 * highest score wins, and `ui.widget` names one directly. Unmatched sources get a table of their
 * fields or JSON.
 */
import type { ComponentType } from 'react'
import type { Source } from '../core/types.js'
import { JsonView, NumbersView, OdometryView, TextLog, ValuesView } from './data.js'
import type { SourceProps } from './frame.js'
import { ImageView, VideoView } from './image.js'
import { AudioView, ScanView } from './scan.js'

export interface Widget {
  id: string
  match: (s: Source) => number
  /** Columns in the device page grid, and the narrowest it can be. */
  size: { cols: 1 | 2; minPx: number }
  component: ComponentType<SourceProps>
}

const widgets: Widget[] = []

export function registerWidget(widget: Widget): void {
  widgets.push(widget)
}

registerWidget({
  id: 'image',
  match: (s) => (s.kind === 'image' ? 10 : 0),
  size: { cols: 2, minPx: 280 },
  component: ImageView,
})
registerWidget({
  id: 'video',
  match: (s) => (s.kind === 'video' ? 10 : 0),
  size: { cols: 2, minPx: 280 },
  component: VideoView,
})
registerWidget({
  id: 'scan',
  match: (s) => (s.kind === 'scan' ? 10 : 0),
  size: { cols: 1, minPx: 220 },
  component: ScanView,
})
registerWidget({
  id: 'values',
  match: (s) => (s.kind === 'values' || s.kind === 'switch' ? 10 : 0),
  size: { cols: 1, minPx: 220 },
  component: ValuesView,
})
registerWidget({
  id: 'text',
  match: (s) => (s.kind === 'text' || s.kind === 'transcript' ? 10 : 0),
  size: { cols: 1, minPx: 220 },
  component: TextLog,
})
registerWidget({
  id: 'odometry',
  match: (s) => (s.kind === 'odometry' ? 10 : 0),
  size: { cols: 1, minPx: 220 },
  component: OdometryView,
})
registerWidget({
  id: 'numbers',
  match: (s) => (s.kind === 'imu' || s.kind === 'gnss' ? 5 : 0),
  size: { cols: 1, minPx: 220 },
  component: NumbersView,
})
registerWidget({
  id: 'audio',
  match: (s) => (s.kind === 'audio' ? 10 : 0),
  size: { cols: 1, minPx: 220 },
  component: AudioView,
})
registerWidget({ id: 'json', match: () => 1, size: { cols: 1, minPx: 220 }, component: JsonView })

/** Kinds drawn elsewhere: pose and grid by the map, detections on their camera's picture. */
export const DRAWN_ELSEWHERE = new Set(['pose', 'grid', 'detections'])

export function widgetFor(source: Source): Widget {
  const named = source.ui?.widget && widgets.find((w) => w.id === source.ui?.widget)
  if (named) return named
  let best = widgets[widgets.length - 1] as Widget
  let score = 0
  for (const w of widgets) {
    const s = w.match(source)
    if (s > score) {
      best = w
      score = s
    }
  }
  return best
}

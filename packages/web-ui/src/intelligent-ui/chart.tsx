import type { JsonValue, UiComponent } from '@agnes/protocol/gen/intelligent-ui'
import { useId } from 'react'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { uiObject } from './validate.js'

type Chart = Extract<UiComponent, { kind: 'chart' }>
const colors = [
  '--agnes-brand-primary',
  '--agnes-status-success-text',
  '--agnes-status-warning-text',
  '--agnes-status-danger-text',
]

export function IntelligentChart({ component, data }: { component: Chart; data: JsonValue }) {
  const titleId = useId()
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const rows = Array.isArray(data) ? data.filter(uiObject) : []
  const values = rows.flatMap((row) => component.series.map((series) => Number(row[series.key])))
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values)
  const scale = Math.max(Math.abs(min), Math.abs(max), 1)
  const y = (n: number) => 180 - ((n / scale - min / scale) / (max / scale - min / scale || 1)) * 160
  const x = (i: number) => 20 + ((i + 0.5) / Math.max(1, rows.length)) * 560
  const total = values.reduce((a, b) => a + b / scale, 0)
  let angle = -Math.PI / 2
  return (
    <figure data-testid={`ui-chart-${component.id}`}>
      <svg viewBox="0 0 600 210" width="100%" role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          {component.title ?? component.series.map((series) => series.label).join(', ')}
        </title>
        {component.chartType !== 'pie' && <line x1="20" x2="580" y1={y(0)} y2={y(0)} stroke="currentColor" />}
        {component.chartType === 'pie'
          ? rows.map((row, i) => {
              const fraction = total ? Number(row[component.series[0]!.key]) / scale / total : 0
              const start = angle
              angle += fraction * Math.PI * 2
              const color = `var(${colors[i % colors.length]})`
              if (fraction === 1)
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: chart marks are stateless ordinal positions, and categories may repeat.
                  <circle key={i} cx="300" cy="100" r="80" fill={color}>
                    <title>
                      {String(row[component.categoryKey])}: {values[i]}
                    </title>
                  </circle>
                )
              return (
                fraction > 0 && (
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: stateless ordinal marks allow repeated categories.
                    key={i}
                    fill={color}
                    d={`M300 100 L${300 + Math.cos(start) * 80} ${100 + Math.sin(start) * 80} A80 80 0 ${fraction > 0.5 ? 1 : 0} 1 ${300 + Math.cos(angle) * 80} ${100 + Math.sin(angle) * 80} Z`}
                  >
                    <title>
                      {String(row[component.categoryKey])}: {values[i]}
                    </title>
                  </path>
                )
              )
            })
          : component.series.map((series, index) => (
              <g
                key={series.key}
                fill={`var(${colors[index % colors.length]})`}
                stroke={`var(${colors[index % colors.length]})`}
              >
                {component.chartType === 'line' && (
                  <polyline
                    fill="none"
                    strokeWidth="2"
                    points={rows.map((row, i) => `${x(i)},${y(Number(row[series.key]))}`).join(' ')}
                  />
                )}
                {rows.map((row, i) =>
                  component.chartType === 'bar' ? (
                    <rect
                      // biome-ignore lint/suspicious/noArrayIndexKey: stateless ordinal marks allow repeated categories.
                      key={i}
                      x={
                        x(i) -
                        260 / Math.max(1, rows.length) +
                        (index * 520) / Math.max(1, rows.length) / component.series.length
                      }
                      y={Math.min(y(0), y(Number(row[series.key])))}
                      width={Math.max(0.1, 480 / Math.max(1, rows.length) / component.series.length)}
                      height={Math.abs(y(Number(row[series.key])) - y(0))}
                    >
                      <title>
                        {String(row[component.categoryKey])} · {series.label}: {String(row[series.key])}
                      </title>
                    </rect>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chart marks are stateless ordinal positions, and categories may repeat.
                    <circle key={i} cx={x(i)} cy={y(Number(row[series.key]))} r="3">
                      <title>
                        {String(row[component.categoryKey])} · {series.label}: {String(row[series.key])}
                      </title>
                    </circle>
                  ),
                )}
              </g>
            ))}
      </svg>
      <details>
        <summary>{t('ui.chartData')}</summary>
        <table>
          <caption>{component.title ?? t('ui.chartData')}</caption>
          <thead>
            <tr>
              <th scope="col">{component.categoryKey}</th>
              {component.series.map((series) => (
                <th scope="col" key={series.key}>
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: chart marks are stateless ordinal positions, and categories may repeat.
              <tr key={i}>
                <th scope="row">{String(row[component.categoryKey])}</th>
                {component.series.map((series) => (
                  <td key={series.key}>{String(row[series.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

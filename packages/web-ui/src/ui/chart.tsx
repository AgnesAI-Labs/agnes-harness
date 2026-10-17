import type { HTMLAttributes } from 'react'
import { lazy, Suspense, useId, useState } from 'react'
import { loadChart } from './chart-load.js'
import { Disclosure } from './disclosure.js'

export type ChartSeries = { key: string; label: string }
export type ChartProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  chartType: 'bar' | 'line' | 'area' | 'pie'
  title: string
  categoryKey: string
  series: readonly ChartSeries[]
  rows: readonly Record<string, unknown>[]
  dataLabel: string
  formatValue?(value: unknown): string
}
const colors = [
  '--agnes-brand-primary',
  '--agnes-status-success-text',
  '--agnes-status-warning-text',
  '--agnes-status-danger-text',
]
const color = (index: number) => `var(${colors[index % colors.length]})`

/** Recharts renders marks; the always-available source table preserves exact accessible values. */
export function Chart({
  chartType,
  title,
  categoryKey,
  series,
  rows,
  dataLabel,
  formatValue = String,
  className,
  ...props
}: ChartProps) {
  const titleId = useId()
  // A region retry remounts this loader, so a rejected import can be attempted again.
  const [Plot] = useState(() => lazy(loadChart))
  const legend =
    chartType === 'pie' ? rows.map((row, i) => ({ key: String(i), label: String(row[categoryKey]) })) : series
  return (
    <figure
      {...props}
      className={['agh-chart', 'agnes-intelligent-chart', className].filter(Boolean).join(' ')}
    >
      <div className="agh-chart-plot" role="img" aria-labelledby={titleId}>
        <span id={titleId} className="agh-visually-hidden">
          {title}
        </span>
        <Suspense fallback={null}>
          <Plot
            chartType={chartType}
            title={title}
            categoryKey={categoryKey}
            series={series}
            rows={rows}
            formatValue={formatValue}
            color={color}
          />
        </Suspense>
      </div>
      <figcaption className="agnes-intelligent-chart-legend">
        {legend.map((item, index) => (
          <span key={item.key}>
            <span
              aria-hidden="true"
              className="agnes-intelligent-chart-key"
              style={{ background: color(index) }}
            />
            {item.label}
          </span>
        ))}
      </figcaption>
      <Disclosure variant="plain" summary={dataLabel}>
        <div
          className="agnes-intelligent-table-scroll"
          role="region"
          aria-label={title || dataLabel}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the labelled source table region scrolls independently.
          tabIndex={0}
        >
          <table>
            <caption>{title || dataLabel}</caption>
            <thead>
              <tr>
                <th scope="col">{categoryKey}</th>
                {series.map((item) => (
                  <th scope="col" key={item.key} data-numeric>
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stateless source rows allow repeated categories.
                <tr key={index}>
                  <th scope="row">{String(row[categoryKey])}</th>
                  {series.map((item) => (
                    <td key={item.key} data-numeric>
                      {formatValue(row[item.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </figure>
  )
}

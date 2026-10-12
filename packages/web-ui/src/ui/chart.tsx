import type { HTMLAttributes } from 'react'
import { useId } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

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
  const numericRows = rows.map((row) =>
    Object.fromEntries([
      [categoryKey, row[categoryKey]],
      ...series.map((item) => [item.key, Number(row[item.key])]),
    ]),
  )
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
        <ResponsiveContainer
          width="100%"
          height={210}
          minWidth={0}
          initialDimension={{ width: 600, height: 210 }}
        >
          {chartType === 'pie' ? (
            <PieChart title={title} role="img" accessibilityLayer={false}>
              <Pie
                data={numericRows}
                dataKey={series[0]?.key ?? ''}
                nameKey={categoryKey}
                outerRadius={80}
                isAnimationActive={false}
              >
                {rows.map((_row, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: chart marks are ordinal; category values may repeat.
                  <Cell key={index} fill={color(index)} stroke="var(--agnes-bg-app-content)" />
                ))}
              </Pie>
              <Tooltip
                formatter={(value) => formatValue(value)}
                contentStyle={{
                  background: 'var(--agnes-bg-popover)',
                  borderColor: 'var(--agnes-line-primary)',
                  color: 'var(--agnes-text-primary)',
                  borderRadius: 'var(--radius-control)',
                  fontVariantNumeric: 'tabular-nums',
                }}
                itemStyle={{ color: 'var(--agnes-text-primary)' }}
              />
            </PieChart>
          ) : (
            <ComposedChart
              data={numericRows}
              title={title}
              role="img"
              accessibilityLayer={false}
              margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
            >
              <CartesianGrid stroke="var(--agnes-line-primary)" vertical={false} />
              <XAxis
                dataKey={categoryKey}
                tickFormatter={(value) => {
                  const characters = Array.from(String(value))
                  return characters.length > 14 ? `${characters.slice(0, 14).join('')}…` : String(value)
                }}
                stroke="var(--agnes-text-secondary)"
                tick={{ fill: 'var(--agnes-text-secondary)' }}
              />
              <YAxis stroke="var(--agnes-text-secondary)" tick={{ fill: 'var(--agnes-text-secondary)' }} />
              <Tooltip
                formatter={(value) => formatValue(value)}
                contentStyle={{
                  background: 'var(--agnes-bg-popover)',
                  borderColor: 'var(--agnes-line-primary)',
                  color: 'var(--agnes-text-primary)',
                  borderRadius: 'var(--radius-control)',
                  fontVariantNumeric: 'tabular-nums',
                }}
                itemStyle={{ color: 'var(--agnes-text-primary)' }}
              />
              {series.map((item, index) =>
                chartType === 'bar' ? (
                  <Bar
                    key={item.key}
                    dataKey={item.key}
                    name={item.label}
                    fill={color(index)}
                    isAnimationActive={false}
                  />
                ) : chartType === 'area' ? (
                  <Area
                    key={item.key}
                    dataKey={item.key}
                    name={item.label}
                    stroke={color(index)}
                    fill={color(index)}
                    fillOpacity={0.18}
                    isAnimationActive={false}
                  />
                ) : (
                  <Line
                    key={item.key}
                    dataKey={item.key}
                    name={item.label}
                    stroke={color(index)}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                ),
              )}
            </ComposedChart>
          )}
        </ResponsiveContainer>
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
      <details>
        <summary>{dataLabel}</summary>
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
      </details>
    </figure>
  )
}

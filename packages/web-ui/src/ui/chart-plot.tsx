import type { ChartProps } from './chart.js'

export type PlotProps = Pick<ChartProps, 'chartType' | 'title' | 'categoryKey' | 'series' | 'rows'> & {
  formatValue(value: unknown): string
  color(index: number): string
  engine: typeof import('../recharts-vendor.js')
}

/** Only the plotting engine is deferred; the figure, legend and source table stay available. */
export default function ChartPlot({
  chartType,
  title,
  categoryKey,
  series,
  rows,
  formatValue,
  color,
  engine,
}: PlotProps) {
  const {
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
  } = engine
  const numericRows = rows.map((row) =>
    Object.fromEntries([
      [categoryKey, row[categoryKey]],
      ...series.map((item) => [item.key, Number(row[item.key])]),
    ]),
  )
  return (
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
  )
}

import type { JsonValue, UiComponent } from '@agnes/protocol/gen/intelligent-ui'
import { Chart } from '../ui/chart.js'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { uiObject } from './validate.js'

type ChartComponent = Extract<UiComponent, { kind: 'chart' }>

export function IntelligentChart({ component, data }: { component: ChartComponent; data: JsonValue }) {
  const { t, locale } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  return (
    <Chart
      data-testid={`ui-chart-${component.id}`}
      chartType={component.chartType}
      title={component.title ?? component.series.map((series) => series.label).join(', ')}
      categoryKey={component.categoryKey}
      series={component.series}
      rows={Array.isArray(data) ? data.filter(uiObject) : []}
      dataLabel={t('ui.chartData')}
      formatValue={(value) =>
        typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : String(value)
      }
    />
  )
}

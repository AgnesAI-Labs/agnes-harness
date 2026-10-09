import type { UiCustomComponent, UiSurface } from '@agnes/protocol/gen/intelligent-ui'
import { Component, type ReactNode } from 'react'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'

export interface CustomUiRenderProps {
  component: UiCustomComponent
  surface: UiSurface
  disabled: boolean
  onAction(id: string): void
}
export type CustomUiRenderer = (props: CustomUiRenderProps) => ReactNode

export function CustomUiFallback({ component }: { component: UiCustomComponent }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  return (
    <div data-testid={`ui-custom-fallback-${component.id}`}>
      <p role="status">{t('ui.customFallback')}</p>
      <p>{component.fallback}</p>
    </div>
  )
}
class RendererBoundary extends Component<
  { component: UiCustomComponent; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? <CustomUiFallback component={this.props.component} /> : this.props.children
  }
}
export function CustomUiComponent(props: CustomUiRenderProps & { render?: CustomUiRenderer }) {
  if (!props.render) return <CustomUiFallback component={props.component} />
  const Renderer = props.render
  return (
    <RendererBoundary component={props.component}>
      <Renderer {...props} />
    </RendererBoundary>
  )
}

import { Component, type ReactNode } from 'react'
import { SettingsState } from '../settings-layout.js'
import { Button } from '../ui/button.js'

/** A failed business renderer cannot take down the conversation or its siblings. */
export class SurfaceRenderBoundary extends Component<
  { children: ReactNode; message: string; retry: string },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? (
      <SettingsState tone="error" role="alert">
        {this.props.message}
        <Button onClick={() => this.setState({ failed: false })}>{this.props.retry}</Button>
      </SettingsState>
    ) : (
      this.props.children
    )
  }
}

import type { TuiApp } from './app.js'
import type { Component } from './component.js'
import { createProviderSetup } from './provider-command.js'
import type { InputDialog } from './root-input.js'
import type { ThemedAnsi } from './theme.js'
import type { ProviderSetup } from './views/provider-setup.js'

/** The transient command dialogs the app mounts above its footer, created and listed in one place. */
export class AppDialogs {
  readonly providerSetup: ProviderSetup

  constructor(app: TuiApp, ansi: ThemedAnsi, locale: string) {
    this.providerSetup = createProviderSetup(app, ansi, locale)
  }

  /** In the order they are drawn and offered a keystroke; a pending approval makes them give up their rows. */
  inputs(app: TuiApp): readonly (Component & InputDialog)[] {
    return [
      app.modelPicker,
      app.themePicker,
      app.sessionPicker,
      this.providerSetup,
      app.usagePanel,
      app.statusLine,
    ]
  }
}

import type { Branding, NodeClient, Session } from '@agnes/sdk'
import type { ExternalEditorConfig } from './external-editor.js'
import type { TuiExtraOptions } from './extra-options.js'
import type { Locale } from './locale.js'
import type { TuiResourceController } from './resource-controller.js'
import type { Terminal } from './terminal.js'
import type { WelcomeOptions } from './welcome-controller.js'
import type { WorkspaceProbe } from './workspace-info.js'

/** Everything `new TuiApp(...)` takes; kept here so app.ts stays under the file-size budget. */
export type TuiAppOptions = {
  term: Terminal
  session: Session
  header?: string
  profile?: string
  preset?: string
  /** The model the user explicitly chose on argv; omitted when the session default applies. */
  model?: string
  /** Resolved once by sdk before construction; session switches retain the same client brand. */
  branding?: Branding
  locale?: Locale
  controlClient?: NodeClient
  /** Resource commands use this injected port; the chat/session client has no such authority. */
  resourceController?: TuiResourceController
  /** The CLI has already entered its alternate screen before opening the session. */
  screenAlreadyEntered?: boolean
  /** `--no-alt-screen`: settled turns go into the terminal's own scrollback; only the footer is redrawn. */
  noAltScreen?: boolean
  /** Where mouse-selected text goes; defaults to the system clipboard. */
  copy?: (text: string, fail: () => void) => unknown
  /** The open session's workspace: first the one the CLI opened in (`--cwd`, else `process.cwd()`), then each switched-to session's. */
  cwd?: string
  /** True over `--connect`: `@` completion then never falls back to this machine's disk. */
  remote?: boolean
  /** Last model and permission for the next fresh session. Omitted in tests that do not inherit. */
  composerSelectionPath?: string
  themePreferencePath?: string
  notifyPreferencePath?: string
  /** Where sent prompts persist between runs; without it history lasts this run only. */
  historyPath?: string
  /** `<AGH_HOME>/commands`: where personal custom slash commands live. */
  commandsDir?: string
  /** Ctrl-G's editor command source and temp directory (`<AGH_HOME>/tmp`); tests leave it to the defaults. */
  externalEditor?: ExternalEditorConfig
  /** What the launcher knows for the welcome, and what tests pin (see `WelcomeOptions`). */
  welcome?: WelcomeOptions
  /** Shown once on the status bar after a fresh session inherits a model or full permission. */
  initialNotice?: string
  /** Reads branch and worktree for the composer rail; the gallery injects fixed answers. */
  probeWorkspace?: WorkspaceProbe
} & TuiExtraOptions

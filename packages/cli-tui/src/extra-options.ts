import type { UITimeline } from '@agnes/protocol'
import type { ExternalRoots } from './external-sessions.js'

/** TuiApp options added by later features, kept here so app.ts does not grow. */
export type TuiExtraOptions = {
  /** `--ignore-rules`: no personal or project custom slash commands are loaded. */
  noCustomCommands?: boolean
  /** `--safe-mode`: shown on the status bar for as long as the session runs. */
  safeMode?: boolean
  /** Called with the new session's id once /new, /resume or a picker choice made it the current one. */
  onSessionSwitch?: (sessionId: string) => void
  /** Mouse reporting at startup; `false` starts with it off. Absent means on, and `/mouse` toggles it either way. */
  mouse?: boolean
  /** Called with every projected timeline and, when the projection reported a window, whether older history is not loaded. */
  onTimeline?: (timeline: UITimeline, hasEarlier?: boolean) => void
  /** `/import`: brings one external session file into this machine's home. Absent unless the local daemon form. */
  importSession?: (file: string, from?: string) => Promise<{ key: string }>
  /** Where `/import` looks for Claude Code and codex sessions; defaults to `~/.claude/projects` and `~/.codex/sessions`. */
  externalRoots?: ExternalRoots
}

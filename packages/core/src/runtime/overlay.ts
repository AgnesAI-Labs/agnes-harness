/** Host-owned session overlay mutation. Core never imports Cordis or plugin-runtime. */
export type SessionOverlayPort = Readonly<{
  apply(sessionKey: string, overlay: Readonly<{ preset: string }>): Promise<void>
}>

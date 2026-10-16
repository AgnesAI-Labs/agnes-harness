export function clientImportMap(html?: string): Record<string, string>
export function assertClientExternals(
  metafile: { outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }> },
  imports?: Readonly<Record<string, string>>,
): void
export const clientPlatformExternals: {
  name: string
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string }) => { path: string; external: true } | undefined,
    ): void
  }): void
}

export const xSurface: {
  name: string
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string; importer: string }) => { path: string; namespace: string } | undefined,
    ): void
    onLoad(
      options: { filter: RegExp; namespace: string },
      callback: (args: { path: string }) => { contents: string; loader: 'js' },
    ): void
  }): void
}

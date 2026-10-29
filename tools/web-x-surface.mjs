// Ant Design X's root module also declares Mermaid and CodeHighlighter. Web UI does not expose
// them, but a code-splitting build still emits every dynamic import it parses, which would ship
// the diagram and highlighter libraries as unreachable chunks. Resolve those two libraries to a
// stub that fails loudly if a later X surface starts using them.
const unused = /^(?:mermaid|react-syntax-highlighter)(?:\/|$)/

export const xSurface = {
  name: 'agnes-x-surface',
  setup(build) {
    build.onResolve({ filter: unused }, ({ path, importer }) =>
      /[/\\]@ant-design[/\\]x[/\\]/.test(importer) ? { path, namespace: 'agnes-x-unused' } : undefined,
    )
    build.onLoad({ filter: /.*/, namespace: 'agnes-x-unused' }, ({ path }) => ({
      contents: `module.exports = new Proxy({}, { get() { throw new Error(${JSON.stringify(
        `${path} is not part of the Agnes Ant Design X surface`,
      )}) } })`,
      loader: 'js',
    }))
  },
}

// Vitest serves a file imported with `?raw` as its text. Runtime tests read their fixture files this
// way because the web client compiles without Node types.
declare module '*?raw' {
  const text: string
  export default text
}

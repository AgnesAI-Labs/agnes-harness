// Only delivery builds select production React; development keeps its diagnostics and source maps.
// Keep function names because plugin diagnostics and component stacks expose them.
export const productionWebOptions = {
  minify: true,
  keepNames: true,
  define: { 'process.env.NODE_ENV': '"production"' },
}

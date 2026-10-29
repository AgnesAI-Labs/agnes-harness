export const productionWebOptions: {
  minify: true
  keepNames: true
  define: { 'process.env.NODE_ENV': '"production"' }
}

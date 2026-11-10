// Preloaded through NODE_OPTIONS: reports the Node flags the SEA executable started with.
process.stderr.write(`exec-argv ${JSON.stringify(process.execArgv)}\n`)

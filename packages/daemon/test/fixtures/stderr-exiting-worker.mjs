// Dies before hello the way a worker that cannot load does: a reason on stderr, then a non-zero exit.
process.stderr.write('worker boot failed: cannot load module\nat load (worker.mjs:1:1)\n', () =>
  process.exit(7),
)

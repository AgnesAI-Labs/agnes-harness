import '../fake-supervisor-entry.js'

// Windows OS signals force termination. This test-only channel invokes the fixture's existing
// handler, which awaits the real supervisor and SQLite cleanup before exiting successfully.
process.on('message', (message) => {
  if (message === 'test:close') process.emit('SIGTERM')
})

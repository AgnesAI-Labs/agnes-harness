// Only the test parent owns this Node IPC channel. Windows OS signals force termination;
// deliver the event to the CLI's real handler so it must close its client and exit with 143.
process.on('message', (message) => {
  if (message === 'test:SIGTERM') process.emit('SIGTERM')
})
process.channel?.unref()

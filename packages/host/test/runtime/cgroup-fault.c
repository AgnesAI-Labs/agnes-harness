/* Inject controller syscalls only; never fake cgroup identity or delegation. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int controller_fd(int fd) {
  char path[64], target[4096];
  snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
  ssize_t length = readlink(path, target, sizeof(target) - 1);
  if (length < 0) return 0;
  target[length] = 0;
  const char *base = strrchr(target, '/');
  const char *control = getenv("HARD_GATE_CONTROL");
  return base && !strcmp(base + 1, control ? control : "memory.max");
}
static ssize_t faulty_write(int fd, const void *bytes, size_t count) {
  const char *mode = getenv("HARD_GATE_FAULT");
  if (mode && controller_fd(fd)) {
    if (!strcmp(mode, "write-failure")) { errno = EIO; return -1; }
    if (!strcmp(mode, "short-write")) return count ? (ssize_t)count - 1 : 0;
  }
  return write(fd, bytes, count);
}
static ssize_t faulty_read(int fd, void *bytes, size_t count) {
  const char *mode = getenv("HARD_GATE_FAULT");
  if (mode && !strcmp(mode, "read-mismatch") && controller_fd(fd) && count >= 4) {
    memcpy(bytes, "999\n", 4); return 4;
  }
  return read(fd, bytes, count);
}
#define write faulty_write
#define read faulty_read
#include GOVERNOR_SOURCE

/* Trusted test probe: only controller proof, never complete service qualification. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
static void allocate(void) {
  volatile char *memory = malloc(40 * 1024 * 1024);
  if (!memory) _exit(3);
  for (unsigned i = 0; i < 40 * 1024 * 1024; i += 4096) memory[i] = 1;
  for (;;) pause();
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int membership = openat(5, "cgroup.procs", O_WRONLY);
  if (membership < 0 || dprintf(membership, "%ld", (long)getpid()) < 0) return 3;
  close(membership); close(5);
  if (!strcmp(argv[1], "memory")) {
    volatile char *memory = malloc(40 * 1024 * 1024);
    if (!memory) return 4;
    for (unsigned i = 0; i < 40 * 1024 * 1024; i += 4096) memory[i] = 1;
    pid_t child = fork();
    if (child < 0) return 5;
    if (!child) allocate();
    for (;;) pause();
  }
  pid_t child = fork();
  if (child < 0) return 6;
  if (!child) {
    pid_t grandchild = fork();
    if (grandchild == -1 && errno == EAGAIN) {
      puts("fork-denied"); fflush(stdout); _exit(0);
    }
    if (!grandchild) _exit(7);
    if (grandchild > 0) waitpid(grandchild, NULL, 0);
    _exit(8);
  }
  int status;
  if (waitpid(child, &status, 0) != child) return 9;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 10;
}

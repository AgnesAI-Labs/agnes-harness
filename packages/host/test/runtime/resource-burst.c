/* Real observations bracket a short allocation/free or fork/exit excursion.
 * The observations are diagnostics, never a resource ceiling proof. Darwin fixture. */
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
static uint64_t rss(pid_t process) {
  struct proc_taskinfo task;
  if (proc_pidinfo(process, PROC_PIDTASKINFO, 0, &task, sizeof task) != sizeof task) exit(3);
  return task.pti_resident_size;
}
static uint64_t processes(pid_t root) {
  pid_t children[16];
  int bytes = proc_listchildpids(root, children, sizeof children);
  if (bytes < 0) exit(4);
  return 1 + (unsigned)bytes / sizeof(pid_t);
}
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  int start[2], done[2], release[2];
  if (pipe(start) || pipe(done) || pipe(release)) return 5;
  int memory_mode = !strcmp(argv[1], "memoryBytes");
  pid_t probe = fork();
  if (probe < 0) return 6;
  if (!probe) {
    close(start[1]); close(done[0]); close(release[1]);
    char token;
    if (read(start[0], &token, 1) != 1) _exit(7);
    uint64_t peak;
    if (memory_mode) {
      size_t size = 8 * 1024 * 1024;
      volatile char *memory = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
      if ((void *)memory == MAP_FAILED) _exit(8);
      for (size_t i = 0; i < size; i += 4096) memory[i] = 1;
      peak = rss(getpid());
      if (munmap((void *)memory, size)) _exit(9);
    } else {
      pid_t transient = fork();
      if (transient < 0) _exit(10);
      if (!transient) _exit(0);
      peak = 2; /* Successful fork proves coexistence before the child's exit. */
      if (waitpid(transient, NULL, 0) != transient) _exit(11);
    }
    if (write(done[1], &peak, sizeof peak) != sizeof peak) _exit(12);
    if (read(release[0], &token, 1) != 1) _exit(13);
    _exit(0);
  }
  close(start[0]); close(done[1]); close(release[0]);
  uint64_t before = memory_mode ? rss(probe) : processes(probe);
  char token = 1;
  if (write(start[1], &token, 1) != 1) return 14;
  uint64_t excursion;
  if (read(done[0], &excursion, sizeof excursion) != sizeof excursion) return 15;
  uint64_t after = memory_mode ? rss(probe) : processes(probe);
  if (write(release[1], &token, 1) != 1 || waitpid(probe, NULL, 0) != probe) return 16;
  if (argc == 3) {
    FILE *effect = fopen(argv[2], "w");
    if (!effect) return 17;
    fputs("business started", effect); fclose(effect);
  }
  printf("{\"before\":%llu,\"after\":%llu,\"excursion\":%llu}\n",
    (unsigned long long)before, (unsigned long long)after, (unsigned long long)excursion);
  return 0;
}

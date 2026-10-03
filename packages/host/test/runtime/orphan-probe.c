/* A local ownership counterexample. The test owns and reaps the reported PID. */
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 2;
  usleep(5000);
  pid_t child = fork();
  if (child < 0) return 2;
  if (child > 0) {
    /* The Linux hostile case must reach descriptor closure before root exit. */
    if (argc == 3) {
      int ready = 0;
      for (int i = 0; i < 5000 && !ready; i++) {
        FILE *probe = fopen(argv[1], "r"); int number;
        if (probe) { ready = fscanf(probe, "%d", &number) == 1 && number > 0; fclose(probe); }
        if (!ready) usleep(1000);
      }
      if (!ready) return 3;
    }
    return 0;
  }
  if (setsid() < 0) _exit(2);
  pid_t leaf = fork();
  if (leaf < 0) _exit(2);
  if (leaf > 0) _exit(0);
  if (argc == 3) for (int fd = 0; fd < 1024; fd++) close(fd);
  FILE *f = fopen(argv[1], "w");
  if (!f) _exit(2);
  fprintf(f, "%d\n", getpid()); fclose(f);
  close(0); close(1); close(2);
  sleep(30);
  _exit(0);
}

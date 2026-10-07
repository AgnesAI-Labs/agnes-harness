/* Host PTY relay. stdin/stdout carry terminal bytes; fd 3 carries resize/signal/close lines. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#include <libproc.h>
#else
#include <pty.h>
#include <dirent.h>
#endif

static pid_t child;
static void stop_session(int sig) {
  /* Interactive shells put jobs in separate process groups, all in this PTY session. */
#ifdef __APPLE__
  int n = proc_listallpids(NULL, 0);
  pid_t *pids = calloc((size_t)n + 128, sizeof(pid_t));
  if (pids) {
    n = proc_listallpids(pids, (n + 128) * (int)sizeof(pid_t));
    for (int i = 0; i < n; i++)
      if (pids[i] > 0 && getsid(pids[i]) == child) kill(pids[i], sig);
    free(pids);
  }
#else
  DIR *dir = opendir("/proc");
  if (dir) {
    struct dirent *entry;
    while ((entry = readdir(dir))) {
      pid_t pid = (pid_t)atoi(entry->d_name);
      if (pid > 0 && getsid(pid) == child) kill(pid, sig);
    }
    closedir(dir);
  }
#endif
  kill(-child, sig);
}
static int copy_all(int fd, const char *data, size_t size) {
  while (size) {
    ssize_t n = write(fd, data, size);
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    data += n; size -= (size_t)n;
  }
  return 0;
}
int main(int argc, char **argv) {
  if (argc < 4) return 125;
  struct winsize size = { .ws_col = (unsigned short)atoi(argv[1]), .ws_row = (unsigned short)atoi(argv[2]) };
  int master;
  child = forkpty(&master, NULL, NULL, &size);
  if (child < 0) { perror("forkpty"); return 125; }
  if (child == 0) {
    close(3);
    execvp(argv[3], argv + 3);
    perror("execvp"); _exit(127);
  }
  signal(SIGPIPE, SIG_IGN);
  struct pollfd fds[] = {{0, POLLIN, 0}, {master, POLLIN, 0}, {3, POLLIN, 0}};
  char buffer[8192], control[256], input[65536]; size_t used = 0, input_size = 0;
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  int status = 0;
  for (;;) {
    fds[0].events = input_size < sizeof(input) ? POLLIN : 0;
    fds[1].events = POLLIN | (input_size ? POLLOUT : 0);
    if (poll(fds, 3, -1) < 0) { if (errno == EINTR) continue; break; }
    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(master, buffer, sizeof(buffer));
      if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
      if (n <= 0 || copy_all(1, buffer, (size_t)n) < 0) break;
    }
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(0, input + input_size, sizeof(input) - input_size);
      if (n <= 0) break;
      input_size += (size_t)n;
    }
    if (fds[1].revents & POLLOUT) {
      ssize_t n = write(master, input, input_size);
      if (n > 0) { input_size -= (size_t)n; memmove(input, input + n, input_size); }
      else if (n < 0 && errno != EAGAIN && errno != EINTR) break;
    }
    if (fds[2].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(3, buffer, sizeof(buffer));
      if (n <= 0) break;
      for (ssize_t i = 0; i < n; i++) {
        if (buffer[i] == '\n') {
          control[used] = 0; used = 0;
          unsigned int cols, rows;
          if (sscanf(control, "resize %u %u", &cols, &rows) == 2) {
            size.ws_col = (unsigned short)cols; size.ws_row = (unsigned short)rows;
            ioctl(master, TIOCSWINSZ, &size);
          } else if (!strcmp(control, "SIGINT")) {
            pid_t fg = tcgetpgrp(master); if (fg > 0) kill(-fg, SIGINT);
          } else if (!strcmp(control, "SIGTERM")) stop_session(SIGTERM);
          else if (!strcmp(control, "SIGHUP")) stop_session(SIGHUP);
          else if (!strcmp(control, "close")) goto done;
        } else if (used < sizeof(control) - 1) control[used++] = buffer[i];
        else goto done;
      }
    }
  }
done:
  stop_session(SIGKILL);
  close(master);
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

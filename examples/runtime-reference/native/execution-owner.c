/* Independent event-driven Darwin reference owner. Kernel fork notifications wake a linked-list tree sampler.
 * A 20ms fallback timer collects resource use for owned descendants. Caller pipe EOF is a termination instruction. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

typedef unsigned long long Counter;
typedef struct Node {
  pid_t number;
  Counter born, time;
  int alive;
  struct Node *next;
} Node;
static Node *head;
static Counter budget[6], peak_memory, peak_count, peak_descriptors, consumed_cpu, written;
static Counter largest_gap, last_sample;
static const char *ending = "completed";
static int queue;
static pid_t root;
static void remember(pid_t number);
static int marker_reader, ownership_checked, rescued;
static Counter marker_writer;
static int marker_eof(void) {
  unsigned char bytes[64];
  ssize_t answer = read(marker_reader, bytes, sizeof bytes);
  if (answer == 0) return 1;
  if (answer < 0 && (errno == EWOULDBLOCK || errno == EAGAIN)) return 0;
  return -1;
}
/* The reference enumerates the current UID's descriptors only during cleanup.
 * Kernel pipe identity, rather than a descriptor number, follows duplicated fds. */
static int find_writers(void) {
  pid_t candidates[32768];
  int bytes = proc_listpids(PROC_UID_ONLY, geteuid(), candidates, sizeof candidates);
  if (bytes < 0 || bytes >= (int)sizeof candidates) return -1;
  int found = 0;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
    if (candidates[i] <= 0 || candidates[i] == getpid()) continue;
    struct proc_fdinfo descriptors[4096];
    int length = proc_pidinfo(candidates[i], PROC_PIDLISTFDS, 0, descriptors, sizeof descriptors);
    if (length <= 0) continue;
    if (length == sizeof descriptors) return -1;
    for (int j = 0; j < length / (int)sizeof *descriptors; j++) {
      if (descriptors[j].proc_fdtype != PROX_FDTYPE_PIPE) continue;
      struct pipe_fdinfo detail;
      if (proc_pidfdinfo(candidates[i], descriptors[j].proc_fd, PROC_PIDFDPIPEINFO, &detail, sizeof detail) == sizeof detail &&
          detail.pipeinfo.pipe_handle == marker_writer) {
        remember(candidates[i]); found++; break;
      }
    }
  }
  return found;
}
static Counter now(void) {
  struct timespec stamp;
  clock_gettime(CLOCK_MONOTONIC, &stamp);
  return stamp.tv_sec * 1000ULL + stamp.tv_nsec / 1000000;
}
static Counter identity(pid_t number) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(number, PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info) return 0;
  return info.pbi_start_tvsec * 1000000ULL + info.pbi_start_tvusec;
}
static void remember(pid_t number) {
  Counter born = identity(number);
  if (!born) return;
  for (Node *n = head; n; n = n->next) if (n->number == number && n->born == born) return;
  Node *item = calloc(1, sizeof *item);
  if (!item) { ending = "unavailable"; return; }
  item->number = number; item->born = born; item->next = head; head = item;
  if (queue > 0) { struct kevent registration;
    EV_SET(&registration, number, EVFILT_PROC, EV_ADD, NOTE_FORK | NOTE_EXIT, 0, NULL);
    if (kevent(queue, &registration, 1, NULL, 0, NULL) && errno != ESRCH) ending = "unavailable";
  }
}
static unsigned measure(void) {
  pid_t ids[32768]; int all = proc_listallpids(ids, sizeof ids);
  if (all < 0 || all == 32768) ending = "unavailable";
  int added;
  do {
    added = 0;
    for (int i = 0; i < all; i++) {
      struct proc_bsdinfo candidate;
      if (proc_pidinfo(ids[i], PROC_PIDTBSDINFO, 0, &candidate, sizeof candidate) != sizeof candidate || candidate.pbi_status == SZOMB) continue;
      int ours = (pid_t)candidate.pbi_pgid == root || ids[i] == root, known = 0;
      for (Node *n = head; n; n = n->next) {
        if (n->number == ids[i] && n->born == identity(ids[i])) known = 1;
        if (n->number == (pid_t)candidate.pbi_ppid && n->born == identity(n->number)) ours = 1;
      }
      if (ours && !known) { remember(ids[i]); added = 1; }
    }
  } while (added);
  Counter memory = 0, count = 0, descriptors = 0;
  consumed_cpu = 0;
  Counter instant = now();
  if (last_sample && instant - last_sample > largest_gap) largest_gap = instant - last_sample;
  last_sample = instant;
  for (Node *n = head; n; n = n->next) {
    n->alive = 0;
    struct proc_bsdinfo info;
    int size = proc_pidinfo(n->number, PROC_PIDTBSDINFO, 0, &info, sizeof info);
    if (size == sizeof info && identity(n->number) == n->born && info.pbi_status != SZOMB) {
      struct proc_taskinfo task;
      struct proc_fdinfo fds[4096];
      int bytes = proc_pidinfo(n->number, PROC_PIDLISTFDS, 0, fds, sizeof fds);
      if (proc_pidinfo(n->number, PROC_PIDTASKINFO, 0, &task, sizeof task) != sizeof task || bytes < 0 || bytes == sizeof fds) ending = "unavailable";
      else {
        n->alive = 1; count++;
        struct rusage_info_v2 times;
        if (proc_pid_rusage(n->number, RUSAGE_INFO_V2, (rusage_info_t *)&times)) ending = "unavailable";
        else { mach_timebase_info_data_t units; mach_timebase_info(&units);
          n->time = (times.ri_system_time + times.ri_user_time) * units.numer / units.denom / 1000000; }
        memory += task.pti_resident_size;
        descriptors += bytes / sizeof *fds;
      }
    }
    consumed_cpu += n->time;
  }
  if (peak_memory < memory) peak_memory = memory;
  if (peak_count < count) peak_count = count;
  if (peak_descriptors < descriptors) peak_descriptors = descriptors;
  if (!strcmp(ending, "completed")) {
    if (consumed_cpu >= budget[0]) ending = "cpuMs";
    else if (memory > budget[2]) ending = "memoryBytes";
    else if (count > budget[4]) ending = "processes";
    else if (descriptors >= budget[5]) ending = "openFiles";
  }
  return (unsigned)count;
}
static void harvest(void) {
  kill(-root, SIGKILL);
  for (Node *n = head; n; n = n->next)
    if (identity(n->number) == n->born) kill(n->number, SIGKILL);
}
static void record(pid_t number, int remaining, int final, int status) {
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  int sig = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  if (dprintf(3, "{\"pid\":%d,\"final\":%s,\"reason\":\"%s\",\"code\":%d,\"signal\":%d,\"cpuMs\":%llu,\"rss\":%llu,\"processes\":%llu,\"files\":%llu,\"outputBytes\":%llu,\"intervalMs\":20,\"maxGapMs\":%llu,\"remaining\":%d,\"ownershipVerified\":%s,\"residualObserved\":%d,\"ownership\":\"cooperative\"}\n",
    number, final ? "true" : "false", ending, code, sig, consumed_cpu,
    peak_memory, peak_count, peak_descriptors, written, largest_gap, remaining, ownership_checked ? "true" : "false", rescued) < 0 && !final) ending = "owner";
}
int main(int size, char **arguments) {
  if (size < 8) return 125;
  for (unsigned i = 0; i != 6; i++) {
    char *tail;
    errno = 0; budget[i] = strtoull(arguments[i + 1], &tail, 10);
    if (errno || *tail || budget[i] == 0 || budget[i] > 9007199254740991ULL) return 125;
  }
  if (budget[5] < 32) return 125;
  struct stat root_metadata;
  int pinned = fstat(7, &root_metadata) == 0 && S_ISDIR(root_metadata.st_mode);
  if (pinned && size < 9) return 125;
  signal(SIGPIPE, SIG_IGN);
  int streams[2][2], start[2], marker[2];
  if (pipe(streams[0]) || pipe(streams[1]) || pipe(start) || pipe(marker)) return 125;
  struct pipe_fdinfo marker_info;
  if (proc_pidfdinfo(getpid(), marker[1], PROC_PIDFDPIPEINFO, &marker_info, sizeof marker_info) != sizeof marker_info) return 125;
  marker_writer = marker_info.pipeinfo.pipe_handle;
  marker_reader = marker[0]; fcntl(marker_reader, F_SETFL, O_NONBLOCK);
  pid_t command = fork();
  if (command < 0) return 125;
  if (command == 0) {
    close(start[1]);
    if (setsid() < 0) _exit(125);
    char token;
    if (read(start[0], &token, 1) != 1) _exit(125);
    struct rlimit allowance;
    allowance.rlim_cur = allowance.rlim_max = (budget[0] + 999) / 1000;
    if (setrlimit(RLIMIT_CPU, &allowance)) _exit(125);
    allowance.rlim_cur = allowance.rlim_max = budget[5];
    if (setrlimit(RLIMIT_NOFILE, &allowance)) _exit(125);
    if (dup2(4, STDIN_FILENO) < 0 || dup2(streams[0][1], STDOUT_FILENO) < 0 || dup2(streams[1][1], STDERR_FILENO) < 0) _exit(125);
    close(3); close(4); close(start[0]);
    for (int i = 0; i < 2; i++) { close(streams[i][0]); close(streams[i][1]); }
    close(marker[0]);
    if (pinned) {
      char actual_root[PATH_MAX], actual_cwd[PATH_MAX];
      if (fcntl(7, F_GETPATH, actual_root) || strcmp(actual_root, arguments[7]) || fchdir(6) || !getcwd(actual_cwd, sizeof actual_cwd)) _exit(125);
      size_t prefix = strlen(actual_root);
      if (strncmp(actual_cwd, actual_root, prefix) || (actual_cwd[prefix] && actual_cwd[prefix] != '/')) _exit(125);
      close(6); close(7);
    }
    if (dup2(marker[1], 3) < 0 || fcntl(3, F_SETFD, 0)) _exit(125);
    if (marker[1] != 3) close(marker[1]);
    execvp(arguments[pinned ? 8 : 7], arguments + (pinned ? 8 : 7));
    _exit(125);
  }
  close(marker[1]);
  close(start[0]);
  root = command;
  remember(command);
  queue = kqueue();
  struct kevent registrations[4];
  EV_SET(&registrations[0], command, EVFILT_PROC, EV_ADD, NOTE_FORK | NOTE_EXIT, 0, NULL);
  EV_SET(&registrations[1], 0, EVFILT_READ, EV_ADD, 0, 0, NULL);
  for (int i = 0; i < 2; i++) {
    close(streams[i][1]);
    fcntl(streams[i][0], F_SETFL, O_NONBLOCK);
    EV_SET(&registrations[i + 2], streams[i][0], EVFILT_READ, EV_ADD, 0, 0, NULL);
  }
  if (queue < 0 || kevent(queue, registrations, 4, NULL, 0, NULL)) ending = "unavailable";
  for (int destination = 1; destination < 4; destination++)
    if (fcntl(destination, F_SETFL, fcntl(destination, F_GETFL) | O_NONBLOCK) < 0) ending = "unavailable";
  if (!strcmp(ending, "completed")) write(start[1], "g", 1);
  close(start[1]); close(4);
  Counter beginning = now(), next_measure = beginning, cleaning = 0;
  int remaining = 1;
  int status = 0, reaped = 0;
  for (;;) {
    struct kevent notices[128];
    struct timespec timeout = { 0, 1000000 };
    int count = kevent(queue, NULL, 0, notices, 128, &timeout);
    if (count < 0 && errno != EINTR) ending = "unavailable";
    for (int i = 0; i < count; i++) {
      struct kevent *notice = notices + i;
      if (notice->flags & EV_ERROR) ending = "unavailable";
      if (notice->filter == EVFILT_PROC && notice->fflags & NOTE_FORK) next_measure = 0;
      if (notice->filter == EVFILT_READ && notice->ident == 0 && !strcmp(ending, "completed")) ending = notice->flags & EV_EOF ? "owner" : "cancel";
    }
    for (int i = 0; i < 2; i++) {
      char block[4096];
      ssize_t available = read(streams[i][0], block, sizeof block);
      if (available > 0) {
        Counter retained = written < budget[3] ? budget[3] - written : 0;
        if (retained > (Counter)available) retained = available;
        written += available;
        if (written > budget[3] && !strcmp(ending, "completed")) ending = "outputBytes";
        if (retained && write(i + 1, block, retained) != (ssize_t)retained) ending = "owner";
      }
    }
    Counter instant = now();
    if (instant >= next_measure) {
      remaining = measure(); next_measure = now() + 20;
      record(command, remaining, 0, status);
    }
    if (instant - beginning >= budget[1] && !strcmp(ending, "completed")) ending = "wallMs";
    if (strcmp(ending, "completed")) harvest();
    if (!reaped && waitpid(command, &status, WNOHANG) == command) {
      reaped = 1; cleaning = now();
      if (WIFEXITED(status) && WEXITSTATUS(status) == 125) ending = "unavailable";
      if (marker_eof() == 0 && !strcmp(ending, "completed")) ending = "residual";
      if (WIFSIGNALED(status) && WTERMSIG(status) == SIGXCPU) ending = "cpuMs";
      harvest();
    }
    if (reaped) {
      int eof = marker_eof();
      if (eof == 0) {
        int writers = find_writers();
        if (writers < 0) { ending = "cleanup"; remaining = -1; break; }
        if (writers > rescued) rescued = writers;
      }
      remaining = measure(); harvest();
      if (eof < 0 || now() - cleaning > 3000) { ending = "cleanup"; remaining = -1; break; }
      if (remaining == 0 && eof == 1) {
        ownership_checked = 1;
        // Drain final output through the same capped loop before the terminal record.
        int pending = 0;
        for (int i = 0; i < 2; i++) {
          char byte;
          ssize_t read_one = read(streams[i][0], &byte, 1);
          if (read_one > 0) {
            pending = 1;
            if (++written <= budget[3]) { if (write(i + 1, &byte, 1) != 1) ending = "owner"; }
            else if (!strcmp(ending, "completed")) ending = "outputBytes";
          }
        }
        if (!pending) break;
      }
    }
    if (instant - beginning > budget[1] + 3000) { ending = "cleanup"; remaining = 1; break; }
  }
  record(command, remaining, 1, status);
  close(queue); close(marker_reader);
  for (int i = 0; i < 2; i++) close(streams[i][0]);
  return ownership_checked && remaining == 0 ? 0 : 125;
}

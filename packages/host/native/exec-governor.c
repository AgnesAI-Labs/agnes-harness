/* Owned POSIX command supervisor. fd 0 is the owner's liveness/cancellation pipe;
 * fd 4 is command stdin; fd 3 carries bounded metrics and the terminal record.
 * No environment or command text is logged. Samples are diagnostics, never
 * hard-limit qualification. Missing mandatory hard gates refuse before fork. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/stat.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach/mach_time.h>
#include <sys/proc.h>
#else
#include <sys/prctl.h>
#include <sys/vfs.h>
#include <sys/stat.h>
#include <linux/magic.h>
#endif

typedef struct { pid_t pid, parent, group; uint64_t start, cpu, rss, files; int live, holder; } Sample;
typedef struct { Sample last; int owned, seen; } Tracked;
static Tracked tracked[32768];
static int used;
static uint64_t limits[6], peak_rss, peak_processes, peak_files, cpu, output, last_sample, max_gap;
static const char *reason = "completed";
static int life_read, verified, residual;
static int refuse(const char *detail) {
  dprintf(3, "{\"refused\":\"%s\"}\n", detail);
  return 125;
}
#ifdef __APPLE__
static uint64_t life_peer;
static int holds_life(pid_t pid, struct proc_fdinfo *fds, int count) {
  for (int i = 0; i < count; i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_PIPE) continue;
    struct pipe_fdinfo info;
    if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDPIPEINFO, &info, sizeof(info)) == sizeof(info) &&
        info.pipeinfo.pipe_handle == life_peer) return 1;
  }
  return 0;
}
#endif
#ifndef __APPLE__
/* fd 5 is a trusted delegated cgroup directory, outside the command namespace.
 * Linux never launches in cooperative fallback mode. The filesystem isolation
 * boundary must deny the command access to cgroup control files. */
static int cgroup_failed;
static int cg_write(const char *name, const char *value) {
  int fd = openat(5, name, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  size_t size = strlen(value); ssize_t count = write(fd, value, size); close(fd);
  return count == (ssize_t)size ? 0 : -1;
}
static int cg_read(const char *name, char *value, size_t capacity) {
  int fd = openat(5, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t n = read(fd, value, capacity - 1); close(fd);
  if (n <= 0 || n >= (ssize_t)capacity - 1) return -1;
  value[n] = 0; return 0;
}
static int cg_matches(const char *name, const char *expected) {
  char actual[128];
  if (cg_read(name, actual, sizeof(actual))) return -1;
  size_t length = strlen(actual);
  if (length && actual[length - 1] == '\n') actual[length - 1] = 0;
  return strcmp(actual, expected) ? -1 : 0;
}
/* A successful write alone is not proof: kernels may reject or normalize values. */
static int cg_limit(const char *name, uint64_t value) {
  char decimal[32]; snprintf(decimal, sizeof(decimal), "%llu", (unsigned long long)value);
  if (cg_write(name, decimal)) return 1;
  return cg_matches(name, decimal) ? 2 : 0;
}
static int cg_members(pid_t *pids, int capacity) {
  int fd = openat(5, "cgroup.procs", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  FILE *stream = fdopen(fd, "r"); if (!stream) { close(fd); return -1; }
  int count = 0, pid;
  while (fscanf(stream, "%d", &pid) == 1) {
    if (count == capacity) { fclose(stream); return -1; }
    pids[count++] = pid;
  }
  int failure = ferror(stream); fclose(stream);
  return failure ? -1 : count;
}
#endif
/* Only EOF proves that the cooperative ownership marker has no remaining writers. */
static int life_state(void) {
  char discarded[128]; ssize_t n = read(life_read, discarded, sizeof(discarded));
  if (n == 0) return 0;
  if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 1;
  return -1;
}
static uint64_t clock_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int inspect(pid_t pid, Sample *s) {
  memset(s, 0, sizeof(*s)); s->pid = pid;
#ifdef __APPLE__
  struct proc_bsdinfo b; struct proc_taskinfo t;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b)) return 0;
  if (b.pbi_status == SZOMB) return 0;
  if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &t, sizeof(t)) != sizeof(t)) return -1;
  struct proc_fdinfo descriptors[4096];
  int f = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors, sizeof(descriptors));
  if (f < 0 || f == sizeof(descriptors)) return -1;
  s->parent = b.pbi_ppid; s->group = b.pbi_pgid;
  s->holder = holds_life(pid, descriptors, f / sizeof(struct proc_fdinfo));
  s->start = b.pbi_start_tvsec * 1000000ULL + b.pbi_start_tvusec;
  struct rusage_info_v2 usage;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage)) return -1;
  mach_timebase_info_data_t scale; mach_timebase_info(&scale);
  s->cpu = (usage.ri_user_time + usage.ri_system_time) * scale.numer / scale.denom / 1000000;
  s->rss = t.pti_resident_size; s->files = f / sizeof(struct proc_fdinfo);
#else
  char name[128], buf[8192]; snprintf(name, sizeof(name), "/proc/%d/stat", pid);
  FILE *f = fopen(name, "r"); if (!f) return errno == ENOENT ? 0 : -1;
  if (!fgets(buf, sizeof(buf), f)) { fclose(f); return -1; } fclose(f);
  char *p = strrchr(buf, ')'); if (!p || p[1] != ' ') return -1;
  char *save, *field = strtok_r(p + 2, " ", &save); unsigned n = 0;
  uint64_t user = 0, system = 0;
  while (field) {
    if (n == 0 && *field == 'Z') return 0;
    if (n == 1) s->parent = atoi(field);
    if (n == 2) s->group = atoi(field);
    if (n == 11) user = strtoull(field, NULL, 10);
    if (n == 12) system = strtoull(field, NULL, 10);
    if (n == 19) s->start = strtoull(field, NULL, 10);
    if (n == 21) s->rss = strtoull(field, NULL, 10) * sysconf(_SC_PAGESIZE);
    n++; field = strtok_r(NULL, " ", &save);
  }
  if (n < 22) return -1;
  s->cpu = (user + system) * 1000 / sysconf(_SC_CLK_TCK);
  snprintf(name, sizeof(name), "/proc/%d/fd", pid);
  DIR *d = opendir(name); if (!d) return errno == ENOENT ? 0 : -1;
  struct dirent *e; while ((e = readdir(d))) if (e->d_name[0] != '.') s->files++;
  closedir(d);
#endif
  s->live = 1; return 1;
}
static int scan(pid_t root, int discover) {
  uint64_t instant = clock_ms();
  if (last_sample && instant-last_sample > max_gap) max_gap = instant-last_sample;
  last_sample = instant;
  pid_t pids[32768]; int count = 0;
#ifdef __APPLE__
  int bytes = proc_listallpids(pids, sizeof(pids));
  if (bytes <= 0 || bytes >= (int)(sizeof(pids) / sizeof(pid_t))) return -1;
  count = bytes;
#else
  count = cg_members(pids, 32768);
  if (count < 0) { cgroup_failed = 1; return -1; }
#endif
  for (int i = 0; i < used; i++) tracked[i].seen = 0;
  Sample values[32768]; int size = 0;
  for (int i = 0; i < count; i++) {
    Sample v; int status = inspect(pids[i], &v);
    if (status == 1) {
#ifndef __APPLE__
      v.holder = 1; /* Membership survives reparenting and descriptor closure. */
#endif
      values[size++] = v;
    }
    /* Other users' inaccessible processes are irrelevant. An owned inaccessible
     * process below remains a cleanup failure rather than proof of termination. */
  }
  int changed;
  do {
    changed = 0;
    for (int n = 0; n < size; n++) {
      Sample *v = &values[n]; int slot = -1, owns = v->pid == root || v->group == root || v->holder;
      for (int i = 0; i < used; i++) {
        if (tracked[i].last.pid == v->pid && tracked[i].last.start == v->start) slot = i;
        if (tracked[i].owned && tracked[i].last.pid == v->parent)
          for (int parent = 0; parent < size; parent++)
            if (values[parent].pid == v->parent && values[parent].start == tracked[i].last.start) owns = 1;
      }
      if (slot < 0 && owns && discover) {
        if (used == 32768) return -1;
        slot = used++; tracked[slot].owned = 1; tracked[slot].last = *v; changed = 1;
      }
      if (slot >= 0) { tracked[slot].last = *v; tracked[slot].seen = 1; }
    }
  } while (changed);
  uint64_t rss = 0, files = 0; int alive = 0; cpu = 0;
  for (int i = 0; i < used; i++) {
    cpu += tracked[i].last.cpu;
    if (tracked[i].seen) { alive++; rss += tracked[i].last.rss; files += tracked[i].last.files; }
    else {
      Sample current;
      if (inspect(tracked[i].last.pid, &current) < 0) return -1;
    }
  }
  if (rss > peak_rss) peak_rss = rss;
  if ((uint64_t)alive > peak_processes) peak_processes = alive;
  if (files > peak_files) peak_files = files;
  /* Observed peaks and gaps provide no upper bound on unobserved resource use. */
  return alive;
}
static void terminate(pid_t root) {
#ifndef __APPLE__
  if (cg_write("cgroup.freeze", "1") || cg_write("cgroup.kill", "1")) cgroup_failed = 1;
#endif
  kill(-root, SIGKILL);
  for (int i = 0; i < used; i++) { Sample v;
    if (inspect(tracked[i].last.pid, &v) == 1 && v.start == tracked[i].last.start) kill(v.pid, SIGKILL);
  }
}
static int emit(pid_t root, int final, int code, int sig, int remaining) {
  return dprintf(3, "{\"pid\":%d,\"final\":%s,\"reason\":\"%s\",\"code\":%d,\"signal\":%d,\"cpuMs\":%llu,\"rss\":%llu,\"processes\":%llu,\"files\":%llu,\"outputBytes\":%llu,\"intervalMs\":10,\"maxGapMs\":%llu,\"remaining\":%d,\"ownershipVerified\":%s,\"residualObserved\":%d,\"ownership\":\"%s\"}\n",
    root, final ? "true" : "false", reason, code, sig,
    (unsigned long long)cpu, (unsigned long long)peak_rss, (unsigned long long)peak_processes,
    (unsigned long long)peak_files, (unsigned long long)output, (unsigned long long)max_gap, remaining, verified ? "true" : "false", residual,
#ifdef __APPLE__
    "cooperative"
#else
    "strong"
#endif
  );
}
int main(int argc, char **argv) {
  const char *fields[] = {"cpuMs", "wallMs", "memoryBytes", "outputBytes", "processes", "openFiles"};
  if (argc < 8) return refuse("exec_resource_bounds");
  for (int i = 0; i < 6; i++) { char *end; errno = 0; limits[i] = strtoull(argv[i+1], &end, 10);
    if (errno || *end || limits[i] > 9007199254740991ULL) return refuse("exec_resource_bounds");
    if (!limits[i]) { char detail[64]; snprintf(detail, sizeof(detail), "exec_zero_%s", fields[i]); return refuse(detail); }
  }
  if (limits[5] < 32) return refuse("exec_limit_openFiles");
#ifdef __APPLE__
  /* Darwin has no qualified tree memory/process gate; no sampled fallback. */
  return refuse("exec_limit_memoryBytes_unsupported");
#endif
  struct stat root_stat; int bound_directory = fstat(7, &root_stat) == 0 && S_ISDIR(root_stat.st_mode);
  if (bound_directory && argc < 9) return 125;
  signal(SIGPIPE, SIG_IGN);
#ifndef __APPLE__
  struct statfs fs; struct stat directory; pid_t empty[1]; char events[128];
  if (fstat(5, &directory) || !S_ISDIR(directory.st_mode) || fstatfs(5, &fs) ||
      fs.f_type != CGROUP2_SUPER_MAGIC || cg_matches("cgroup.type", "domain") ||
      cg_members(empty, 1) != 0 || cg_read("cgroup.events", events, sizeof(events)) ||
      !strstr(events, "populated 0\n")) return refuse("exec_delegation_invalid");
  if (cg_write("cgroup.freeze", "0") || cg_write("cgroup.kill", "1"))
    return refuse("exec_cgroup_setup_failed");
  const char *gates[] = {"memory.max", "memory.swap.max", "pids.max", "memory.oom.group"};
  uint64_t values[] = {limits[2], 0, limits[4], 1};
  for (unsigned i = 0; i < sizeof(gates)/sizeof(gates[0]); i++) {
    int result = cg_limit(gates[i], values[i]);
    if (result) return refuse(result == 1 ? "exec_cgroup_setup_failed" : "exec_cgroup_verification_failed");
  }
  /* These controller gates do not supply a tree CPU-total or aggregate open-file
   * hard limit. Membership/termination does not complete ResourceLimits. */
  return refuse("exec_limit_cpuMs_unsupported");
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) return 125;
#endif
  int out[2], err[2], ready[2], gate[2], life[2];
  if (pipe(out) || pipe(err) || pipe(ready) || pipe(gate) || pipe(life)) return 125;
  life_read = life[0]; fcntl(life_read, F_SETFL, O_NONBLOCK);
#ifdef __APPLE__
  struct pipe_fdinfo marker;
  if (proc_pidfdinfo(getpid(), life_read, PROC_PIDFDPIPEINFO, &marker, sizeof(marker)) != sizeof(marker)) return 125;
  life_peer = marker.pipeinfo.pipe_peerhandle;
#endif
  pid_t root = fork(); if (root < 0) return 125;
  if (!root) {
    close(ready[0]);
    if (bound_directory) {
      char root_path[PATH_MAX], cwd_path[PATH_MAX];
#ifdef __APPLE__
      if (fcntl(7, F_GETPATH, root_path) || fcntl(6, F_GETPATH, cwd_path)) _exit(125);
#else
      ssize_t a = readlink("/proc/self/fd/7", root_path, sizeof(root_path)-1), b = readlink("/proc/self/fd/6", cwd_path, sizeof(cwd_path)-1);
      if (a < 0 || b < 0) _exit(125); root_path[a] = 0; cwd_path[b] = 0;
#endif
      size_t length = strlen(root_path);
      if (strcmp(root_path, argv[7]) || strncmp(root_path, cwd_path, length) ||
          (cwd_path[length] != 0 && cwd_path[length] != '/') || fchdir(6)) _exit(125);
      close(6); close(7);
    }
    struct rlimit r = { (limits[0]+999)/1000, (limits[0]+999)/1000 };
    if (setsid() < 0 || setrlimit(RLIMIT_CPU, &r) != 0) _exit(125);
    r.rlim_cur = r.rlim_max = limits[5];
    if (setrlimit(RLIMIT_NOFILE, &r) != 0) _exit(125);
    if (dup2(4, 0) < 0 || dup2(out[1], 1) < 0 || dup2(err[1], 2) < 0) _exit(125);
    if (write(ready[1], "r", 1) != 1) _exit(125);
    close(gate[1]); char granted;
    if (read(gate[0], &granted, 1) != 1) _exit(125);
    close(gate[0]); close(3); close(4); close(out[0]); close(out[1]); close(err[0]); close(err[1]); close(ready[1]);
    close(life[0]);
#ifndef __APPLE__
    close(5);
#endif
    if (dup2(life[1], 3) < 0 || fcntl(3, F_SETFD, 0) < 0) _exit(125);
    if (life[1] != 3) close(life[1]);
    execvp(argv[bound_directory ? 8 : 7], argv + (bound_directory ? 8 : 7)); _exit(125);
  }
  close(life[1]);
  close(ready[1]); char r; int started = read(ready[0], &r, 1); close(ready[0]);
  close(gate[0]);
  if (started == 1) {
#ifndef __APPLE__
    char member[32]; snprintf(member, sizeof(member), "%d", root);
    if (cg_write("cgroup.procs", member)) { cgroup_failed = 1; started = 0; }
#endif
    if (started == 1) write(gate[1], "g", 1);
  }
  close(gate[1]);
  close(out[1]); close(err[1]); close(4);
  fcntl(0, F_SETFL, O_NONBLOCK); fcntl(out[0], F_SETFL, O_NONBLOCK); fcntl(err[0], F_SETFL, O_NONBLOCK);
  for (int fd = 1; fd <= 3; fd++) if (fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) < 0) reason = "unavailable";
  int status = 0, ended = 0, remaining = -1;
  uint64_t begin = clock_ms(), next = begin, cleanup_begin = 0;
  if (started != 1) reason = "unavailable";
  for (;;) {
    char control; ssize_t read_owner = read(0, &control, 1);
    if (read_owner >= 0 && !strcmp(reason, "completed")) reason = read_owner == 0 ? "owner" : "cancel";
    if (clock_ms() - begin >= limits[1] && !strcmp(reason, "completed")) reason = "wallMs";
    if (clock_ms() >= next) {
      remaining = scan(root, 1); next = clock_ms() + 10;
      if (remaining < 0) reason = "unavailable";
      if (emit(root, 0, -1, 0, remaining) < 0) reason = "owner";
    }
    int pipes[2] = {out[0], err[0]};
    for (int i = 0; i < 2; i++) {
      char buf[8192]; ssize_t n = read(pipes[i], buf, sizeof(buf));
      if (n > 0) {
        uint64_t before = output; output += n;
        if (output > limits[3] && !strcmp(reason, "completed")) reason = "outputBytes";
        size_t keep = before >= limits[3] ? 0 : (uint64_t)n > limits[3]-before ? limits[3]-before : (uint64_t)n;
        if (keep && write(i+1, buf, keep) != (ssize_t)keep) reason = "owner";
      }
    }
    if (strcmp(reason, "completed")) terminate(root);
    if (!ended && waitpid(root, &status, WNOHANG) == root) {
      ended = 1; cleanup_begin = clock_ms();
      if (WIFEXITED(status) && WEXITSTATUS(status) == 125) reason = "unavailable";
      if (WIFSIGNALED(status) && WTERMSIG(status) == SIGXCPU) reason = "cpuMs";
    }
    if (ended) {
      int lifeline = life_state();
#ifndef __APPLE__
      pid_t members[32768]; int count = cg_members(members, 32768);
      lifeline = count < 0 || cgroup_failed ? -1 : count > 0;
#endif
      if (lifeline != 0 && !strcmp(reason, "completed")) reason = "residual";
      remaining = scan(root, 1);
      if (lifeline > 0) residual = remaining > residual ? remaining : residual;
      terminate(root);
      if (remaining == 0 && lifeline == 0) { verified = 1; break; }
      if (remaining < 0 || lifeline < 0 || clock_ms()-cleanup_begin > 3000) {
        reason = "cleanup"; remaining = -1; break;
      }
    }
    if (clock_ms() - begin > limits[1] + 3000) { reason = "cleanup"; break; }
    struct timespec delay = {0, 1000000}; nanosleep(&delay, NULL);
  }
  /* Pipes may still contain the final write even after the root was reaped. */
  for (int i = 0; i < 2; i++) { int fd = i ? err[0] : out[0]; char b[8192]; ssize_t n;
    while ((n = read(fd, b, sizeof(b))) > 0) { uint64_t before = output; output += n;
      if (output > limits[3] && !strcmp(reason, "completed")) reason = "outputBytes";
      size_t keep = before >= limits[3] ? 0 : (uint64_t)n > limits[3]-before ? limits[3]-before : (uint64_t)n;
      if (keep && write(i+1, b, keep) != (ssize_t)keep) reason = "owner";
    } close(fd);
  }
  close(life_read);
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
  emit(root, 1, WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0, remaining);
  return verified && remaining == 0 ? 0 : 125;
}

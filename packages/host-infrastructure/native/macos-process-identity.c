/*
 * Read-only macOS process-instance identity: kern.bootsessionuuid + PID + the saved
 * proc_bsdinfo start timestamp. XNU's proc_starttime reads p_start, which is captured
 * when the process is created; calendar adjustments do not rewrite it. kern.boottime,
 * in contrast, changes with settimeofday and must not identify a boot session.
 *
 * stdout (one ASCII line):
 *   alive <boot-session-uuid> <start_sec>.<start_usec>   exit 0
 *   dead                                               exit 1
 *   unknown <fixed-reason>                              exit 2
 * Missing or malformed boot identity must remain unknown, never a PID-only identity.
 */
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <uuid/uuid.h>

/* Reason tokens are fixed, single words (no spaces/newlines) so the TS side can split on
 * whitespace without worrying about embedded delimiters or needing to escape anything. */
static int report_unknown(const char *reason) {
  printf("unknown %s\n", reason);
  return 2;
}

int main(int argc, char **argv) {
  int legacy = argc == 3 && strcmp(argv[2], "legacy") == 0;
  if (argc != 2 && !legacy) return report_unknown("usage");

  /* Reject anything that is not a plain positive-integer PID before touching any OS API, mirroring
   * the TS-side validation (pid <= 0 or > 2^31-1 is rejected before even spawning this helper).
   * pid_t is a signed 32-bit int on Darwin, so INT32_MAX is the real ceiling. */
  errno = 0;
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed <= 0 || parsed > 2147483647L)
    return report_unknown("bad-pid");
  pid_t pid = (pid_t)parsed;

  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  errno = 0;
  int ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (ret <= 0) {
    /* proc_pidinfo's documented contract: 0/negative return with errno == ESRCH means no such
     * process. Any other failure (e.g. EPERM against a privileged process) must stay unknown —
     * it proves nothing about whether the PID is alive or dead. */
    if (errno == ESRCH) {
      printf("dead\n");
      return 1;
    }
    return report_unknown(errno == EPERM ? "eperm" : "pidinfo-failed");
  }
  if (ret != (int)sizeof(info))
    /* A short read means the kernel returned less than the struct this binary was built against
     * expects (e.g. an SDK/kernel version mismatch); parsing partial memory as real fields would
     * be worse than refusing to answer. */
    return report_unknown("short-read");

  char boot_session[37];
  memset(boot_session, 0, sizeof(boot_session));
  size_t size = sizeof(boot_session);
  uuid_t parsed_boot;
  if (sysctlbyname("kern.bootsessionuuid", boot_session, &size, NULL, 0) != 0 ||
      size != sizeof(boot_session) || boot_session[36] != '\0' ||
      uuid_parse(boot_session, parsed_boot) != 0 || uuid_is_null(parsed_boot))
    return report_unknown("boot-session-unavailable");
  if (info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1000000)
    return report_unknown("invalid-start-time");

  struct timeval boot;
  if (legacy) {
    size_t boot_size = sizeof(boot);
    if (sysctlbyname("kern.boottime", &boot, &boot_size, NULL, 0) != 0 ||
        boot_size != sizeof(boot) || boot.tv_sec <= 0 || boot.tv_usec < 0 || boot.tv_usec >= 1000000)
      return report_unknown("legacy-boot-time-unavailable");
  }
  printf("alive %s %llu.%06llu", boot_session,
      (unsigned long long)info.pbi_start_tvsec,
      (unsigned long long)info.pbi_start_tvusec);
  if (legacy) printf(" %lld.%06d", (long long)boot.tv_sec, boot.tv_usec);
  printf("\n");
  return 0;
}

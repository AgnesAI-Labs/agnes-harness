/* Read-only identity for one live macOS process. Security.framework validates the code object
 * attached to the PID; no filesystem path supplied by the process is trusted. */
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>

static int unknown(const char *reason) {
  printf("unknown %s\n", reason);
  return 2;
}

static int token(CFStringRef value, char *output, size_t size) {
  if (value == NULL || !CFStringGetCString(value, output, size, kCFStringEncodingUTF8)) return 0;
  size_t length = strlen(output);
  if (length == 0 || length + 1 > size) return 0;
  for (size_t index = 0; index < length; index++) {
    unsigned char c = (unsigned char)output[index];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
          c == '.' || c == '-' || c == '_'))
      return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) return unknown("usage");
  errno = 0;
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed <= 0 || parsed > 2147483647L)
    return unknown("bad-pid");
  pid_t pid = (pid_t)parsed;

  struct proc_bsdinfo process;
  memset(&process, 0, sizeof(process));
  errno = 0;
  int read = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, sizeof(process));
  if (read <= 0) {
    if (errno == ESRCH) {
      printf("dead\n");
      return 1;
    }
    return unknown(errno == EPERM ? "eperm" : "pidinfo-failed");
  }
  if (read != (int)sizeof(process)) return unknown("short-read");

  struct timeval boot;
  size_t boot_size = sizeof(boot);
  if (sysctlbyname("kern.boottime", &boot, &boot_size, NULL, 0) != 0 || boot_size != sizeof(boot))
    return unknown("boottime-unavailable");

  int pid_value = (int)pid;
  CFNumberRef pid_number = CFNumberCreate(NULL, kCFNumberIntType, &pid_value);
  if (pid_number == NULL) return unknown("pid-number");
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {pid_number};
  CFDictionaryRef attributes = CFDictionaryCreate(
      NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFRelease(pid_number);
  if (attributes == NULL) return unknown("attributes");

  SecCodeRef code = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  if (status != errSecSuccess || code == NULL) return unknown("guest-code");
  status = SecCodeCheckValidity(code, kSecCSStrictValidate, NULL);
  if (status != errSecSuccess) {
    CFRelease(code);
    return unknown("invalid-signature");
  }
  CFDictionaryRef signing = NULL;
  status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signing);
  CFRelease(code);
  if (status != errSecSuccess || signing == NULL) return unknown("signing-info");

  char identifier[256];
  /* Some Apple platform binaries have no TeamIdentifier. They are still strict-validated live
   * code objects, so preserve that fact as "-" for the host's explicit all-apps policy. A
   * configured allowlist continues to require a real TeamIdentifier and will not match it. */
  char team[65] = "-";
  CFStringRef identifier_value = (CFStringRef)CFDictionaryGetValue(signing, kSecCodeInfoIdentifier);
  CFStringRef team_value = (CFStringRef)CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier);
  CFDataRef unique = (CFDataRef)CFDictionaryGetValue(signing, kSecCodeInfoUnique);
  if (!token(identifier_value, identifier, sizeof(identifier)) ||
      (team_value != NULL && !token(team_value, team, sizeof(team))) ||
      unique == NULL || CFGetTypeID(unique) != CFDataGetTypeID() || CFDataGetLength(unique) <= 0 ||
      CFDataGetLength(unique) > 128) {
    CFRelease(signing);
    return unknown("incomplete-signing-info");
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(CFDataGetBytePtr(unique), (CC_LONG)CFDataGetLength(unique), digest);
  CFRelease(signing);
  char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index++)
    snprintf(hex + index * 2, 3, "%02x", digest[index]);
  hex[CC_SHA256_DIGEST_LENGTH * 2] = '\0';

  /* Bind the signing result to the same process instance observed above. A PID may exit and be
   * reused while Security.framework is resolving the guest code object. */
  struct proc_bsdinfo process_after;
  memset(&process_after, 0, sizeof(process_after));
  errno = 0;
  read = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process_after, sizeof(process_after));
  if (read != (int)sizeof(process_after) ||
      process_after.pbi_start_tvsec != process.pbi_start_tvsec ||
      process_after.pbi_start_tvusec != process.pbi_start_tvusec)
    return unknown(read <= 0 && errno == ESRCH ? "dead" : "identity-changed");

  printf("alive %ld.%06d %llu.%06llu %s %s %s\n", (long)boot.tv_sec, (int)boot.tv_usec,
         (unsigned long long)process.pbi_start_tvsec,
         (unsigned long long)process.pbi_start_tvusec, identifier, team, hex);
  return 0;
}

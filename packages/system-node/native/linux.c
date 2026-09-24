#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/if_alg.h>
#include <limits.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value fail(napi_env env, const char* operation, int error) {
  const char* code = "EIO";
  switch (error) {
    case EACCES: case EPERM: code = "EACCES"; break;
    case EEXIST: code = "EEXIST"; break;
    case EINVAL: code = "EINVAL"; break;
    case EISDIR: code = "EISDIR"; break;
    case ELOOP: code = "ELOOP"; break;
    case EMFILE: case ENFILE: code = "EMFILE"; break;
    case ENOSYS: code = "ENOSYS"; break;
    case EXDEV: code = "EXDEV"; break;
    case ENOTSUP: code = "ENOTSUP"; break;
    case ENOENT: code = "ENOENT"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
  }
  char message[192];
  snprintf(message, sizeof(message), "%s failed", operation);
  napi_value text, name, result;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &name);
  napi_create_error(env, name, text, &result);
  napi_throw(env, result);
  return NULL;
}

static bool string_arg(napi_env env, napi_value value, char* out, size_t capacity) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length >= capacity ||
      napi_get_value_string_utf8(env, value, out, capacity, &length) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Expected a bounded nonempty string");
    return false;
  }
  return true;
}

static bool private_directory(const struct stat* value) {
  return S_ISDIR(value->st_mode) && value->st_uid == getuid() && (value->st_mode & 0077) == 0;
}

static bool private_file(const struct stat* value) {
  return S_ISREG(value->st_mode) && value->st_uid == getuid() && value->st_nlink == 1 &&
         (value->st_mode & 0077) == 0;
}

static bool lowercase_sha256(const char* value) {
  if (strlen(value) != 64) return false;
  for (size_t index = 0; index < 64; index++)
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  return true;
}

/* Walk every component from the filesystem root. O_NOFOLLOW on only the final path would still
 * allow an attacker to replace an intermediate directory with a symlink before open(). */
static int open_absolute_directory(const char* path) {
  size_t length = strlen(path);
  if (length < 2 || path[0] != '/' || path[length - 1] == '/') {
    errno = EINVAL;
    return -1;
  }
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0) return -1;
  const char* cursor = path + 1;
  while (*cursor != '\0') {
    const char* slash = strchr(cursor, '/');
    size_t component_length = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);
    if (component_length == 0 || component_length > NAME_MAX ||
        (component_length == 1 && cursor[0] == '.') ||
        (component_length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      close(directory);
      errno = EINVAL;
      return -1;
    }
    char component[NAME_MAX + 1];
    memcpy(component, cursor, component_length);
    component[component_length] = '\0';
    int next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0) {
      int saved = errno;
      close(directory);
      errno = saved;
      return -1;
    }
    close(directory);
    directory = next;
    if (slash == NULL) break;
    cursor = slash + 1;
  }
  return directory;
}

static napi_value delete_private_artifact(napi_env env, napi_callback_info info) {
  napi_value args[3];
  size_t count = 3;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3) {
    napi_throw_type_error(env, "EINVAL", "Expected root, relative path and digest");
    return NULL;
  }
  char root[4096], relative[80], expected[65];
  if (!string_arg(env, args[0], root, sizeof(root)) ||
      !string_arg(env, args[1], relative, sizeof(relative)) ||
      !string_arg(env, args[2], expected, sizeof(expected))) return NULL;
  if (root[0] != '/' || strlen(relative) != 67 || relative[2] != '/' ||
      !lowercase_sha256(expected) ||
      strncmp(relative, expected, 2) != 0 || strcmp(relative + 3, expected) != 0) {
    napi_throw_type_error(env, "EINVAL", "Invalid content-addressed artifact identity");
    return NULL;
  }

  int root_fd = open_absolute_directory(root);
  if (root_fd < 0) return fail(env, "open artifact root", errno);
  struct stat root_stat;
  int stat_result = fstat(root_fd, &root_stat);
  if (stat_result != 0 || !private_directory(&root_stat)) {
    int saved = stat_result == 0 ? EACCES : errno;
    close(root_fd);
    return fail(env, "validate artifact root", saved);
  }
  char shard[3] = {relative[0], relative[1], '\0'};
  int shard_fd = openat(root_fd, shard, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (shard_fd < 0) {
    int saved = errno;
    close(root_fd);
    return fail(env, "open artifact shard", saved);
  }
  struct stat shard_stat;
  stat_result = fstat(shard_fd, &shard_stat);
  if (stat_result != 0 || !private_directory(&shard_stat)) {
    int saved = stat_result == 0 ? EACCES : errno;
    close(shard_fd); close(root_fd);
    return fail(env, "validate artifact shard", saved);
  }
  const char* basename = relative + 3;
  int file_fd = openat(shard_fd, basename, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (file_fd < 0) {
    int saved = errno;
    close(shard_fd); close(root_fd);
    return fail(env, "open artifact", saved);
  }
  struct stat opened;
  stat_result = fstat(file_fd, &opened);
  if (stat_result != 0 || !private_file(&opened)) {
    int saved = stat_result == 0 ? EACCES : errno;
    close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "validate artifact", saved);
  }

  int hash_fd = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  if (hash_fd < 0) {
    int saved = errno;
    close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "create artifact hash", saved);
  }
  struct sockaddr_alg address = {0};
  address.salg_family = AF_ALG;
  memcpy(address.salg_type, "hash", 5);
  memcpy(address.salg_name, "sha256", 7);
  if (bind(hash_fd, (struct sockaddr*)&address, sizeof(address)) != 0) {
    int saved = errno;
    close(hash_fd); close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "bind artifact hash", saved);
  }
  int operation_fd = accept4(hash_fd, NULL, NULL, SOCK_CLOEXEC);
  if (operation_fd < 0) {
    int saved = errno;
    close(hash_fd); close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "open artifact hash", saved);
  }
  off_t offset = 0;
  /* One sendfile call is one complete AF_ALG hash message. Retrying a short transfer without
   * MSG_MORE would finalize separate messages, so fail closed instead of accepting a wrong digest. */
  ssize_t sent = sendfile(operation_fd, file_fd, &offset, (size_t)opened.st_size);
  if (sent < 0 || sent != opened.st_size) {
    int saved = sent < 0 ? errno : EIO;
    close(operation_fd); close(hash_fd); close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "hash artifact", saved);
  }
  unsigned char bytes[32];
  ssize_t digest_size = read(operation_fd, bytes, sizeof(bytes));
  close(operation_fd);
  close(hash_fd);
  if (digest_size != (ssize_t)sizeof(bytes)) {
    close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "read artifact hash", digest_size < 0 ? errno : EIO);
  }
  char actual[65];
  for (size_t index = 0; index < sizeof(bytes); index++)
    snprintf(actual + index * 2, 3, "%02x", bytes[index]);
  actual[64] = '\0';
  if (strcmp(actual, expected) != 0) {
    close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "verify artifact digest", EINVAL);
  }

  struct stat current;
  stat_result = fstatat(shard_fd, basename, &current, AT_SYMLINK_NOFOLLOW);
  if (stat_result != 0 ||
      !private_file(&current) || current.st_dev != opened.st_dev || current.st_ino != opened.st_ino) {
    int saved = stat_result == 0 ? EACCES : errno;
    close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "revalidate artifact entry", saved);
  }
  if (unlinkat(shard_fd, basename, 0) != 0) {
    int saved = errno;
    close(file_fd); close(shard_fd); close(root_fd);
    return fail(env, "unlink artifact", saved);
  }
  close(file_fd);
  if (fsync(shard_fd) != 0) {
    int saved = errno;
    close(shard_fd); close(root_fd);
    return fail(env, "sync artifact shard", saved);
  }
  close(shard_fd); close(root_fd);
  napi_value result;
  napi_create_bigint_int64(env, (int64_t)opened.st_size, &result);
  return result;
}

#include "rename-directory.h"
#include "skill-delete-posix.h"

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value abi, function;
  napi_create_uint32(env, 1, &abi);
  napi_set_named_property(env, exports, "abiVersion", abi);
  napi_create_function(env, "deleteSkillEntry", NAPI_AUTO_LENGTH, delete_skill_entry, NULL, &function);
  napi_set_named_property(env, exports, "deleteSkillEntry", function);
  napi_create_function(env, "deletePrivateArtifact", NAPI_AUTO_LENGTH,
                       delete_private_artifact, NULL, &function);
  napi_set_named_property(env, exports, "deletePrivateArtifact", function);
  napi_create_function(env, "renameDirectoryNoReplace", NAPI_AUTO_LENGTH,
                       rename_directory_no_replace, NULL, &function);
  napi_set_named_property(env, exports, "renameDirectoryNoReplace", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

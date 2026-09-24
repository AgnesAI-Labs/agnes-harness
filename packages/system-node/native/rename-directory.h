/* Included after the platform's checked N-API argument/error helpers. */
static napi_value rename_directory_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2)
    return fail(env, "rename directory arguments", EINVAL);
  char source[PATH_MAX], target[PATH_MAX];
  if (!string_arg(env, args[0], source, sizeof(source)) ||
      !string_arg(env, args[1], target, sizeof(target))) return NULL;
  size_t source_length = 0, target_length = 0;
  if (napi_get_value_string_utf8(env, args[0], NULL, 0, &source_length) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &target_length) != napi_ok ||
      source[0] != '/' || target[0] != '/' ||
      strlen(source) != source_length || strlen(target) != target_length)
    return fail(env, "rename directory paths", EINVAL);
  struct stat status;
  if (lstat(source, &status) != 0) return fail(env, "inspect source directory", errno);
  if (!private_directory(&status)) return fail(env, "private source directory required", EACCES);
#if defined(__APPLE__)
  int result = renamex_np(source, target, RENAME_EXCL);
#else
  int result = renameat2(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
#endif
  if (result != 0) return fail(env, "rename directory without replacement", errno);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

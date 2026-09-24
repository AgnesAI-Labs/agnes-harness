// Broker-only launch: inherit its standard streams after its parent has assigned the Job.
struct InheritedProcess {
  uv_process_t process{};
  napi_env env;
  napi_ref callback = nullptr;
  napi_ref resource = nullptr;
  napi_async_context context = nullptr;
};

static void releaseInheritedProcess(uv_handle_t* handle) {
  auto* state = static_cast<InheritedProcess*>(handle->data);
  if (state->callback) napi_delete_reference(state->env, state->callback);
  if (state->context) napi_async_destroy(state->env, state->context);
  if (state->resource) napi_delete_reference(state->env, state->resource);
  delete state;
}

static void inheritedProcessExit(uv_process_t* process, int64_t status, int signal) {
  auto* state = static_cast<InheritedProcess*>(process->data);
  uv_close(reinterpret_cast<uv_handle_t*>(process), releaseInheritedProcess);
  napi_handle_scope scope;
  if (napi_open_handle_scope(state->env, &scope) != napi_ok) return;
  napi_value callback, receiver, args[2], result;
  if (napi_get_reference_value(state->env, state->callback, &callback) == napi_ok &&
      napi_get_global(state->env, &receiver) == napi_ok &&
      napi_create_int64(state->env, status, &args[0]) == napi_ok &&
      napi_create_int32(state->env, signal, &args[1]) == napi_ok)
    napi_make_callback(state->env, state->context, receiver, callback, 2, args, &result);
  napi_close_handle_scope(state->env, scope);
}

static bool launchString(napi_env env, napi_value value, std::string& text) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > INT_MAX) {
    napi_throw_type_error(env, "EINVAL", "Expected a process launch string"); return false;
  }
  text.resize(size + 1);
  if (napi_get_value_string_utf8(env, value, text.data(), size + 1, &size) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Cannot read process launch string"); return false;
  }
  text.resize(size);
  if (text.find('\0') != std::string::npos) {
    napi_throw_type_error(env, "EINVAL", "Process launch string contains NUL"); return false;
  }
  return true;
}

static bool launchStrings(napi_env env, napi_value value, std::vector<std::string>& strings,
                          std::vector<char*>& pointers, bool environment) {
  bool array = false;
  uint32_t size = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array ||
      napi_get_array_length(env, value, &size) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Expected a process launch array"); return false;
  }
  strings.resize(size);
  for (uint32_t i = 0; i < size; ++i) {
    napi_value entry;
    if (napi_get_element(env, value, i, &entry) != napi_ok || !launchString(env, entry, strings[i])) return false;
    if (environment && (strings[i].find('=') == 0 || strings[i].find('=') == std::string::npos)) {
      napi_throw_type_error(env, "EINVAL", "Invalid process environment entry"); return false;
    }
  }
  pointers.reserve(strings.size() + 1);
  for (auto& string : strings) pointers.push_back(string.data());
  pointers.push_back(nullptr);
  return true;
}

static napi_value spawnInherited(napi_env env, napi_callback_info info) {
  if (uv_version() != UV_VERSION_HEX) {
    napi_throw_error(env, "E_SYSTEM_NATIVE_UNAVAILABLE", "Rebuild native artifact for this libuv runtime");
    return nullptr;
  }
  napi_value args[5], result;
  size_t count = 5;
  bool verbatim = false;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count < 4 ||
      (count == 5 && napi_get_value_bool(env, args[4], &verbatim) != napi_ok)) {
    napi_throw_type_error(env, "EINVAL", "Invalid inherited process arguments"); return nullptr;
  }
  std::vector<std::string> argv, environment;
  std::vector<char*> argvPointers, envPointers;
  std::string cwd;
  napi_valuetype callbackType;
  if (!launchStrings(env, args[0], argv, argvPointers, false) ||
      !launchString(env, args[1], cwd) ||
      !launchStrings(env, args[2], environment, envPointers, true)) return nullptr;
  if (argv.empty() || argv[0].empty() || cwd.empty() ||
      napi_typeof(env, args[3], &callbackType) != napi_ok || callbackType != napi_function) {
    napi_throw_type_error(env, "EINVAL", "Invalid inherited process options"); return nullptr;
  }
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok) {
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot obtain process event loop"); return nullptr;
  }
  auto state = std::make_unique<InheritedProcess>();
  state->env = env;
  napi_value resource, name;
  if (napi_create_object(env, &resource) != napi_ok ||
      napi_create_string_utf8(env, "AgnesInheritedProcess", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_reference(env, resource, 1, &state->resource) != napi_ok ||
      napi_async_init(env, resource, name, &state->context) != napi_ok ||
      napi_create_reference(env, args[3], 1, &state->callback) != napi_ok) {
    if (state->context) napi_async_destroy(env, state->context);
    if (state->resource) napi_delete_reference(env, state->resource);
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot create process callback"); return nullptr;
  }
  uv_stdio_container_t stdio[3]{};
  for (int i = 0; i < 3; ++i) { stdio[i].flags = UV_INHERIT_FD; stdio[i].data.fd = i; }
  uv_process_options_t options{};
  options.file = argvPointers[0];
  options.args = argvPointers.data();
  options.env = envPointers.data();
  options.cwd = cwd.c_str();
  options.exit_cb = inheritedProcessExit;
  options.stdio_count = 3;
  options.stdio = stdio;
  options.flags = UV_PROCESS_WINDOWS_HIDE | (verbatim ? UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS : 0);
  state->process.data = state.get();
  const int error = uv_spawn(loop, &state->process, &options);
  auto* launched = state.release();
  if (error != 0) {
    uv_close(reinterpret_cast<uv_handle_t*>(&launched->process), releaseInheritedProcess);
    napi_throw_error(env, uv_err_name(error), "Windows process launch failed"); return nullptr;
  }
  napi_create_uint32(env, static_cast<uint32_t>(launched->process.pid), &result);
  return result;
}

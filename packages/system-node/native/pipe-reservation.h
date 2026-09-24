struct NativeAccept;
static void cancelReservationAccepts(NativeAccept* pending);
static napi_value acceptPipeReservation(napi_env env, napi_callback_info info);
// Included by windows.cc after the shared RAII, security, and guarded callback helpers.
struct PipeNameReservation {
  napi_env env;
  std::wstring name;
  DWORD maximum;
  Local security;
  Handle server{INVALID_HANDLE_VALUE};
  Handle client{INVALID_HANDLE_VALUE};
  NativeAccept* pending = nullptr;
  bool closeRequested = false;
  bool registered = false;
  bool orphan = false;
  PipeNameReservation(napi_env e, std::wstring n, DWORD m, Local descriptor)
      : env(e), name(std::move(n)), maximum(m), security(std::move(descriptor)) {}
  void closeHandles() noexcept {
    if (client.value != INVALID_HANDLE_VALUE) { CloseHandle(client.value); client.value = INVALID_HANDLE_VALUE; }
    if (server.value != INVALID_HANDLE_VALUE) { CloseHandle(server.value); server.value = INVALID_HANDLE_VALUE; }
  }
  void close() noexcept {
    closeRequested = true;
    if (pending) cancelReservationAccepts(pending);
    else closeHandles();
  }
};
static const napi_type_tag pipeReservationTag{0x965ea2d445894402ULL, 0x813a7df9447905bfULL};
static napi_value reservationFailure(napi_env env, const char* message) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && !pending)
    napi_throw_error(env, "E_NATIVE_FAILURE", message);
  return nullptr;
}
static void cleanupPipeReservation(void* data) {
  auto* reservation = static_cast<PipeNameReservation*>(data);
  reservation->registered = false;
  reservation->close();
  if (reservation->orphan && !reservation->pending) delete reservation;
}
static bool detachPipeReservation(PipeNameReservation* reservation) {
  if (!reservation->registered) return true;
  if (napi_remove_env_cleanup_hook(reservation->env, cleanupPipeReservation, reservation) != napi_ok) return false;
  reservation->registered = false;
  return true;
}
static void finalizePipeReservation(napi_env, void* data, void*) {
  auto* reservation = static_cast<PipeNameReservation*>(data);
  reservation->close();
  const bool detached = detachPipeReservation(reservation);
  reservation->orphan = true;
  if (detached && !reservation->pending) delete reservation;
  // Otherwise the cleanup hook or pending accept still owns this closed object.
}
static napi_value closePipeReservation(napi_env env, napi_callback_info info) {
  napi_value self; size_t count = 0; bool tagged = false; PipeNameReservation* reservation = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &self, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, self, &pipeReservationTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, reinterpret_cast<void**>(&reservation)) != napi_ok || !reservation) {
    napi_throw_type_error(env, "EINVAL", "Invalid Windows pipe reservation"); return nullptr;
  }
  reservation->close();
  if (!detachPipeReservation(reservation)) return reservationFailure(env, "Cannot unregister pipe cleanup");
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return reservationFailure(env, "Cannot complete pipe close");
  return result;
}
static bool localPipeName(napi_env env, napi_value argument, std::wstring& name) {
  if (!stringArgument(env, argument, name)) return false;
  const std::wstring prefix = L"\\\\.\\pipe\\";
  if (name.size() <= prefix.size() || name.size() > 256 || name.compare(0, prefix.size(), prefix) != 0) {
    napi_throw_type_error(env, "EINVAL", "Expected a local Windows pipe name"); return false;
  }
  for (size_t i = prefix.size(); i < name.size(); ++i) {
    if (name[i] < 32 || name[i] == 127 || name[i] == L'\\' || name[i] == L'/') {
      napi_throw_type_error(env, "EINVAL", "Invalid Windows pipe name"); return false;
    }
  }
  return true;
}
static napi_value reservePipeName(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; std::wstring name; double maximum = 0;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2) {
    napi_throw_type_error(env, "EINVAL", "Expected pipe name and instance count"); return nullptr;
  }
  if (!localPipeName(env, args[0], name)) return nullptr;
  if (napi_get_value_double(env, args[1], &maximum) != napi_ok || !std::isfinite(maximum) ||
      maximum != std::floor(maximum) || maximum < 2 || maximum > 254) {
    napi_throw_type_error(env, "EINVAL", "Expected 2 to 254 total pipe instances"); return nullptr;
  }
  Local descriptor = privateSecurity(env);
  if (!descriptor) return nullptr;
  auto reservation = std::make_unique<PipeNameReservation>(env, std::move(name), static_cast<DWORD>(maximum), std::move(descriptor));
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), reservation->security.get(), FALSE};
  reservation->server.value = CreateNamedPipeW(reservation->name.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      reservation->maximum, 65536, 65536, 0, &attributes);
  if (reservation->server.value == INVALID_HANDLE_VALUE) return failure(env, "Reserve Windows pipe", GetLastError());
  reservation->client.value = CreateFileW(reservation->name.c_str(), GENERIC_READ | GENERIC_WRITE,
      0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
  if (reservation->client.value == INVALID_HANDLE_VALUE) return failure(env, "Connect pipe reservation", GetLastError());
  ULONG serverPid = 0, clientPid = 0;
  if (!GetNamedPipeServerProcessId(reservation->client.value, &serverPid) ||
      !GetNamedPipeClientProcessId(reservation->server.value, &clientPid)) return failure(env, "Identify pipe reservation", GetLastError());
  if (serverPid != GetCurrentProcessId() || clientPid != GetCurrentProcessId())
    return failure(env, "Verify pipe reservation", ERROR_ACCESS_DENIED);
  napi_value result;
  const napi_property_descriptor methods[] = {
    {"accept", nullptr, guarded<acceptPipeReservation>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, guarded<closePipeReservation>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_create_object(env, &result) != napi_ok || napi_type_tag_object(env, result, &pipeReservationTag) != napi_ok ||
      napi_define_properties(env, result, 2, methods) != napi_ok)
    return reservationFailure(env, "Cannot create pipe reservation wrapper");
  if (napi_add_env_cleanup_hook(env, cleanupPipeReservation, reservation.get()) != napi_ok)
    return reservationFailure(env, "Cannot register pipe reservation cleanup");
  reservation->registered = true;
  if (napi_wrap(env, result, reservation.get(), finalizePipeReservation, nullptr, nullptr) != napi_ok) {
    reservation->close();
    if (!detachPipeReservation(reservation.get())) { reservation->orphan = true; reservation.release(); }
    return reservationFailure(env, "Cannot wrap pipe reservation");
  }
  reservation.release();
  return result;
}

// A reservation is the only authority allowed to create subsequent instances.
struct NativeAccept {
  napi_env env;
  PipeNameReservation* reservation = nullptr;
  NativeAccept* next = nullptr;
  Handle pipe{INVALID_HANDLE_VALUE}, event{nullptr};
  OVERLAPPED overlap{};
  uv_async_t notification{};
  PTP_WAIT wait = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  napi_async_context context = nullptr;
  napi_ref self = nullptr, parent = nullptr, fallback = nullptr;
  napi_deferred ready = nullptr, result = nullptr;
  DWORD error = ERROR_SUCCESS;
  bool initialized = false, published = false, connected = false, started = false;
  bool cancelled = false, closing = false, finished = false, finishing = false;
  bool finalized = true, envClosing = false, peerRejected = false;
  explicit NativeAccept(napi_env e) : env(e) {}
};
static const napi_type_tag pipeAcceptTag{0x6934cfa3d8d342f0ULL, 0xa967b51e98d28c00ULL};
static void removeAcceptCleanup(NativeAccept* p) {
  if (p->cleanup) {
    auto hook = p->cleanup; p->cleanup = nullptr;
    pipeBridge(napi_remove_async_cleanup_hook(hook), "Cannot remove accept cleanup");
  }
}
static void closeAcceptedHandle(NativeAccept* p) {
  if (p->pipe.value != INVALID_HANDLE_VALUE) { CloseHandle(p->pipe.value); p->pipe.value = INVALID_HANDLE_VALUE; }
}
static void cancelNativeAccept(NativeAccept* p) {
  if (p->closing || p->cancelled) return;
  p->cancelled = true;
  if (p->started && !p->connected) CancelIoEx(p->pipe.value, &p->overlap);
  // A completed connection can race cancellation without another event notification.
  if (p->initialized) uv_async_send(&p->notification);
}
static void cancelReservationAccepts(NativeAccept* pending) {
  for (auto* p = pending; p; p = p->next) cancelNativeAccept(p);
}
static void unlinkNativeAccept(NativeAccept* p) {
  if (!p->reservation) return;
  auto* reservation = p->reservation;
  auto** cursor = &reservation->pending;
  while (*cursor && *cursor != p) cursor = &(*cursor)->next;
  if (*cursor) *cursor = p->next;
  p->reservation = nullptr;
  if (reservation->closeRequested && !reservation->pending) reservation->closeHandles();
  if (reservation->orphan && !reservation->registered && !reservation->pending) delete reservation;
}
static void finishNativeAccept(NativeAccept* p) {
  p->finishing = true; p->finished = true;
  unlinkNativeAccept(p);
  if (p->envClosing || p->error || p->cancelled || !p->published) closeAcceptedHandle(p);
  if (p->published && !p->envClosing) {
    napi_handle_scope handles; napi_callback_scope callbacks; napi_value self = nullptr, value = nullptr;
    pipeBridge(napi_open_handle_scope(p->env, &handles), "Cannot enter accept handle scope");
    pipeBridge(napi_get_reference_value(p->env, p->self, &self), "Cannot read accept resource");
    pipeBridge(napi_open_callback_scope(p->env, self, p->context, &callbacks), "Cannot enter accept callback scope");
    if (p->error || p->cancelled) {
      napi_value message = nullptr, code = nullptr;
      napi_status made = napi_create_string_utf8(p->env, p->cancelled ? "ECANCELED" : p->peerRejected ? "E_PIPE_PEER_REJECTED" : "E_PIPE_ACCEPT", NAPI_AUTO_LENGTH, &code);
      if (made == napi_ok) made = napi_create_string_utf8(p->env, p->cancelled ? "Windows pipe accept cancelled" : "Windows pipe accept failed", NAPI_AUTO_LENGTH, &message);
      if (made == napi_ok) made = napi_create_error(p->env, code, message, &value);
      if (made == napi_ok) made = napi_create_uint32(p->env, p->error, &code);
      if (made == napi_ok) made = napi_set_named_property(p->env, value, "win32Code", code);
      if (made != napi_ok) {
        bool pending = false;
        pipeBridge(napi_is_exception_pending(p->env, &pending), "Cannot inspect accept exception");
        if (pending) pipeBridge(napi_get_and_clear_last_exception(p->env, &value), "Cannot retrieve accept exception");
        else pipeBridge(napi_get_reference_value(p->env, p->fallback, &value), "Cannot retrieve accept fallback");
      }
      if (p->ready) { auto deferred = p->ready; p->ready = nullptr; pipeBridge(napi_reject_deferred(p->env, deferred, value), "Cannot reject accept readiness"); }
      auto deferred = p->result; p->result = nullptr;
      pipeBridge(napi_reject_deferred(p->env, deferred, value), "Cannot reject accept result");
    } else {
      auto deferred = p->result; p->result = nullptr;
      pipeBridge(napi_resolve_deferred(p->env, deferred, self), "Cannot resolve accept result");
    }
    pipeBridge(napi_close_callback_scope(p->env, callbacks), "Cannot leave accept callback scope");
    pipeBridge(napi_close_handle_scope(p->env, handles), "Cannot leave accept handle scope");
  }
  if (p->context) { pipeBridge(napi_async_destroy(p->env, p->context), "Cannot release accept context"); p->context = nullptr; }
  for (auto* ref : {&p->self, &p->parent, &p->fallback}) {
    if (*ref) { pipeBridge(napi_delete_reference(p->env, *ref), "Cannot release accept reference"); *ref = nullptr; }
  }
  if (p->pipe.value == INVALID_HANDLE_VALUE) removeAcceptCleanup(p);
  p->finishing = false;
  if (p->finalized) delete p;
}
static void releaseAcceptWait(NativeAccept* p) {
  if (p->wait) {
    SetThreadpoolWait(p->wait, nullptr, nullptr);
    WaitForThreadpoolWaitCallbacks(p->wait, TRUE);
    CloseThreadpoolWait(p->wait); p->wait = nullptr;
  }
  if (p->event.value) { CloseHandle(p->event.value); p->event.value = nullptr; }
  p->closing = true;
  if (p->initialized) uv_close(reinterpret_cast<uv_handle_t*>(&p->notification), [](uv_handle_t* h) { finishNativeAccept(static_cast<NativeAccept*>(h->data)); });
  else finishNativeAccept(p);
}
static bool pipePeerGone(DWORD error) {
  return error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA || error == ERROR_PIPE_NOT_CONNECTED;
}
static DWORD checkAcceptedUser(HANDLE pipe, bool& peerRejected) {
  ULONG pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid)) {
    DWORD error = GetLastError(); peerRejected = pipePeerGone(error); return error;
  }
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.value) {
    DWORD error = GetLastError();
    peerRejected = error == ERROR_INVALID_PARAMETER || error == ERROR_ACCESS_DENIED;
    return error;
  }
  HANDLE rawPeer = nullptr, rawCurrent = nullptr;
  if (!OpenProcessToken(process.value, TOKEN_QUERY, &rawPeer)) {
    DWORD error = GetLastError(); peerRejected = error == ERROR_ACCESS_DENIED; return error;
  }
  Handle peer(rawPeer);
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawCurrent)) return GetLastError();
  Handle current(rawCurrent);
  DWORD peerSize = 0, currentSize = 0;
  GetTokenInformation(peer.value, TokenUser, nullptr, 0, &peerSize);
  if (!peerSize) return GetLastError();
  GetTokenInformation(current.value, TokenUser, nullptr, 0, &currentSize);
  if (!currentSize) return GetLastError();
  std::vector<BYTE> peerInfo(peerSize), currentInfo(currentSize);
  if (!GetTokenInformation(peer.value, TokenUser, peerInfo.data(), peerSize, &peerSize) ||
      !GetTokenInformation(current.value, TokenUser, currentInfo.data(), currentSize, &currentSize)) return GetLastError();
  PSID user = reinterpret_cast<TOKEN_USER*>(peerInfo.data())->User.Sid;
  PSID own = reinterpret_cast<TOKEN_USER*>(currentInfo.data())->User.Sid;
  peerRejected = !EqualSid(user, own) && !IsWellKnownSid(user, WinLocalSystemSid);
  return peerRejected ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
}
static void acceptNotified(uv_async_t* notification) {
  auto* p = static_cast<NativeAccept*>(notification->data);
  if (p->closing) return;
  if (p->started && !p->connected) {
    DWORD bytes = 0;
    if (!GetOverlappedResult(p->pipe.value, &p->overlap, &bytes, FALSE)) {
      DWORD error = GetLastError();
      if (error == ERROR_IO_INCOMPLETE) return;
      p->error = error;
      p->peerRejected = pipePeerGone(error);
    } else p->connected = true;
  }
  if (!p->error && !p->cancelled) {
    try { p->error = checkAcceptedUser(p->pipe.value, p->peerRejected); }
    catch (...) { p->error = ERROR_NOT_ENOUGH_MEMORY; }
  }
  releaseAcceptWait(p);
}
static VOID CALLBACK notifyNativeAccept(PTP_CALLBACK_INSTANCE, PVOID data, PTP_WAIT, TP_WAIT_RESULT) {
  // No JS, locks, or Node-thread dependency: joining this callback cannot deadlock Node.
  auto* p = static_cast<NativeAccept*>(data); uv_async_send(&p->notification);
}
static void cleanupNativeAccept(napi_async_cleanup_hook_handle, void* data) {
  auto* p = static_cast<NativeAccept*>(data); p->envClosing = true;
  if (p->finished) { closeAcceptedHandle(p); removeAcceptCleanup(p); }
  else cancelNativeAccept(p);
}
static void finalizeNativeAccept(napi_env, void* data, void*) {
  auto* p = static_cast<NativeAccept*>(data); p->finalized = true;
  if (p->finished) {
    closeAcceptedHandle(p); removeAcceptCleanup(p);
    if (!p->finishing) delete p;
  } else cancelNativeAccept(p);
}
static NativeAccept* nativeAcceptThis(napi_env env, napi_callback_info info) {
  size_t count = 0; napi_value self; bool tagged = false; NativeAccept* p = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &self, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, self, &pipeAcceptTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, reinterpret_cast<void**>(&p)) != napi_ok || !p) {
    pipeError(env, "EINVAL", "Invalid Windows pipe accept"); return nullptr;
  }
  return p;
}
static napi_value cancelPipeAccept(napi_env env, napi_callback_info info) {
  auto* p = nativeAcceptThis(env, info); if (!p) return nullptr;
  cancelNativeAccept(p); napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return reservationFailure(env, "Cannot complete accept cancellation");
  return result;
}
static napi_value openPipeAccept(napi_env env, napi_callback_info info) {
  auto* p = nativeAcceptThis(env, info); if (!p) return nullptr;
  if (!p->finished || p->error || p->cancelled || p->pipe.value == INVALID_HANDLE_VALUE)
    return pipeError(env, "EPIPE", "Pipe connection is unavailable or already claimed");
  napi_value result = adoptNativePipe(env, p->pipe);
  if (p->pipe.value == INVALID_HANDLE_VALUE) removeAcceptCleanup(p);
  return result;
}
static napi_value acceptPipeReservation(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value self, argument; bool tagged = false; PipeNameReservation* reservation = nullptr;
  if (napi_get_cb_info(env, info, &count, &argument, &self, nullptr) != napi_ok || count != 0 ||
      napi_check_object_type_tag(env, self, &pipeReservationTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, reinterpret_cast<void**>(&reservation)) != napi_ok || !reservation)
    return pipeError(env, "EINVAL", "Invalid Windows pipe reservation accept");
  if (reservation->closeRequested) return pipeError(env, "EPIPE", "Pipe reservation is closed");
  auto* p = new NativeAccept(env);
  if (napi_add_async_cleanup_hook(env, cleanupNativeAccept, p, &p->cleanup) != napi_ok) { delete p; return reservationFailure(env, "Cannot register accept cleanup"); }
  napi_value wrapper, label, fallback, promise;
  const napi_property_descriptor methods[] = {
    {"cancel", nullptr, guarded<cancelPipeAccept>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"open", nullptr, guarded<openPipeAccept>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_create_object(env, &wrapper) != napi_ok || napi_create_reference(env, self, 1, &p->parent) != napi_ok ||
      napi_create_string_utf8(env, "Windows pipe accept failed", NAPI_AUTO_LENGTH, &label) != napi_ok ||
      napi_create_error(env, nullptr, label, &fallback) != napi_ok || napi_create_reference(env, fallback, 1, &p->fallback) != napi_ok ||
      napi_async_init(env, wrapper, label, &p->context) != napi_ok ||
      napi_create_promise(env, &p->ready, &promise) != napi_ok || napi_set_named_property(env, wrapper, "ready", promise) != napi_ok ||
      napi_create_promise(env, &p->result, &promise) != napi_ok || napi_set_named_property(env, wrapper, "result", promise) != napi_ok ||
      napi_type_tag_object(env, wrapper, &pipeAcceptTag) != napi_ok || napi_define_properties(env, wrapper, 2, methods) != napi_ok ||
      napi_wrap(env, wrapper, p, finalizeNativeAccept, nullptr, nullptr) != napi_ok) {
    releaseAcceptWait(p); return reservationFailure(env, "Cannot create pipe accept wrapper");
  }
  p->finalized = false;
  if (napi_create_reference(env, wrapper, 1, &p->self) != napi_ok) { releaseAcceptWait(p); return reservationFailure(env, "Cannot retain pipe accept"); }
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok) { releaseAcceptWait(p); return reservationFailure(env, "Cannot get accept event loop"); }
  int status = uv_async_init(loop, &p->notification, acceptNotified);
  if (status < 0) { releaseAcceptWait(p); return pipeError(env, uv_err_name(status), "Cannot initialize accept notification"); }
  p->initialized = true; p->notification.data = p;
  p->reservation = reservation; p->next = reservation->pending; reservation->pending = p;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), reservation->security.get(), FALSE};
  p->pipe.value = CreateNamedPipeW(reservation->name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      reservation->maximum, 65536, 65536, 0, &attributes);
  p->published = true;
  if (p->pipe.value == INVALID_HANDLE_VALUE) { p->error = GetLastError(); releaseAcceptWait(p); return wrapper; }
  p->event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); p->overlap.hEvent = p->event.value;
  if (!p->event.value) { p->error = GetLastError(); releaseAcceptWait(p); return wrapper; }
  p->wait = CreateThreadpoolWait(notifyNativeAccept, p, nullptr);
  if (!p->wait) { p->error = GetLastError(); releaseAcceptWait(p); return wrapper; }
  SetThreadpoolWait(p->wait, p->event.value, nullptr);
  const BOOL connected = ConnectNamedPipe(p->pipe.value, &p->overlap);
  p->connected = connected != FALSE; // cl /W4 flags an assignment nested in a comparison as C4706
  DWORD error = p->connected ? ERROR_SUCCESS : GetLastError();
  if (error == ERROR_PIPE_CONNECTED) p->connected = true;
  p->started = !p->connected && error == ERROR_IO_PENDING;
  if (!p->connected && !p->started) {
    p->error = error; p->peerRejected = pipePeerGone(error);
    if (!p->peerRejected) { releaseAcceptWait(p); return wrapper; }
  }
  napi_value value;
  pipeBridge(napi_get_undefined(env, &value), "Cannot create accept readiness");
  auto deferred = p->ready; p->ready = nullptr;
  pipeBridge(napi_resolve_deferred(env, deferred, value), "Cannot resolve accept readiness");
  if (p->error) releaseAcceptWait(p);
  else if (p->connected) uv_async_send(&p->notification);
  return wrapper;
}

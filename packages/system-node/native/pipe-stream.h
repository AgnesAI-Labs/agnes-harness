// Included after shared system helpers. No raw fd crosses the JavaScript boundary.
struct NativePipe {
  napi_env env;
  uv_pipe_t pipe{};
  uv_async_t readStart{};
  unsigned int pendingCloses = 0;
  bool notificationInitialized = false;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  napi_async_context context = nullptr;
  napi_ref resource = nullptr, fallback = nullptr, closePromise = nullptr;
  napi_deferred reader = nullptr, closer = nullptr;
  bool initialized = false, closing = false, closed = false, finishing = false;
  bool finalized = true, envClosing = false, writing = false;
  explicit NativePipe(napi_env e) : env(e) {}
};
static const napi_type_tag nativePipeTag{0xb2ece2069a804611ULL, 0x8903e5a2b4c033bdULL};
static void pipeBridge(napi_status status, const char* operation) {
  if (status != napi_ok) napi_fatal_error("agnes-system", NAPI_AUTO_LENGTH, operation, NAPI_AUTO_LENGTH);
}
static napi_value pipeError(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message); return nullptr;
}
static void releasePipeReferences(NativePipe* p) {
  if (p->context) { pipeBridge(napi_async_destroy(p->env, p->context), "Cannot release pipe async context"); p->context = nullptr; }
  for (napi_ref* ref : {&p->resource, &p->fallback, &p->closePromise}) {
    if (*ref) { pipeBridge(napi_delete_reference(p->env, *ref), "Cannot release pipe reference"); *ref = nullptr; }
  }
}
static void completePipe(NativePipe* p, napi_deferred deferred, int status, const char* bytes = nullptr, size_t size = 0) {
  if (!deferred || p->envClosing) return;
  napi_handle_scope handles; napi_callback_scope callbacks; napi_value resource = nullptr, value = nullptr;
  pipeBridge(napi_open_handle_scope(p->env, &handles), "Cannot enter pipe handle scope");
  pipeBridge(napi_get_reference_value(p->env, p->resource, &resource), "Cannot read pipe async resource");
  pipeBridge(napi_open_callback_scope(p->env, resource, p->context, &callbacks), "Cannot enter pipe callback scope");
  napi_status made;
  bool reject = status < 0 && status != UV_EOF;
  if (reject) {
    napi_value text = nullptr, code = nullptr;
    made = napi_create_string_utf8(p->env, uv_strerror(status), NAPI_AUTO_LENGTH, &text);
    if (made == napi_ok) made = napi_create_string_utf8(p->env, uv_err_name(status), NAPI_AUTO_LENGTH, &code);
    if (made == napi_ok) made = napi_create_error(p->env, code, text, &value);
  } else if (status == UV_EOF) made = napi_get_null(p->env, &value);
  else if (bytes) made = napi_create_buffer_copy(p->env, size, bytes, nullptr, &value);
  else made = napi_get_undefined(p->env, &value);
  if (made != napi_ok) {
    bool pending = false;
    pipeBridge(napi_is_exception_pending(p->env, &pending), "Cannot inspect pipe result exception");
    if (pending) pipeBridge(napi_get_and_clear_last_exception(p->env, &value), "Cannot retrieve pipe result exception");
    else pipeBridge(napi_get_reference_value(p->env, p->fallback, &value), "Cannot retrieve pipe fallback error");
    reject = true;
  }
  pipeBridge(reject ? napi_reject_deferred(p->env, deferred, value) : napi_resolve_deferred(p->env, deferred, value), "Cannot settle pipe operation");
  pipeBridge(napi_close_callback_scope(p->env, callbacks), "Cannot leave pipe callback scope");
  pipeBridge(napi_close_handle_scope(p->env, handles), "Cannot leave pipe handle scope");
}
static void finishNativePipe(NativePipe* p) {
  p->finishing = true; p->closed = true;
  auto reader = p->reader; p->reader = nullptr; completePipe(p, reader, UV_ECANCELED);
  auto closer = p->closer; p->closer = nullptr; completePipe(p, closer, 0);
  releasePipeReferences(p);
  if (p->cleanup) { auto hook = p->cleanup; p->cleanup = nullptr; pipeBridge(napi_remove_async_cleanup_hook(hook), "Cannot remove pipe cleanup hook"); }
  p->finishing = false;
  if (p->finalized) delete p;
}
static void nativePipeHandleClosed(uv_handle_t* handle) {
  auto* p = static_cast<NativePipe*>(handle->data);
  if (--p->pendingCloses == 0) finishNativePipe(p);
}
static void closeNativePipe(NativePipe* p) {
  if (p->closing) return;
  p->closing = true;
  p->pendingCloses = static_cast<unsigned int>(p->initialized) + static_cast<unsigned int>(p->notificationInitialized);
  if (!p->pendingCloses) { finishNativePipe(p); return; }
  if (p->initialized) {
    uv_read_stop(reinterpret_cast<uv_stream_t*>(&p->pipe));
    uv_close(reinterpret_cast<uv_handle_t*>(&p->pipe), nativePipeHandleClosed);
  }
  if (p->notificationInitialized) uv_close(reinterpret_cast<uv_handle_t*>(&p->readStart), nativePipeHandleClosed);
}
static void cleanupNativePipe(napi_async_cleanup_hook_handle, void* data) {
  auto* p = static_cast<NativePipe*>(data); p->envClosing = true; closeNativePipe(p);
}
static void finalizeNativePipe(napi_env, void* data, void*) {
  auto* p = static_cast<NativePipe*>(data); p->finalized = true;
  if (p->closed) { if (!p->finishing) delete p; }
  else closeNativePipe(p);
}
static NativePipe* nativePipeThis(napi_env env, napi_callback_info info, size_t* argc = nullptr, napi_value* args = nullptr) {
  size_t count = argc ? *argc : 0; napi_value self; bool tagged = false; NativePipe* p = nullptr;
  if (napi_get_cb_info(env, info, &count, args, &self, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, self, &nativePipeTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, reinterpret_cast<void**>(&p)) != napi_ok || !p) {
    pipeError(env, "EINVAL", "Invalid native pipe"); return nullptr;
  }
  if (argc) *argc = count;
  return p;
}
static napi_value nativePipeClose(napi_env env, napi_callback_info info) {
  auto* p = nativePipeThis(env, info); if (!p) return nullptr;
  napi_value promise;
  if (p->closePromise) {
    if (napi_get_reference_value(env, p->closePromise, &promise) != napi_ok) return reservationFailure(env, "Cannot read pipe close promise");
    return promise;
  }
  napi_deferred deferred;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return reservationFailure(env, "Cannot create pipe close promise");
  if (p->closed) {
    napi_value value;
    if (napi_get_undefined(env, &value) != napi_ok || napi_resolve_deferred(env, deferred, value) != napi_ok) return reservationFailure(env, "Cannot complete closed pipe");
    return promise;
  }
  if (napi_create_reference(env, promise, 1, &p->closePromise) != napi_ok) return reservationFailure(env, "Cannot retain pipe close promise");
  p->closer = deferred; closeNativePipe(p); return promise;
}
static void startNativePipeRead(uv_async_t* notification) {
  auto* p = static_cast<NativePipe*>(notification->data);
  if (p->closing || !p->reader) return;
  uv_unref(reinterpret_cast<uv_handle_t*>(notification));
  int status = uv_read_start(reinterpret_cast<uv_stream_t*>(&p->pipe),
    [](uv_handle_t*, size_t, uv_buf_t* buffer) { buffer->base = static_cast<char*>(malloc(65536)); buffer->len = buffer->base ? 65536 : 0; },
    [](uv_stream_t* stream, ssize_t size, const uv_buf_t* buffer) {
      auto* owner = static_cast<NativePipe*>(stream->data);
      if (size != 0) {
        uv_read_stop(stream); auto deferred = owner->reader; owner->reader = nullptr;
        completePipe(owner, deferred, size < 0 ? static_cast<int>(size) : 0, size > 0 ? buffer->base : nullptr, size > 0 ? static_cast<size_t>(size) : 0);
      }
      free(buffer->base);
    });
  if (status < 0) { auto deferred = p->reader; p->reader = nullptr; completePipe(p, deferred, status); }
}
static napi_value nativePipeRead(napi_env env, napi_callback_info info) {
  auto* p = nativePipeThis(env, info); if (!p) return nullptr;
  if (p->closing) return pipeError(env, "EPIPE", "Pipe is closed");
  if (p->reader) return pipeError(env, "EBUSY", "A pipe read is already pending");
  napi_value promise; napi_deferred deferred;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return reservationFailure(env, "Cannot create pipe read promise");
  p->reader = deferred;
  // Promise continuations can run before the current uv read callback returns. Never re-enter
  // uv_read_start there: Windows may still be finishing the previous read request.
  uv_ref(reinterpret_cast<uv_handle_t*>(&p->readStart));
  int status = uv_async_send(&p->readStart);
  if (status < 0) {
    uv_unref(reinterpret_cast<uv_handle_t*>(&p->readStart)); p->reader = nullptr;
    completePipe(p, deferred, status);
  }
  return promise;
}
struct NativePipeWrite { uv_write_t request{}; NativePipe* owner; napi_deferred deferred; std::vector<char> bytes; };
static napi_value nativePipeWrite(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; auto* p = nativePipeThis(env, info, &count, args); if (!p) return nullptr;
  if (p->closing) return pipeError(env, "EPIPE", "Pipe is closed");
  if (p->writing) return pipeError(env, "EBUSY", "A pipe write is already pending");
  bool buffer = false; void* data = nullptr; size_t size = 0;
  if (count != 1 || napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size > 65536)
    return pipeError(env, "EINVAL", "Expected a pipe write of at most 64 KiB");
  auto write = std::make_unique<NativePipeWrite>(); write->owner = p; write->request.data = write.get();
  if (size) write->bytes.assign(static_cast<char*>(data), static_cast<char*>(data) + size);
  napi_value promise;
  if (napi_create_promise(env, &write->deferred, &promise) != napi_ok) return reservationFailure(env, "Cannot create pipe write promise");
  if (!size) { completePipe(p, write->deferred, 0); return promise; }
  uv_buf_t bytes = uv_buf_init(write->bytes.data(), static_cast<unsigned int>(size));
  p->writing = true;
  int status = uv_write(&write->request, reinterpret_cast<uv_stream_t*>(&p->pipe), &bytes, 1,
    [](uv_write_t* request, int result) {
      auto* pending = static_cast<NativePipeWrite*>(request->data); pending->owner->writing = false;
      completePipe(pending->owner, pending->deferred, result); delete pending;
    });
  if (status < 0) { p->writing = false; completePipe(p, write->deferred, status); }
  else write.release();
  return promise;
}
static napi_value adoptNativePipe(napi_env env, Handle& handle) {
  auto* p = new NativePipe(env);
  if (napi_add_async_cleanup_hook(env, cleanupNativePipe, p, &p->cleanup) != napi_ok) { delete p; return reservationFailure(env, "Cannot register native pipe cleanup"); }
  napi_value result, resource, label, fallback, code;
  if (napi_create_object(env, &result) != napi_ok || napi_create_object(env, &resource) != napi_ok ||
      napi_create_reference(env, resource, 1, &p->resource) != napi_ok ||
      napi_create_string_utf8(env, "Windows pipe operation failed", NAPI_AUTO_LENGTH, &label) != napi_ok ||
      napi_create_string_utf8(env, "E_NATIVE_FAILURE", NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_error(env, code, label, &fallback) != napi_ok || napi_create_reference(env, fallback, 1, &p->fallback) != napi_ok ||
      napi_async_init(env, resource, label, &p->context) != napi_ok) {
    closeNativePipe(p); return reservationFailure(env, "Cannot initialize native pipe context");
  }
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok) { closeNativePipe(p); return reservationFailure(env, "Cannot get native pipe event loop"); }
  int status = uv_pipe_init(loop, &p->pipe, 0);
  if (status < 0) { closeNativePipe(p); return pipeError(env, uv_err_name(status), "Cannot initialize native pipe"); }
  p->initialized = true; p->pipe.data = p;
  status = uv_async_init(loop, &p->readStart, startNativePipeRead);
  if (status < 0) { closeNativePipe(p); return pipeError(env, uv_err_name(status), "Cannot initialize pipe read notification"); }
  p->notificationInitialized = true; p->readStart.data = p;
  uv_unref(reinterpret_cast<uv_handle_t*>(&p->readStart));
  const napi_property_descriptor methods[] = {
    {"read", nullptr, guarded<nativePipeRead>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, guarded<nativePipeWrite>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, guarded<nativePipeClose>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_type_tag_object(env, result, &nativePipeTag) != napi_ok || napi_define_properties(env, result, 3, methods) != napi_ok ||
      napi_wrap(env, result, p, finalizeNativePipe, nullptr, nullptr) != napi_ok) {
    closeNativePipe(p); return reservationFailure(env, "Cannot wrap native pipe");
  }
  p->finalized = false;
  int fd = uv_open_osfhandle(handle.value);
  if (fd < 0) { closeNativePipe(p); return failure(env, "Convert pipe handle", ERROR_TOO_MANY_OPEN_FILES); }
  handle.value = INVALID_HANDLE_VALUE;
  status = uv_pipe_open(&p->pipe, fd);
  if (status < 0) {
    uv_fs_t request; uv_fs_close(nullptr, &request, fd, nullptr); uv_fs_req_cleanup(&request);
    closeNativePipe(p); return pipeError(env, uv_err_name(status), "Cannot adopt native pipe");
  }
  return result;
}

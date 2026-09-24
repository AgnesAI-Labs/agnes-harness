// Included by windows.cc after its shared N-API/Win32 helpers.
static const napi_type_tag processJobTag = {0x638ea6b230d142fbULL, 0x9fac21961b045bd3ULL};
struct ProcessJob {
  explicit ProcessJob(HANDLE value) : handle(value) {}
  ~ProcessJob() { if (handle) CloseHandle(handle); if (port) CloseHandle(port); }
  HANDLE handle;
  HANDLE port = nullptr;
  std::vector<std::unique_ptr<Handle>> processes;
  DWORD observed = 0;
  DWORD trackingError = ERROR_SUCCESS;
  bool terminated = false;
};

static ProcessJob* jobReceiver(napi_env env, napi_callback_info info,
                               size_t count, napi_value* args) {
  napi_value receiver; size_t actual = count; bool tagged = false; void* data = nullptr;
  if (napi_get_cb_info(env, info, &actual, args, &receiver, nullptr) != napi_ok ||
      actual != count ||
      napi_check_object_type_tag(env, receiver, &processJobTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    napi_throw_type_error(env, "EINVAL", "Invalid Windows process job receiver or arguments");
    return nullptr;
  }
  return static_cast<ProcessJob*>(data);
}
static bool jobOpen(napi_env env, ProcessJob* job) {
  if (!job) return false;
  if (job->handle) return true;
  napi_throw_error(env, "E_JOB_CLOSED", "Windows process job is closed"); return false;
}
static napi_value jobAssign(napi_env env, napi_callback_info info) {
  napi_value args[2]; auto* job = jobReceiver(env, info, 2, args);
  if (!jobOpen(env, job)) return nullptr;
  if (job->terminated) {
    napi_throw_error(env, "E_JOB_TERMINATED", "Windows process job has been terminated"); return nullptr;
  }
  double pid = 0; size_t length = 0; char expected[21] = {};
  if (napi_get_value_double(env, args[0], &pid) != napi_ok || !std::isfinite(pid) ||
      pid < 1 || pid > 4294967295.0 || pid != std::floor(pid) ||
      pid == GetCurrentProcessId() ||
      napi_get_value_string_utf8(env, args[1], nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 20 ||
      napi_get_value_string_utf8(env, args[1], expected, sizeof(expected), &length) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Expected another process ID and creation time"); return nullptr;
  }
  Handle process(OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE |
                             PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                             FALSE, static_cast<DWORD>(pid)));
  if (!process.value) return failure(env, "OpenProcess for job", GetLastError());
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process.value, &created, &exited, &kernel, &user))
    return failure(env, "GetProcessTimes for job", GetLastError());
  ULARGE_INTEGER time; time.HighPart = created.dwHighDateTime; time.LowPart = created.dwLowDateTime;
  if (std::to_string(time.QuadPart) != std::string(expected, length)) {
    napi_throw_error(env, "E_PROCESS_IDENTITY_MISMATCH", "Windows process identity changed"); return nullptr;
  }
  const DWORD state = WaitForSingleObject(process.value, 0);
  if (state == WAIT_OBJECT_0) {
    napi_throw_error(env, "E_PROCESS_EXITED", "Windows process already exited"); return nullptr;
  }
  if (state != WAIT_TIMEOUT) return failure(env, "WaitForSingleObject for job", GetLastError());
  if (!AssignProcessToJobObject(job->handle, process.value))
    return failure(env, "AssignProcessToJobObject", GetLastError());
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value jobTerminate(napi_env env, napi_callback_info info) {
  auto* job = jobReceiver(env, info, 0, nullptr);
  if (!jobOpen(env, job)) return nullptr;
  if (!TerminateJobObject(job->handle, 1)) return failure(env, "TerminateJobObject", GetLastError());
  job->terminated = true;
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value jobActiveCount(napi_env env, napi_callback_info info) {
  auto* job = jobReceiver(env, info, 0, nullptr);
  if (!jobOpen(env, job)) return nullptr;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
  if (!QueryInformationJobObject(job->handle, JobObjectBasicAccountingInformation,
                                &accounting, sizeof(accounting), nullptr))
    return failure(env, "QueryInformationJobObject", GetLastError());
  napi_value result; napi_create_uint32(env, accounting.ActiveProcesses, &result); return result;
}
static napi_value jobTerminationComplete(napi_env env, napi_callback_info info) {
  auto* job = jobReceiver(env, info, 0, nullptr);
  if (!jobOpen(env, job)) return nullptr;
  for (;;) {
    DWORD message = 0; ULONG_PTR key = 0; OVERLAPPED* value = nullptr;
    if (!GetQueuedCompletionStatus(job->port, &message, &key, &value, 0)) {
      const DWORD cause = GetLastError();
      if (cause != WAIT_TIMEOUT) job->trackingError = cause;
      break;
    }
    if (key != reinterpret_cast<ULONG_PTR>(job)) { job->trackingError = ERROR_INVALID_DATA; break; }
    if (message != JOB_OBJECT_MSG_NEW_PROCESS) continue;
    job->observed++;
    auto process = std::make_unique<Handle>(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      FALSE, static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(value))));
    if (!process->value) {
      const DWORD cause = GetLastError();
      if (cause != ERROR_INVALID_PARAMETER) job->trackingError = cause;
      continue;
    }
    BOOL member = FALSE;
    if (!IsProcessInJob(process->value, job->handle, &member)) {
      job->trackingError = GetLastError(); continue;
    }
    // A recycled PID no longer belongs to this Job; never wait for or signal its replacement.
    if (member) job->processes.push_back(std::move(process));
  }
  for (auto it = job->processes.begin(); it != job->processes.end();) {
    const DWORD state = WaitForSingleObject((*it)->value, 0);
    if (state == WAIT_OBJECT_0) it = job->processes.erase(it);
    else {
      if (state != WAIT_TIMEOUT) job->trackingError = GetLastError();
      ++it;
    }
  }
  if (job->trackingError != ERROR_SUCCESS) return failure(env, "Windows job process tracking", job->trackingError);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
  if (!QueryInformationJobObject(job->handle, JobObjectBasicAccountingInformation,
                                &accounting, sizeof(accounting), nullptr))
    return failure(env, "QueryInformationJobObject for completion", GetLastError());
  const bool complete = job->terminated && accounting.ActiveProcesses == 0 &&
                        job->observed == accounting.TotalProcesses && job->processes.empty();
  napi_value result; napi_get_boolean(env, complete, &result); return result;
}
static napi_value jobClose(napi_env env, napi_callback_info info) {
  auto* job = jobReceiver(env, info, 0, nullptr);
  if (!job) return nullptr;
  if (job->handle) {
    if (!CloseHandle(job->handle)) return failure(env, "CloseHandle for job", GetLastError());
    job->handle = nullptr;
    job->processes.clear();
    if (job->port) { CloseHandle(job->port); job->port = nullptr; }
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static void finalizeJob(napi_env, void* data, void*) { delete static_cast<ProcessJob*>(data); }
static napi_value createProcessJob(napi_env env, napi_callback_info) {
  auto job = std::make_unique<ProcessJob>(CreateJobObjectW(nullptr, nullptr));
  if (!job->handle) return failure(env, "CreateJobObjectW", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job->handle, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return failure(env, "SetInformationJobObject", GetLastError());
  job->port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1);
  if (!job->port) return failure(env, "CreateIoCompletionPort for job", GetLastError());
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = {};
  association.CompletionKey = job.get();
  association.CompletionPort = job->port;
  if (!SetInformationJobObject(job->handle, JobObjectAssociateCompletionPortInformation,
                               &association, sizeof(association)))
    return failure(env, "Associate job completion port", GetLastError());
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &processJobTag) != napi_ok) {
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot create Windows process job object"); return nullptr;
  }
  const napi_property_descriptor methods[] = {
    {"assign", nullptr, guarded<jobAssign>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminate", nullptr, guarded<jobTerminate>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"activeProcessCount", nullptr, guarded<jobActiveCount>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminationComplete", nullptr, guarded<jobTerminationComplete>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, guarded<jobClose>, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok ||
      napi_wrap(env, result, job.get(), finalizeJob, nullptr, nullptr) != napi_ok) {
    napi_throw_error(env, "E_NATIVE_FAILURE", "Cannot initialize Windows process job object"); return nullptr;
  }
  job.release();
  return result;
}

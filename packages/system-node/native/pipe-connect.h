// Local-only connection, authenticated on the same handle before any application byte is written.
static napi_value connectVerifiedPipe(napi_env env, napi_callback_info info) {
  napi_value args[4]; size_t count = 4; std::wstring name; double expectedPid = 0;
  char expectedStart[21]{}; size_t length = 0;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 3)
    return pipeError(env, "EINVAL", "Expected pipe name, process ID and creation time");
  if (!localPipeName(env, args[0], name)) return nullptr;
  if (napi_get_value_double(env, args[1], &expectedPid) != napi_ok || !std::isfinite(expectedPid) ||
      expectedPid < 1 || expectedPid > 4294967295.0 || expectedPid != std::floor(expectedPid) ||
      napi_get_value_string_utf8(env, args[2], nullptr, 0, &length) != napi_ok || length == 0 || length > 20 ||
      napi_get_value_string_utf8(env, args[2], expectedStart, sizeof(expectedStart), &length) != napi_ok)
    return pipeError(env, "EINVAL", "Invalid expected pipe process identity");
  for (size_t i = 0; i < length; ++i)
    if (expectedStart[i] < '0' || expectedStart[i] > '9') return pipeError(env, "EINVAL", "Invalid process creation time");
  Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  if (pipe.value == INVALID_HANDLE_VALUE) return failure(env, "Connect Windows pipe", GetLastError());
  ULONG actualPid = 0;
  if (!GetNamedPipeServerProcessId(pipe.value, &actualPid)) return failure(env, "Identify Windows pipe server", GetLastError());
  if (actualPid != static_cast<DWORD>(expectedPid)) return pipeError(env, "E_PIPE_IDENTITY", "Windows pipe server identity mismatch");
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, actualPid));
  if (!process.value) return failure(env, "Open Windows pipe server process", GetLastError());
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process.value, &created, &exited, &kernel, &user)) return failure(env, "Read pipe server creation time", GetLastError());
  ULARGE_INTEGER stamp; stamp.LowPart = created.dwLowDateTime; stamp.HighPart = created.dwHighDateTime;
  if (std::to_string(stamp.QuadPart) != expectedStart || WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT)
    return pipeError(env, "E_PIPE_IDENTITY", "Windows pipe server identity mismatch");
  HANDLE rawToken = nullptr;
  if (!OpenProcessToken(process.value, TOKEN_QUERY, &rawToken)) return failure(env, "Open pipe server token", GetLastError());
  Handle token(rawToken); DWORD tokenSize = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &tokenSize);
  if (!tokenSize) return failure(env, "Size pipe server token", GetLastError());
  std::vector<BYTE> serverToken(tokenSize), currentToken;
  if (!GetTokenInformation(token.value, TokenUser, serverToken.data(), tokenSize, &tokenSize)) return failure(env, "Read pipe server token", GetLastError());
  if (!userToken(env, currentToken)) return nullptr;
  PSID serverUser = reinterpret_cast<TOKEN_USER*>(serverToken.data())->User.Sid;
  PSID currentUser = reinterpret_cast<TOKEN_USER*>(currentToken.data())->User.Sid;
  if (!EqualSid(serverUser, currentUser) && !IsWellKnownSid(serverUser, WinLocalSystemSid))
    return pipeError(env, "E_PIPE_IDENTITY", "Windows pipe server user mismatch");
  return adoptNativePipe(env, pipe);
}

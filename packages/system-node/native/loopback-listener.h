/* Host-owned socket activation. Children receive only an already-bound loopback listener. */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

static napi_value open_loopback_listener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  bool ipv6 = false;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_bool(env, args[0], &ipv6) != napi_ok)
    return fail(env, "loopback listener arguments", EINVAL);
  int fd = socket(ipv6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return fail(env, "loopback socket", errno);
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) {
    int error = errno; close(fd); return fail(env, "loopback descriptor flags", error);
  }
  struct sockaddr_in v4 = {0};
  struct sockaddr_in6 v6 = {0};
  v4.sin_len = sizeof(v4); v4.sin_family = AF_INET; v4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  v6.sin6_len = sizeof(v6); v6.sin6_family = AF_INET6; v6.sin6_addr = in6addr_loopback;
  if (ipv6) {
    int only = 1;
    if (setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof(only)) < 0) {
      int error = errno; close(fd); return fail(env, "IPv6 loopback socket", error);
    }
  }
  struct sockaddr *address = ipv6 ? (struct sockaddr *)&v6 : (struct sockaddr *)&v4;
  socklen_t size = ipv6 ? sizeof(v6) : sizeof(v4);
  if (bind(fd, address, size) < 0 || listen(fd, 128) < 0 || getsockname(fd, address, &size) < 0) {
    int error = errno; close(fd); return fail(env, "bind loopback listener", error);
  }
  napi_value result, descriptor, port;
  napi_create_object(env, &result);
  napi_create_int32(env, fd, &descriptor);
  napi_create_uint32(env, ntohs(ipv6 ? v6.sin6_port : v4.sin_port), &port);
  napi_set_named_property(env, result, "fd", descriptor);
  napi_set_named_property(env, result, "port", port);
  return result;
}

# Native system libraries

The Linux `@agnes/system-node` helper dynamically links system OpenSSL 3 `libcrypto` (`-lcrypto`).
It uses EVP SHA-256 to validate an already opened private artifact before deleting its revalidated
inode. This avoids requiring the optional AF_ALG kernel socket interface, which container seccomp
may deny. No OpenSSL source or shared library is copied into this repository or local distribution.

- Upstream: [OpenSSL](https://github.com/openssl/openssl).
- License: [Apache-2.0, OpenSSL 3](https://github.com/openssl/openssl/blob/openssl-3.0/LICENSE.txt).
- API: [EVP digest lifecycle](https://docs.openssl.org/3.0/man3/EVP_DigestInit/).
- Build: OpenSSL 3 development headers and linker library (`libssl-dev` on Debian/Ubuntu).
- Runtime: the matching system `libcrypto` shared library, maintained by the distribution. An AGH
  prebuild does not include that library; verify dependencies when relocating a build.

The OS package manager owns the exact library version, patches and installed license notices.
This is a native system dependency, not a new npm dependency or a vendored cryptographic implementation.

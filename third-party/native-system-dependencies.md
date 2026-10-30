# Native system libraries

The Linux `@agnes/system-node` addon statically links a private OpenSSL 3.5.9 `libcrypto`.
It uses EVP SHA-256 to validate an already opened private artifact before deleting its revalidated
inode. This avoids requiring the optional AF_ALG kernel socket interface, which container seccomp
may deny. OpenSSL symbols are hidden from the addon export table (`--exclude-libs,ALL`).

- Upstream: [OpenSSL 3.5.9](https://github.com/openssl/openssl/releases/tag/openssl-3.5.9).
- Source: `https://www.openssl.org/source/openssl-3.5.9.tar.gz`.
- SHA-256: `603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a`.
- License: Apache-2.0; the unmodified [license](openssl-LICENSE.txt) is retained here and copied beside the distributed addon. Root NOTICE records the attribution.
- API: [EVP digest lifecycle](https://docs.openssl.org/3.5/man3/EVP_DigestInit/).
- Build: `tools/native/Dockerfile` compiles with the Debian buster glibc 2.28 sysroot, using the pinned Node headers. Docker is required for Linux source builds; no host compiler fallback is used.
- Runtime: no system OpenSSL installation is required. The maintained application runtime remains the pinned Node version. Debian buster is a build-only compatibility sysroot; its userspace libraries are never bundled.

Every Linux native build checks undefined ELF symbols against GLIBC_2.28. Local and SEA packaging
also scan the complete output, including third-party `.node`, shared libraries and helper executables.
The scanner rejects private or unknown GLIBC version tags and fails if no ELF artifacts were checked.
OpenSSL security updates must update the source version, checksum and notices together and rebuild
the addon; OS OpenSSL updates do not patch this static copy.

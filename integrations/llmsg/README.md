# Local Linux Docker browser validation

`Dockerfile.browser` builds a browser-enabled variant of an existing AGH Linux amd64 runtime image for local Docker validation. It needs a Debian 12 base with the `node` user (UID 1000), bubblewrap, and the bundled AGH runtime under `/opt/agh/runtime`. The build installs the system libraries, fonts, Bash and Zsh, then uses the browser plugin's own installer to download and verify its pinned Chromium as `node`.

From the repository root, set `AGH_BASE_IMAGE` to your local AGH runtime image tag, then build:

```sh
docker build --platform linux/amd64 --build-arg AGH_BASE_IMAGE="$AGH_BASE_IMAGE" \
  --tag agh-cloud:browser-local - < integrations/llmsg/Dockerfile.browser
```

Use the [default seccomp profile](https://docs.docker.com/engine/security/seccomp/) for your Docker Engine version as the input. The generated profile keeps its default-deny policy and permits namespace operations required by Chromium and bubblewrap. Apply it to this test container using the following Docker arguments. Keep the normal AGH runtime environment, port and volume arguments for your setup. Any mounted runtime or workspace directory must already allow access by UID 1000.

```sh
node integrations/llmsg/docker-sandbox-profile.mjs /path/to/docker-default-seccomp.json > agh-browser-seccomp.json
```

```text
--cap-drop=ALL --cap-add=SYS_CHROOT --security-opt=no-new-privileges --security-opt=seccomp=agh-browser-seccomp.json --shm-size=384m
```

Use a dedicated test data volume when moving from a root-run container. Sessions created with the old user's workspace isolation policy may require separate migration. With the test container running, open a new cloud session and check that the terminal starts Bash and the built-in browser can display a page. This recipe applies to local Docker. Validate the target sandbox provider's namespace support and mounted volume ownership before using it there.

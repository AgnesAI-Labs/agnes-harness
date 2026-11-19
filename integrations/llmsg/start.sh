#!/bin/bash
set -euo pipefail

# 用户身份由 LLMSG 创建实例时注入，不能固化在镜像或模板中。
: "${AGH_CLOUD_KEY:?缺少第三方注入的 AGH_CLOUD_KEY}"
: "${AGH_CLOUD_API_BASE_URL:?缺少第三方注入的 AGH_CLOUD_API_BASE_URL}"
: "${LLMSG_TRACK_URL:?缺少第三方注入的 LLMSG_TRACK_URL}"

export AGH_HOME="${AGH_HOME:-/data/agh}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/data}"
export AGNES_PROFILE="${AGNES_PROFILE:-local-dev}"

# 拒绝相对目录及根目录，避免工作区或运行数据落到非预期位置。
for name in AGH_HOME WORKSPACE_DIR; do
  value="${!name}"
  case "$value" in
    /*) ;;
    *) printf '%s must be an absolute directory\n' "$name" >&2; exit 64 ;;
  esac
  case "$value" in
    /|*/../*|*/..|*/./*|*/.|*//*)
      printf '%s contains an invalid directory\n' "$name" >&2
      exit 64
      ;;
  esac
done

umask 077
mkdir -p -- "$AGH_HOME" "$WORKSPACE_DIR"

# 原运行时在 home 中存放 SQLite WAL、daemon 所有者记录和本机锁。
# 本次 CFS 用于工作区普通文件，不能把网络挂载误当作受支持的数据库盘。
runtime_fs="$(stat -f -c %T -- "$AGH_HOME")"
case "$runtime_fs" in
  nfs*|cifs|smb*|9p|virtiofs|fuse*)
    printf 'AGH_HOME requires SQLite-compatible local storage; network filesystem detected\n' >&2
    exit 78
    ;;
esac

# mkdir 的 umask 不会修正镜像或挂载中已经存在的目录；仅收紧运行数据根目录。
# 工作区/CFS 权限由挂载配置管理，不递归修改，也不触碰已有文件内容。
if [ -L "$AGH_HOME" ]; then
  printf 'AGH_HOME must not be a symbolic link\n' >&2
  exit 64
fi
chmod 0700 -- "$AGH_HOME"

# 只在文件缺失时初始化；重启保留已轮换的新 Key，不用旧环境变量修复异常文件。
key_file="$AGH_HOME/cloud-key"
if [ ! -e "$key_file" ] && [ ! -L "$key_file" ]; then
  if ! (set -o noclobber; printf '%s\n' "$AGH_CLOUD_KEY" > "$key_file"); then
    printf 'Cannot initialize private cloud Key file\n' >&2
    exit 78
  fi
fi
if [ -L "$key_file" ] || [ ! -f "$key_file" ] || [ ! -s "$key_file" ]; then
  printf 'cloud-key must be a nonempty regular file, not a symbolic link\n' >&2
  exit 78
fi
chmod 0600 -- "$key_file"
cd -- "$WORKSPACE_DIR"

# 保留集成镜像的有界清理，避免子进程忽略 TERM 后一直等待。
envd_pid=""
harness_pid=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$harness_pid" ]; then
    kill -TERM "$harness_pid" 2>/dev/null || true
  fi
  timeout 20s node /opt/agh/runtime/agnes.mjs daemon stop || true
  if [ -n "$envd_pid" ]; then
    kill -TERM "$envd_pid" 2>/dev/null || true
  fi
  for attempt in {1..50}; do
    alive=0
    for pid in "$harness_pid" "$envd_pid"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    if [ "$alive" = 0 ]; then break; fi
    sleep 0.1
  done
  for pid in "$harness_pid" "$envd_pid"; do
    if [ -n "$pid" ]; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/envd &
envd_pid=$!

node /opt/agh/runtime/agnes.mjs plugins add \
  /opt/agh/plugins/cloud.tgz --yes

node /opt/agh/runtime/agnes.mjs serve &
harness_pid=$!

# 任一主服务退出时，结束本次运行并清理其他进程。
wait -n "$envd_pid" "$harness_pid"

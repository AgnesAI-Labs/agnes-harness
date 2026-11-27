#!/bin/bash
set -euo pipefail

# 用户身份由 LLMSG 创建实例时注入，不能固化在镜像或模板中。
: "${AGH_CLOUD_API_BASE_URL:?缺少第三方注入的 AGH_CLOUD_API_BASE_URL}"
: "${LLMSG_TRACK_URL:?缺少第三方注入的 LLMSG_TRACK_URL}"

export AGH_TELEMETRY_DISABLED="${AGH_TELEMETRY_DISABLED:-1}"
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

export AGH_HOME="${AGH_HOME%/}"
if [ "$(realpath -m -- "$AGH_HOME")" != "$AGH_HOME" ]; then
  printf 'AGH_HOME must not traverse a symbolic link\n' >&2
  exit 64
fi
if [ -L "$AGH_HOME" ]; then
  printf 'AGH_HOME must not be a symbolic link\n' >&2
  exit 64
fi
umask 077

# 原运行时在 home 中存放 SQLite WAL、daemon 所有者记录和本机锁。
# 本次 CFS 用于工作区普通文件，不能把网络挂载误当作受支持的数据库盘。
# 在创建目录或收紧权限前，先在现有目录或最近已存在祖先目录上核对文件系统类型。
fs_probe="$AGH_HOME"
while [ ! -e "$fs_probe" ] && [ "$fs_probe" != "/" ]; do
  fs_probe="$(dirname -- "$fs_probe")"
done
runtime_fs="$(stat -f -c %T -- "$fs_probe")"
case "$runtime_fs" in
  nfs*|cifs|smb*|9p|virtiofs|fuse*)
    printf 'AGH_HOME requires SQLite-compatible local storage; network filesystem detected\n' >&2
    exit 78
    ;;
esac

# Core 在锁内先识别布局并安全收紧已确认可接受的运行目录；未知非空目录及旧布局保持原状拒绝。
node /opt/agh/runtime/agnes.mjs home --llmsg-init

mkdir -p -- "$WORKSPACE_DIR"
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

# 安装成功后才落盘环境 Key。已有文件或平台刚轮换的文件优先。
node /opt/agh/runtime/agnes.mjs home --llmsg-persist-key

node /opt/agh/runtime/agnes.mjs serve &
harness_pid=$!

# 任一主服务退出时，结束本次运行并清理其他进程。
wait -n "$envd_pid" "$harness_pid"

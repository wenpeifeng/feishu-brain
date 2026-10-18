#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
SERVER_ENTRY="$PROJECT_DIR/server/index.js"
RUN_DIR="${FEISHU_BRAIN_RUN_DIR:-$PROJECT_DIR/.run}"
LOG_DIR="${FEISHU_BRAIN_LOG_DIR:-$PROJECT_DIR/logs}"
PID_FILE="$RUN_DIR/feishu-brain.pid"
MODE_FILE="$RUN_DIR/feishu-brain.mode"
DOCKER_LOG_PID_FILE="$RUN_DIR/docker-logs.pid"
DEPENDENCY_STAMP="$RUN_DIR/package-lock.sha256"
LOG_FILE="$LOG_DIR/feishu-brain.log"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
LIFECYCLE_LOCK_DIR="$RUN_DIR/lifecycle.lock"

APP_HOST="127.0.0.1"
APP_PORT="3000"

info() { printf '✓ %s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
fail() { printf '错误：%s\n' "$*" >&2; return 1; }

ensure_runtime_dirs() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
}

release_lifecycle_lock() {
  if [[ "${FEISHU_BRAIN_LOCK_OWNER:-}" == "$$" ]]; then
    rm -rf "$LIFECYCLE_LOCK_DIR"
  fi
}

acquire_lifecycle_lock() {
  [[ "${FEISHU_BRAIN_LOCK_HELD:-}" == '1' ]] && return 0
  ensure_runtime_dirs
  if ! mkdir "$LIFECYCLE_LOCK_DIR" 2>/dev/null; then
    local owner=""
    [[ -f "$LIFECYCLE_LOCK_DIR/pid" ]] && owner="$(tr -d '[:space:]' < "$LIFECYCLE_LOCK_DIR/pid")"
    if [[ -n "$owner" ]] && ! pid_is_alive "$owner"; then
      warn "清理失效的生命周期锁（原 PID ${owner}）"
      rm -rf "$LIFECYCLE_LOCK_DIR"
      mkdir "$LIFECYCLE_LOCK_DIR"
    else
      fail "另一个启停操作正在执行（PID：${owner:-未知}），请稍后重试。"
    fi
  fi
  printf '%s\n' "$$" > "$LIFECYCLE_LOCK_DIR/pid"
  export FEISHU_BRAIN_LOCK_HELD=1
  export FEISHU_BRAIN_LOCK_OWNER="$$"
  trap release_lifecycle_lock EXIT INT TERM
}

is_pid() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

pid_is_alive() {
  local pid="${1:-}"
  is_pid "$pid" && kill -0 "$pid" 2>/dev/null
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

process_workdir() {
  local pid="$1"
  if [[ -e "/proc/$pid/cwd" ]]; then
    (cd "/proc/$pid/cwd" 2>/dev/null && pwd -P) || true
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  fi
}

pid_matches_native_service() {
  local pid="${1:-}" command workdir
  pid_is_alive "$pid" || return 1
  command="$(process_command "$pid")"
  workdir="$(process_workdir "$pid")"
  [[ "$command" == *"$SERVER_ENTRY"* && "$workdir" == "$PROJECT_DIR" ]]
}

pid_matches_docker_log_follower() {
  local pid="${1:-}" command
  pid_is_alive "$pid" || return 1
  command="$(process_command "$pid")"
  [[ "$command" == *"docker"*"compose"*"logs"*"feishu-brain"* ]]
}

read_pid_file() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' < "$PID_FILE"
  fi
}

read_mode() {
  if [[ -f "$MODE_FILE" ]]; then
    tr -d '[:space:]' < "$MODE_FILE"
  fi
}

write_runtime_identity() {
  local pid="$1" mode="$2"
  printf '%s\n' "$pid" > "$PID_FILE"
  printf '%s\n' "$mode" > "$MODE_FILE"
}

remove_runtime_identity() {
  rm -f "$PID_FILE" "$MODE_FILE"
}

port_owner_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null \
      | awk 'NR > 1 { while (match($0, /pid=[0-9]+/)) { print substr($0, RSTART + 4, RLENGTH - 4); $0 = substr($0, RSTART + RLENGTH) } }' \
      | sort -u || true
  fi
}

port_is_listening() {
  local host="$1" port="$2" connect_host
  connect_host="$host"
  [[ "$connect_host" == "0.0.0.0" || "$connect_host" == "::" || "$connect_host" == "[::]" ]] && connect_host="127.0.0.1"
  if command -v node >/dev/null 2>&1; then
    node - "$connect_host" "$port" <<'NODE'
const net = require('net');
const host = process.argv[2];
const port = Number(process.argv[3]);
const socket = net.connect({ host, port });
socket.setTimeout(700);
socket.once('connect', () => { socket.destroy(); process.exit(0); });
socket.once('timeout', () => { socket.destroy(); process.exit(1); });
socket.once('error', () => process.exit(1));
NODE
    return
  fi
  [[ -n "$(port_owner_pids "$port")" ]]
}

health_host() {
  case "$APP_HOST" in
    0.0.0.0|::|'[::]') printf '127.0.0.1' ;;
    *) printf '%s' "$APP_HOST" ;;
  esac
}

health_url() {
  printf 'http://%s:%s/api/health' "$(health_host)" "$APP_PORT"
}

health_check() {
  local url
  url="$(health_url)"
  if command -v node >/dev/null 2>&1; then
    node - "$url" <<'NODE'
const url = process.argv[2];
const client = url.startsWith('https:') ? require('https') : require('http');
const req = client.get(url, { timeout: 1500 }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', chunk => { body += chunk; });
  res.on('end', () => {
    try {
      const data = JSON.parse(body);
      process.exit(res.statusCode === 200 && data.ok === true ? 0 : 1);
    } catch (_err) { process.exit(1); }
  });
});
req.once('timeout', () => { req.destroy(); process.exit(1); });
req.once('error', () => process.exit(1));
NODE
    return
  fi
  command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "$url" >/dev/null
}

wait_for_health() {
  local attempts="${1:-30}" i
  for ((i = 1; i <= attempts; i++)); do
    if health_check; then return 0; fi
    sleep 1
  done
  return 1
}

node_major_version() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

install_node_runtime() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || fail '未找到 Node.js 18+，且没有 Homebrew。请从 https://nodejs.org/ 安装 LTS 版本。'
    if brew list node >/dev/null 2>&1; then brew upgrade node; else brew install node; fi
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    local sudo_cmd=""
    [[ "$(id -u)" -ne 0 ]] && sudo_cmd="sudo"
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    local sudo_cmd=""
    [[ "$(id -u)" -ne 0 ]] && sudo_cmd="sudo"
    $sudo_cmd dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    local sudo_cmd=""
    [[ "$(id -u)" -ne 0 ]] && sudo_cmd="sudo"
    $sudo_cmd yum install -y nodejs npm
  else
    fail '无法自动安装 Node.js。请安装 Node.js 18+ 和 npm：https://nodejs.org/'
  fi
}

ensure_node_runtime() {
  local major=0
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    major="$(node_major_version)"
  fi
  if [[ ! "$major" =~ ^[0-9]+$ || "$major" -lt 18 ]]; then
    warn 'Node.js/npm 缺失或 Node.js 版本低于 18，尝试自动安装。'
    install_node_runtime
    major="$(node_major_version)"
  fi
  command -v npm >/dev/null 2>&1 || fail 'Node.js 已存在，但 npm 不可用；请重新安装 Node.js 18+。'
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 18 ]] \
    || fail "自动安装后 Node.js 仍低于 18（当前主版本：${major}）。请安装 Node.js 18+：https://nodejs.org/"
  info "Node.js $(node -v)，npm $(npm -v)"
}

resolve_native_config() {
  local resolved
  resolved="$(cd "$PROJECT_DIR" && node <<'NODE'
require('./server/env');
const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT || '3000';
process.stdout.write(`${host}\n${port}`);
NODE
)"
  APP_HOST="$(printf '%s\n' "$resolved" | sed -n '1p')"
  APP_PORT="$(printf '%s\n' "$resolved" | sed -n '2p')"
  [[ "$APP_PORT" =~ ^[0-9]+$ && "$APP_PORT" -ge 1 && "$APP_PORT" -le 65535 ]] \
    || fail "PORT 必须是 1-65535 的整数，当前值：$APP_PORT"
}

resolve_docker_config() {
  local resolved
  resolved="$(cd "$PROJECT_DIR" && node <<'NODE'
require('./server/env');
process.stdout.write(process.env.FEISHU_BRAIN_HOST_PORT || '3000');
NODE
)"
  APP_HOST="127.0.0.1"
  APP_PORT="$resolved"
  [[ "$APP_PORT" =~ ^[0-9]+$ && "$APP_PORT" -ge 1 && "$APP_PORT" -le 65535 ]] \
    || fail "FEISHU_BRAIN_HOST_PORT 必须是 1-65535 的整数，当前值：$APP_PORT"
}

lock_hash() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$PROJECT_DIR/package-lock.json" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$PROJECT_DIR/package-lock.json" | awk '{print $1}'
  else
    node - "$PROJECT_DIR/package-lock.json" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex'));
NODE
  fi
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    fail 'Docker Compose 不可用。请安装 Docker Desktop，或在 Linux 安装 docker-compose-plugin。'
  fi
}

docker_engine_running() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

compose_container_id() {
  docker_compose ps -q feishu-brain 2>/dev/null | head -n 1 || true
}

spawn_docker_log_follower() {
  local command="$1"
  shift
  node - "$LOG_FILE" "$PROJECT_DIR" "$command" "$@" <<'NODE'
const fs = require('fs');
const { spawn } = require('child_process');
const logFile = process.argv[2];
const cwd = process.argv[3];
const command = process.argv[4];
const args = process.argv.slice(5);
const logFd = fs.openSync(logFile, 'a');
const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', logFd, logFd] });
child.unref();
fs.closeSync(logFd);
process.stdout.write(String(child.pid));
NODE
}

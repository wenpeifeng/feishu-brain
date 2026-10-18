#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

MODE="native"

usage() {
  cat <<'EOF'
用法：script/sh/start-all.sh [--native|--docker]

默认使用本机 Node.js 启动。--docker 使用 Docker Compose；Docker 不是默认依赖。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --native) MODE="native" ;;
    --docker) MODE="docker" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数：$1"; usage; exit 1 ;;
  esac
  shift
done

restore_configuration() {
  if [[ -f "$PROJECT_DIR/.env" ]]; then
    chmod 600 "$PROJECT_DIR/.env"
    info '复用现有 .env'
    return
  fi

  if [[ -f "$PROJECT_DIR/.env.example" ]]; then
    install -m 600 "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    fail '已生成 .env，请填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET 后重新启动。'
  fi
  fail '缺少 .env 和 .env.example，无法启动。'
}

validate_required_config() {
  if ! (cd "$PROJECT_DIR" && node <<'NODE'
require('./server/env');
process.exit(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET ? 0 : 1);
NODE
  ); then
    fail '.env 中缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET；飞书 OAuth 登录无法工作。'
  fi
  info '飞书 OAuth 必要配置已就绪'
}

install_dependencies_if_needed() {
  local current_hash saved_hash="" dependencies_ok='false'
  current_hash="$(lock_hash)"
  [[ -f "$DEPENDENCY_STAMP" ]] && saved_hash="$(tr -d '[:space:]' < "$DEPENDENCY_STAMP")"
  if [[ -d "$PROJECT_DIR/node_modules" && -f "$PROJECT_DIR/node_modules/pdfjs-dist/package.json" ]]; then
    if (cd "$PROJECT_DIR" && npm ls --omit=dev --depth=0 >/dev/null 2>&1); then dependencies_ok='true'; fi
  fi
  if [[ "$dependencies_ok" != 'true' || "$saved_hash" != "$current_hash" ]]; then
    info '依赖缺失或 package-lock.json 已变化，执行 npm ci'
    (cd "$PROJECT_DIR" && npm ci)
    printf '%s\n' "$current_hash" > "$DEPENDENCY_STAMP"
  else
    info '依赖完整且锁文件未变化，跳过安装'
  fi
}

stop_managed_instance() {
  local mode pid
  mode="$(read_mode)"
  pid="$(read_pid_file)"
  if [[ -z "$mode" && -z "$pid" ]]; then return 0; fi
  info '发现本项目脚本管理的旧实例，先停止后再启动当前代码'
  "$SCRIPT_DIR/stop-all.sh"
}

assert_port_available() {
  local owners
  if ! port_is_listening "$APP_HOST" "$APP_PORT"; then return 0; fi
  owners="$(port_owner_pids "$APP_PORT" | paste -sd, -)"
  [[ -n "$owners" ]] || owners='无法识别'
  fail "端口 ${APP_PORT} 已被非本项目受管实例占用（PID：${owners}）。为避免误杀，未启动服务。请先自行确认并释放端口。"
}

install_docker() {
  local os sudo_cmd=""
  os="$(uname -s)"
  if [[ "$os" == 'Darwin' ]]; then
    command -v brew >/dev/null 2>&1 || fail 'Docker 未安装且没有 Homebrew。请安装 Docker Desktop：https://www.docker.com/products/docker-desktop/'
    brew install --cask docker
    return
  fi
  [[ "$(id -u)" -ne 0 ]] && sudo_cmd="sudo"
  if command -v apt-get >/dev/null 2>&1; then
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y docker.io docker-compose-v2 || $sudo_cmd apt-get install -y docker.io docker-compose
  elif command -v dnf >/dev/null 2>&1; then
    $sudo_cmd dnf install -y docker docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    $sudo_cmd yum install -y docker docker-compose-plugin
  else
    fail '无法自动安装 Docker。请按官方文档安装：https://docs.docker.com/engine/install/'
  fi
}

ensure_docker_running() {
  if ! command -v docker >/dev/null 2>&1; then
    warn 'Docker 未安装，尝试自动安装。'
    install_docker
  fi
  if ! docker_engine_running; then
    if [[ "$(uname -s)" == 'Darwin' ]]; then
      open -a Docker || fail '无法启动 Docker Desktop，请手动打开后重试。'
    elif command -v systemctl >/dev/null 2>&1; then
      local sudo_cmd=""
      [[ "$(id -u)" -ne 0 ]] && sudo_cmd="sudo"
      $sudo_cmd systemctl start docker
    else
      fail 'Docker 已安装但未运行，请启动 Docker daemon 后重试。'
    fi
    info '等待 Docker daemon 就绪'
    local i
    for ((i = 1; i <= 60; i++)); do
      docker_engine_running && break
      sleep 1
    done
  fi
  docker_engine_running || fail 'Docker daemon 在 60 秒内未就绪，请手动启动后重试。'
  docker_compose version >/dev/null
  info 'Docker 与 Docker Compose 已就绪'
}

start_native() {
  printf '\n[%s] starting native service\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
  local pid
  pid="$(node - "$SERVER_ENTRY" "$LOG_FILE" "$PROJECT_DIR" <<'NODE'
const fs = require('fs');
const { spawn } = require('child_process');
const entry = process.argv[2];
const logFile = process.argv[3];
const cwd = process.argv[4];
const logFd = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, [entry], {
  cwd,
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
fs.closeSync(logFd);
process.stdout.write(String(child.pid));
NODE
)"
  is_pid "$pid" || fail '未能取得新服务 PID。'
  write_runtime_identity "$pid" native
  if ! wait_for_health 30; then
    warn "服务未通过健康检查，查看日志：$LOG_FILE"
    "$SCRIPT_DIR/stop-all.sh" || warn '健康检查失败后的清理未完成，请运行状态命令排查。'
    return 1
  fi
  info "服务已启动（PID ${pid}）"
}

start_docker() {
  (cd "$PROJECT_DIR" && docker_compose up -d --build --force-recreate feishu-brain)
  local container_id
  container_id="$(compose_container_id)"
  [[ -n "$container_id" ]] || fail 'Docker Compose 未返回容器 ID。'
  write_runtime_identity "$container_id" docker
  local log_pid
  if docker compose version >/dev/null 2>&1; then
    log_pid="$(spawn_docker_log_follower docker compose -f "$COMPOSE_FILE" logs --no-color --follow feishu-brain)"
  else
    log_pid="$(spawn_docker_log_follower docker-compose -f "$COMPOSE_FILE" logs --no-color --follow feishu-brain)"
  fi
  printf '%s\n' "$log_pid" > "$DOCKER_LOG_PID_FILE"
  if ! wait_for_health 60; then
    warn "容器未通过健康检查，查看日志：$LOG_FILE"
    "$SCRIPT_DIR/stop-all.sh" || warn '健康检查失败后的容器清理未完成，请运行状态命令排查。'
    return 1
  fi
  info "Docker 服务已启动（容器 ${container_id:0:12}）"
}

main() {
  [[ -f "$PROJECT_DIR/package.json" && -f "$SERVER_ENTRY" ]] || fail "项目目录不完整：$PROJECT_DIR"
  acquire_lifecycle_lock
  cd "$PROJECT_DIR"
  ensure_node_runtime
  restore_configuration
  validate_required_config
  if [[ "$MODE" == 'native' ]]; then
    resolve_native_config
    install_dependencies_if_needed
  else
    resolve_docker_config
    ensure_docker_running
  fi
  stop_managed_instance
  assert_port_available
  if [[ "$MODE" == 'native' ]]; then start_native; else start_docker; fi

  printf '\n访问地址：http://%s:%s/\n' "$(health_host)" "$APP_PORT"
  printf '健康检查：%s\n' "$(health_url)"
  printf '日志文件：%s\n' "$LOG_FILE"
  printf '状态检查：%s/status-all.sh\n' "$SCRIPT_DIR"
  printf '停止服务：%s/stop-all.sh\n' "$SCRIPT_DIR"
}

main

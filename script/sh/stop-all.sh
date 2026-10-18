#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

stop_native() {
  local pid="$1" i
  if [[ -z "$pid" ]]; then
    info '没有记录本项目服务 PID，视为已停止'
    remove_runtime_identity
    return 0
  fi
  if ! pid_is_alive "$pid"; then
    warn "PID 文件已失效（${pid}），已清理；没有终止任何进程。"
    remove_runtime_identity
    return 0
  fi
  if ! pid_matches_native_service "$pid"; then
    fail "PID $pid 不属于当前项目，拒绝终止。请运行 $SCRIPT_DIR/status-all.sh 排查。"
  fi

  kill -TERM "$pid"
  for ((i = 1; i <= 10; i++)); do
    if ! pid_is_alive "$pid"; then break; fi
    sleep 1
  done
  if pid_is_alive "$pid"; then
    pid_matches_native_service "$pid" || fail "等待期间 PID $pid 已被其他进程复用，拒绝强制终止。"
    warn "PID $pid 未在 10 秒内退出，执行强制停止。"
    kill -KILL "$pid"
  fi
  remove_runtime_identity
  info "已停止本项目服务（PID ${pid}）"
}

stop_docker_log_follower() {
  local pid=""
  [[ -f "$DOCKER_LOG_PID_FILE" ]] && pid="$(tr -d '[:space:]' < "$DOCKER_LOG_PID_FILE")"
  if [[ -n "$pid" ]] && pid_matches_docker_log_follower "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
  elif [[ -n "$pid" ]] && pid_is_alive "$pid"; then
    warn "日志跟随 PID $pid 不属于本项目，未终止。"
  fi
  rm -f "$DOCKER_LOG_PID_FILE"
}

stop_docker() {
  if docker_engine_running; then
    (cd "$PROJECT_DIR" && docker_compose stop feishu-brain)
    info '已停止本项目 Docker 容器；data/ 与 Docker Volume 均保留'
  else
    warn 'Docker daemon 未运行，无法确认容器已停止；保留运行标识，daemon 恢复后请再次执行停止命令。'
    return 1
  fi
  stop_docker_log_follower
  remove_runtime_identity
}

main() {
  acquire_lifecycle_lock
  local mode pid
  mode="$(read_mode)"
  pid="$(read_pid_file)"
  case "$mode" in
    native) stop_native "$pid" ;;
    docker) stop_docker ;;
    '')
      if [[ -z "$pid" ]]; then
        info '当前没有由本项目脚本管理的运行实例'
      elif pid_matches_native_service "$pid"; then
        stop_native "$pid"
      elif pid_is_alive "$pid"; then
        fail "存在无模式标记且归属不明的 PID ${pid}，拒绝终止。"
      else
        warn "清理失效 PID 文件：$pid"
        remove_runtime_identity
      fi
      ;;
    *) fail "未知运行模式：${mode}；拒绝执行停止操作。" ;;
  esac
}

main

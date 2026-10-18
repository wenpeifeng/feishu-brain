#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

status_code=1

print_docker_status() {
  printf '\nDocker：'
  if ! command -v docker >/dev/null 2>&1; then
    printf '未安装（本机 Node 模式不需要 Docker）\n'
    return
  fi
  if ! docker_engine_running; then
    printf '已安装，但 daemon 未运行\n'
    return
  fi
  printf 'daemon 正常\n'
  local container_id state health
  container_id="$(compose_container_id)"
  if [[ -z "$container_id" ]]; then
    printf '容器 feishu-brain：不存在\n'
    return
  fi
  state="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || printf 'unknown')"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}未配置{{end}}' "$container_id" 2>/dev/null || printf 'unknown')"
  printf '容器 feishu-brain：%s（ID %s，health=%s）\n' "$state" "${container_id:0:12}" "$health"
}

print_optional_infrastructure() {
  local enabled='false' url='http://127.0.0.1:18000'
  if command -v node >/dev/null 2>&1 && [[ -f "$PROJECT_DIR/.env" ]]; then
    local values
    values="$(cd "$PROJECT_DIR" && node <<'NODE'
require('./server/env');
process.stdout.write(`${process.env.MINERU_ENABLED || 'false'}\n${process.env.MINERU_API_URL || 'http://127.0.0.1:18000'}`);
NODE
)"
    enabled="$(printf '%s\n' "$values" | sed -n '1p')"
    url="$(printf '%s\n' "$values" | sed -n '2p')"
  fi
  printf '\n可选基础设施：\n'
  case "$enabled" in
    true|1|yes|on) ;;
    *) printf '  MinerU：未启用\n'; return ;;
  esac
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "${url%/}/health" >/dev/null 2>&1; then
    printf '  MinerU：健康（%s）\n' "$url"
  else
    printf '  MinerU：已启用但健康检查失败（%s）；PDF 会尝试降级解析\n' "$url"
  fi
}

main() {
  ensure_runtime_dirs
  local mode pid owners
  mode="$(read_mode)"
  pid="$(read_pid_file)"

  if command -v node >/dev/null 2>&1 && [[ -f "$PROJECT_DIR/.env" ]]; then
    if [[ "$mode" == 'docker' ]]; then resolve_docker_config; else resolve_native_config; fi
  fi

  printf '飞书大脑状态\n'
  printf '项目目录：%s\n' "$PROJECT_DIR"
  printf '运行模式：%s\n' "${mode:-未记录}"
  printf '监听地址：%s:%s\n' "$APP_HOST" "$APP_PORT"
  printf 'PID/容器：%s\n' "${pid:-未记录}"

  if [[ "$mode" == 'native' ]]; then
    if [[ -z "$pid" ]]; then
      printf '应用服务：异常——native 模式缺少 PID\n'
    elif ! pid_is_alive "$pid"; then
      printf '应用服务：异常——PID 文件失效\n'
    elif ! pid_matches_native_service "$pid"; then
      printf '应用服务：异常——PID 属于其他进程，绝不会自动终止\n'
    else
      owners="$(port_owner_pids "$APP_PORT")"
      if [[ -n "$owners" ]] && ! grep -qx "$pid" <<< "$owners"; then
        printf '应用服务：异常——受管 PID 未监听目标端口，端口实际由 PID %s 占用\n' "$(printf '%s\n' "$owners" | paste -sd, -)"
      elif health_check; then
        printf '应用服务：运行中，健康检查通过（PID %s）\n' "$pid"
        status_code=0
      else
        printf '应用服务：进程存在但健康检查失败（PID %s）\n' "$pid"
      fi
    fi
  elif [[ "$mode" == 'docker' ]]; then
    if docker_engine_running && [[ -n "$(compose_container_id)" ]] && health_check; then
      printf '应用服务：Docker 容器运行中，健康检查通过\n'
      status_code=0
    else
      printf '应用服务：Docker 模式未就绪或健康检查失败\n'
    fi
  else
    if port_is_listening "$APP_HOST" "$APP_PORT"; then
      owners="$(port_owner_pids "$APP_PORT" | paste -sd, -)"
      [[ -n "$owners" ]] || owners='无法识别'
      printf '应用服务：未受本项目脚本管理；端口被占用（PID %s）\n' "$owners"
    else
      printf '应用服务：已停止\n'
    fi
  fi

  printf '健康地址：%s\n' "$(health_url)"
  printf '日志文件：%s%s\n' "$LOG_FILE" "$([[ -f "$LOG_FILE" ]] && printf '' || printf '（尚未生成）')"
  print_docker_status
  print_optional_infrastructure
  return "$status_code"
}

main

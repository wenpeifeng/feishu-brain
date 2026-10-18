#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
SERVICE_DIR="${MINERU_SERVICE_DIR:-$(cd "$PROJECT_DIR/.." && pwd -P)/mineru-service}"
SERVICE_SCRIPT="$SERVICE_DIR/mineru-service.sh"

if [[ ! -x "$SERVICE_SCRIPT" ]]; then
  printf '错误：未找到共享 MinerU 服务脚本：%s\n' "$SERVICE_SCRIPT" >&2
  printf '请把 MinerU 服务放在项目同级的 mineru-service/，或设置 MINERU_SERVICE_DIR。\n' >&2
  exit 1
fi

exec "$SERVICE_SCRIPT" "${1:-status}"

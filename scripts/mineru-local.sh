#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${MINERU_SERVICE_DIR:-$(cd "$PROJECT_DIR/.." && pwd)/mineru-service}"
SERVICE_SCRIPT="$SERVICE_DIR/mineru-service.sh"

if [[ ! -x "$SERVICE_SCRIPT" ]]; then
  echo "未找到共享 MinerU 服务：$SERVICE_SCRIPT"
  echo "请在 /Users/wenpeifeng/job/project/mineru-service 中安装 MinerU 3.4.4"
  exit 1
fi

exec "$SERVICE_SCRIPT" "${1:-status}"

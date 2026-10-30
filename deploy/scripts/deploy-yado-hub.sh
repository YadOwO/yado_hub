#!/bin/bash
# yado Hub 服务部署脚本。
# 由 GitHub Actions 经 SSH forced command 触发，不接受任何参数与外部输入。
# 手动执行也可：sudo -u yado /opt/yado/scripts/deploy-yado-hub.sh
set -euo pipefail

COMPOSE_FILE=/opt/yado/docker-compose.yml
SERVICE=yado-hub
CONTAINER=yado-yado-hub-1

echo "[$(date '+%F %T')] 开始部署 ${SERVICE}"

# 记下当前镜像，失败时供人工回滚参考
BEFORE=$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || echo "（无运行中容器）")
echo "  部署前镜像: ${BEFORE}"

docker compose -f "$COMPOSE_FILE" pull "$SERVICE"
docker compose -f "$COMPOSE_FILE" up -d "$SERVICE"

# 等健康检查，最多 90 秒
echo "  等待健康检查..."
for i in $(seq 1 18); do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    echo "  健康检查通过（第 ${i} 次轮询）"
    echo "  部署后镜像: $(docker inspect --format '{{.Image}}' "$CONTAINER")"
    # 清理因更新而失去标签的旧镜像，避免占满 40G 系统盘
    docker image prune -f > /dev/null 2>&1 || true
    echo "[$(date '+%F %T')] 部署成功"
    exit 0
  fi
  sleep 5
done

echo "  健康检查未通过，最后状态: ${STATUS}" >&2
echo "  容器最近日志:" >&2
docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/    /' >&2
echo "[$(date '+%F %T')] 部署失败。回滚：把 compose 中 image 改回上一个可用标签后执行" >&2
echo "  docker compose -f ${COMPOSE_FILE} up -d ${SERVICE}" >&2
exit 1

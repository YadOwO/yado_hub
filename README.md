# yado_hub

芽豆系列产品（yadoA、yadoI……）的公共服务后端：各产品都要用的功能（意见反馈、以后的公告、版本检查等）
统一放在这里，不为单个功能另开服务；AI 相关的在 [yado_ai](../yado_ai)。客户端为 iOS，本服务只提供 REST 接口与
OpenAPI 契约。

- 当前功能：意见反馈，设计见 [意见反馈设计](./docs/feedback-design.md)。
- 数据放在 `yado` 库的 `yado_hub` schema；用户只以 Logto 用户 ID 标识，不存昵称、邮箱等资料。

技术栈与工程约定和 [yado_ai](../yado_ai)、[yadoA_be](../yadoAssets/yadoA_be) 保持一致（Node.js 22、Hono、
Zod + @hono/zod-openapi、Drizzle、PostgreSQL 16、Logto JWKS 验签），工程规则见 [AGENTS.md](./AGENTS.md)。

## 目录结构

```
src/
├── index.ts                    启动入口
├── app.ts                      组装路由、健康检查、OpenAPI 文档
├── config/env.ts               环境变量校验
├── config/products.ts          已接入的产品代号
├── db/                         Drizzle 表定义（yado_hub schema）与连接池
├── middleware/
│   ├── auth.ts                 Logto JWT 校验
│   ├── admin.ts                管理员校验（ADMIN_USER_IDS）
│   └── rate-limit.ts           按用户限流
├── shared/                     统一错误、OpenAPIHono 工厂
└── modules/
    ├── admin/index.ts          管理端汇总：GET /v1/admin/status，挂载各功能管理端
    └── feedback/               意见反馈
        ├── schemas.ts          请求与响应契约
        ├── service.ts          对话、反馈单、消息的读写与规则
        ├── dto.ts              数据库行转响应
        ├── routes.ts           用户端：/v1/feedback/{product}/...
        └── admin-routes.ts     管理端：/v1/admin/feedback/...
```

## 快速开始

```bash
pnpm install
cp .env.example .env
# 本地调试可在 .env 中设置 AUTH_DEV_BYPASS=true 跳过 JWT 校验；
# 同时把 ADMIN_USER_IDS 设为 AUTH_DEV_USER_ID（dev-user-0001）即可调试管理端
# 数据库复用 yadoA_be / yadoI_be 的本地 yado-postgres 容器（在 yadoA_be 目录 docker compose up -d）
pnpm run db:migrate
pnpm run dev
```

服务地址 `http://localhost:7791`，健康检查 `/health`，接口文档 `/openapi.json`。

## 接口

用户端（必须登录，`{product}` 为 `yadoa` / `yadoi`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/feedback/{product}/messages?before=&limit=` | 拉消息，序号倒序 |
| POST | `/v1/feedback/{product}/messages` | 发消息，同一 `id` 重发幂等 |
| POST | `/v1/feedback/{product}/read` | 标记已读到 `seq` |
| GET | `/v1/feedback/{product}/unread` | 未读条数 |

管理端（`ADMIN_USER_IDS` 中的账号）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/admin/status` | 是否管理员、待处理反馈单数；任何登录用户都可调用 |
| GET | `/v1/admin/feedback/tickets?status=&product=&before=&limit=` | 反馈单列表 |
| GET | `/v1/admin/feedback/conversations/{id}` | 对话与全部反馈单 |
| GET | `/v1/admin/feedback/conversations/{id}/messages?before=&limit=` | 对话消息 |
| POST | `/v1/admin/feedback/conversations/{id}/messages` | 回复 |
| POST | `/v1/admin/feedback/tickets/{id}/status` | 改状态 |

| 状态码 | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数校验失败 |
| 401 | `UNAUTHORIZED` | token 缺失或无效 |
| 403 | `FORBIDDEN` | 不是管理员 |
| 404 | `NOT_FOUND` | 对话或反馈单不存在 |
| 409 | `MESSAGE_ID_CONFLICT` | 消息 ID 已被其他对话使用，换新 ID 重发 |
| 409 | `TICKET_NOT_LATEST` | 只能把最新一条反馈单改回待处理 |
| 429 | `TOO_MANY_REQUESTS` | 发消息超过限流，`details.rule` 为 `per_minute` 或 `per_day` |

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm run dev` | 开发模式（热重载） |
| `pnpm run typecheck` | 类型检查 |
| `pnpm run build` | 编译到 `dist/` |
| `pnpm start` | 运行编译产物 |
| `pnpm run db:generate` | 表结构变更后生成迁移文件 |
| `pnpm run db:migrate` | 执行迁移（本地与生产统一走这条） |
| `pnpm run db:studio` | 打开 Drizzle Studio |

## 首次上线（一次性）

服务器与其他服务共用（`8.163.21.152`，见 `yadoServer/服务器重建手册.md`）。相关文件都在 `deploy/` 下。
**数据库角色与迁移（第 4、5 步）必须在合并到 `main` 之前完成**，否则自动部署后容器会起不来。

| 项目 | 值 |
| --- | --- |
| 域名 | `hub-api.yado1225.top`（泛域名证书已覆盖） |
| 容器端口 | 7791（不暴露公网，仅经 nginx 反代） |
| 镜像 | `ghcr.io/yadowo/yado_hub` |
| Logto audience | `https://api.yado1225.top/hub` |

1. **GitHub**：创建仓库 `YadOwO/yado_hub` 并推送。首次构建后到 GHCR 把 `yado_hub` 包设为
   public，或在服务器上 `docker login ghcr.io`，否则服务器拉不到镜像。
2. **DNS**：添加 A 记录 `hub-api` → `8.163.21.152`。
3. **Logto**：Console → API resources 新建资源，标识符填 `https://api.yado1225.top/hub`
   （创建后不可修改）。App 登录时要一并申请该 resource。
4. **建角色与 schema**：把 `deploy/postgres-init.sql` 中的 `<密码>` 换成新生成的强密码，在服务器上执行
   `docker exec -i yado-postgres-1 psql -U postgres -d yado < postgres-init.sql`。
5. **迁移**：按下文「数据库迁移」执行。
6. **环境变量**：按 `deploy/env.production.example` 写入 `/opt/yado/yado-hub/.env`，属主 `yado`，
   填入 `DATABASE_URL` 与 `ADMIN_USER_IDS`（自己的 Logto 用户 ID）。
7. **compose**：把 `deploy/docker-compose.service.yml` 的服务片段追加到
   `/opt/yado/docker-compose.yml` 的 `services` 下。
8. **部署脚本与 CI 密钥**：
   ```bash
   # 本机生成一把新的部署密钥，不要复用其他服务的
   ssh-keygen -t ed25519 -f ~/.ssh/yado_hub_ci_deploy -C github-actions-yado-hub-deploy -N ''
   ```
   服务器上安装 `deploy/scripts/deploy-yado-hub.sh` 到 `/opt/yado/scripts/`（`yado:yado`，755），
   并在 `/home/yado/.ssh/authorized_keys` 追加：
   ```
   command="/opt/yado/scripts/deploy-yado-hub.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty <公钥内容>
   ```
   私钥内容填入 GitHub 仓库 Secret `DEPLOY_SSH_KEY`。
9. **nginx**：把 `deploy/nginx/hub-api.yado1225.top.conf` 放到 `/opt/yado/nginx/conf.d/`，
   `docker exec yado-nginx-1 nginx -t && docker exec yado-nginx-1 nginx -s reload`。
10. **上线**：合并到 `main` 触发 Actions，或手动 workflow_dispatch。验证：
    ```bash
    curl -s https://hub-api.yado1225.top/health                 # {"status":"ok","db":"up",...}
    curl -s https://hub-api.yado1225.top/v1/feedback/yadoa/unread   # 401
    ```
11. **备份**：`/opt/yado/yado-hub/.env` 含数据库密码，记得存进密码管理器。
    `backup-db.sh` 的 `pg_dumpall` 已覆盖 `yado_hub` schema。

## 数据库迁移

迁移不进流水线，有新迁移时先手工执行，再合并发布。Postgres 不暴露公网，经 SSH 隧道在本机执行。

`yado_hub` 角色平时没有库级 CREATE 权限（被攻破时不能在共享库里建 schema），而 drizzle 迁移会执行
`CREATE SCHEMA IF NOT EXISTS`，所以迁移前临时授予、迁移后立即收回：

```bash
(
  set -euo pipefail
  PSQL="docker exec -i yado-postgres-1 psql -U postgres -d yado -c"
  tunnel_pid=
  cleanup() {
    if [ -n "$tunnel_pid" ]; then
      kill "$tunnel_pid" 2>/dev/null || true
    fi
    ssh root@8.163.21.152 "$PSQL 'REVOKE CREATE ON DATABASE yado FROM yado_hub'" || true
  }
  trap cleanup EXIT
  ssh root@8.163.21.152 "$PSQL 'GRANT CREATE ON DATABASE yado TO yado_hub'"
  PG_IP=$(ssh root@8.163.21.152 "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' yado-postgres-1")
  ssh -N -o ExitOnForwardFailure=yes -L 15432:"$PG_IP":5432 root@8.163.21.152 &
  tunnel_pid=$!
  # 等隧道建立；端口被占用时 ssh 会直接退出，这里随之报错
  sleep 3
  kill -0 "$tunnel_pid"
  DATABASE_URL=postgres://yado_hub:<密码>@localhost:15432/yado pnpm run db:migrate
)
```

## 日常发布

在 `dev` 开发，合并到 `main` 后 GitHub Actions 自动构建 amd64 镜像、推送 GHCR，
并经 SSH forced command 触发服务器部署脚本（pull + up -d + 等待健康检查）。
部署结果的 Bark 通知与 yado_ai 相同，需要时在仓库 Secret 配置 `BARK_DEVICE_KEY`，未配置时跳过。

## 已知限制

- 限流计数在进程内存中，重启清零；只适用于单实例部署，扩成多实例时需改用 Redis。
- 管理员名单在环境变量中，修改后需重启容器。

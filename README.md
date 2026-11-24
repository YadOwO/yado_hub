# yado_hub

芽豆系列产品（yadoA、yadoI……）的公共服务后端：各产品都要用的功能（意见反馈、以后的公告、版本检查等）
统一放在这里，不为单个功能另开服务；AI 相关的在 [yado_ai](../yado_ai)。客户端为 iOS，本服务只提供 REST 接口与
OpenAPI 契约。

- 当前功能：
  - 意见反馈，设计见 [意见反馈设计](./docs/feedback-design.md)。
  - 注销账号：所有芽豆 App 共用一个 Logto 账号，注销统一由 hub 编排，删完各服务的数据后再删 Logto 用户，见下文「注销账号」。
  - Agent 管理：Mac 上的 agentd（[yado_agents](../yado_agents)）每分钟来问一次有没有指令，有变化或每小时把状态摘要同步上来，管理端看运行结果、
    改实例与设置都经这里转成指令交给 agentd 执行。hub 不跑流程，只存摘要（不存代码、diff、模型原始输出）。
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
├── config/account-deletion.ts  注销时要调用的下游服务列表与凭证的解析
├── config/data-links.ts        数据联动来源（DATA_LINK_SOURCES）的解析，复用上面的下游服务
├── db/                         Drizzle 表定义（yado_hub schema）与连接池
├── middleware/
│   ├── auth.ts                 Logto JWT 校验，拒绝注销名单里的用户
│   ├── admin.ts                管理员校验（ADMIN_USER_IDS）
│   ├── machine.ts              agentd 的机器凭证校验（AGENT_MACHINE_TOKENS）
│   └── rate-limit.ts           按用户限流
├── shared/                     统一错误、OpenAPIHono 工厂、注销名单读写、Logto Management API 客户端
└── modules/
    ├── admin/index.ts          管理端汇总：GET /v1/admin/status，挂载各功能管理端
    ├── account/                注销账号 DELETE /v1/account
    │   ├── deletion.ts         编排：注销名单 → 意见反馈 → 数据联动授权 → 各下游服务 → Logto（不依赖数据库，可单独测试）
    │   ├── service.ts          把编排接上配置、数据库与 Logto
    │   └── routes.ts           路由
    ├── links/                  数据联动 /v1/links：授权记录与向来源后端取汇总
    │   ├── schemas.ts          请求与响应契约，来源后端响应的校验 schema
    │   ├── summary.ts          取汇总、判断能不能取、拼联动列表（不依赖数据库与环境变量，可单独测试）
    │   ├── service.ts          授权记录（data_links）的读写
    │   └── routes.ts           用户端：/v1/links/{source}/{target}/...
    └── feedback/               意见反馈
        ├── schemas.ts          请求与响应契约
        ├── service.ts          对话、反馈单、消息的读写与规则
        ├── dto.ts              数据库行转响应
        ├── routes.ts           用户端：/v1/feedback/{product}/...
        └── admin-routes.ts     管理端：/v1/admin/feedback/...
    └── agents/                 Agent 管理
        ├── schemas.ts          同步契约（与 yado_agents 的 src/sync/schemas.ts 对应）、指令白名单、管理端响应
        ├── service.ts          存同步上来的快照、事件、运行，指令的收发与过期
        ├── routes.ts           agentd 用：GET /v1/agents/check、POST /v1/agents/sync（机器凭证）
        └── admin-routes.ts     管理端：/v1/admin/agents/...
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
| GET | `/v1/links` | 数据联动列表：只列 `DATA_LINK_SOURCES` 里打开的来源，每项带是否已授权；没配时 `{"links": []}`，见下文「数据联动」 |
| PUT | `/v1/links/yadoi/yadoa` | 授权芽豆有物给芽豆资产提供物品购入价汇总；可重复调用 |
| DELETE | `/v1/links/yadoi/yadoa` | 取消授权；可重复调用，来源没开也能取消 |
| GET | `/v1/links/yadoi/yadoa/item-value-summary` | 取汇总：在用、退役物品的购入价合计与件数，加 `fetchedAt` |
| DELETE | `/v1/account` | 注销账号：删除各服务的数据和 Logto 用户，可重复调用，见下文「注销账号」 |

管理端（`ADMIN_USER_IDS` 中的账号）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/admin/status` | 是否管理员、待处理反馈单数、agent 待办数；任何登录用户都可调用 |
| GET | `/v1/admin/feedback/tickets?status=&product=&before=&limit=` | 反馈单列表 |
| GET | `/v1/admin/feedback/conversations/{id}` | 对话与全部反馈单 |
| GET | `/v1/admin/feedback/conversations/{id}/messages?before=&limit=` | 对话消息 |
| POST | `/v1/admin/feedback/conversations/{id}/messages` | 回复 |
| POST | `/v1/admin/feedback/tickets/{id}/status` | 改状态 |
| GET | `/v1/admin/agents/overview?tz=&date=` | 机器、实例、待办、某天（默认今天）的汇总 |
| GET | `/v1/admin/agents/runs?flow=&instance=&status=&before=&limit=` | 运行列表，可按流程类型、实例、状态筛 |
| GET | `/v1/admin/agents/runs/{machineId}/{runId}` | 运行详情：步骤、问题与判断、时间线 |
| GET | `/v1/admin/agents/lessons` | 经验（含已作废的）与各机器生效中经验的上限 |
| POST | `/v1/admin/agents/commands` | 给 Mac 发指令（白名单：新建 / 修改 / 删除实例、立即运行、取消、改全局设置、处理待办、立即同步、作废 / 恢复经验） |
| GET | `/v1/admin/agents/commands/{id}` | 查指令结果 |

agentd 用（机器凭证，不是 Logto 登录）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/agents/check` | 每分钟问一次有没有待执行的指令（只读），也用来判断是否在线 |
| POST | `/v1/agents/sync` | 上传快照（含经验）、新事件、相关运行与指令结果；返回已收到的位置与待执行的指令 |

| 状态码 | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数校验失败 |
| 401 | `UNAUTHORIZED` | token 缺失或无效，或账号已注销（注销名单里的用户） |
| 403 | `FORBIDDEN` | 不是管理员 |
| 403 | `ACCOUNT_DELETED` | 发消息与注销同时发生、注销先完成 |
| 403 | `DATA_LINK_NOT_GRANTED` | 取联动汇总时用户没授权（或已取消） |
| 404 | `NOT_FOUND` | 对话或反馈单不存在 |
| 404 | `DATA_LINK_UNAVAILABLE` | 联动来源没打开：授权与取汇总都会返回，取消授权不会 |
| 409 | `MESSAGE_ID_CONFLICT` | 消息 ID 已被其他对话使用，换新 ID 重发 |
| 409 | `TICKET_NOT_LATEST` | 只能把最新一条反馈单改回待处理 |
| 429 | `TOO_MANY_REQUESTS` | 发消息超过限流，`details.rule` 为 `per_minute` 或 `per_day` |
| 502 | `ACCOUNT_DELETION_FAILED` | 注销的某一步失败，`details.step` 是下游服务名或 `logto`；App 直接重试 |
| 502 | `DATA_LINK_UPSTREAM_FAILED` | 向来源后端取汇总失败、超过 5 秒或响应不合契约 |
| 503 | `SERVICE_NOT_CONFIGURED` | 注销所需的配置缺失（Logto M2M 凭证或下游服务列表），什么都没动 |

## 注销账号

所有芽豆 App 共用一个 Logto 账号，各 App 注销只调 hub 的 `DELETE /v1/account`。hub 按顺序做：

1. 把用户写进注销名单 `yado_hub.deleted_users`（永久保留）。之后这个用户的旧 token 访问 hub 的其他接口一律 401；
   注销接口本身用 `requireAuthIncludingDeleted`，所以中途失败后可以用同一个 token 重试。
2. 删除 hub 自己的意见反馈（反馈单只留不含用户与正文的匿名统计）。
3. 物理删除这个用户在 `yado_hub.data_links` 里的全部数据联动授权记录。
4. 按 `ACCOUNT_DELETION_SERVICES` 的顺序调各下游服务的内部接口 `DELETE {地址}/internal/v1/users/{userId}`，
   每个服务用 `ACCOUNT_DELETION_TOKENS` 里各自的机器凭证。下游各自删数据、写自己的注销名单，可重复调用。
5. 全部成功后，用 Logto Management API 删除 Logto 用户（404 算成功）。Logto 用户最后删：删了 App 就拿不到新 token，没法再重试。
6. 记下 `completed_at`。

任何一步失败（非 2xx、超时、网络错误）立即停下，返回 502 `ACCOUNT_DELETION_FAILED`，前面的步骤不回滚，App 重试时从头再走一遍。
`deleted_users` 里 `completed_at` 为空的行就是中途失败、用户还没重试成功的注销，可以据此排查：

```sql
SELECT user_id, deleted_at FROM yado_hub.deleted_users WHERE completed_at IS NULL ORDER BY deleted_at;
```

每个下游 10 秒超时，Logto 换 token、删用户各 10 秒，最坏约 50 秒，低于 nginx 默认的 60 秒；加下游服务时要一起核对。

配置（见 `.env.example`）：

- `ACCOUNT_DELETION_SERVICES`：`服务名=容器内网地址`，逗号分隔，按调用顺序。线上与 dev 都是
  `yado-ai=http://yado-ai:7790,yadoa-be=http://yadoa-be:7789,yadoi-be=http://yadoi-be:7788`（compose 服务名，走容器内网，不经 nginx）。
- `ACCOUNT_DELETION_TOKENS`：`服务名:凭证`，每个服务一个、互不相同。生成与配对：
  ```bash
  TOKEN=$(openssl rand -hex 32)                        # 填进 hub 的 ACCOUNT_DELETION_TOKENS，例如 yado-ai:$TOKEN
  printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1   # 填进对方的 INTERNAL_MACHINE_TOKENS=yado-hub:<这串>
  ```
- `LOGTO_M2M_APP_ID`、`LOGTO_M2M_APP_SECRET`：Logto 机器对机器应用，分配带 Logto Management API「all」权限的角色。
- 真实用户缺 Logto 凭证或一个下游都没配时返回 503，什么都不动；格式错误或服务与凭证对不上时服务启动失败。
- 开发态免鉴权（`AUTH_DEV_BYPASS=true`）的假用户不删 Logto 用户，下游配了几个调几个。调过一次注销后，`AUTH_DEV_USER_ID`
  就在注销名单里，本地其他接口都会 401；要恢复执行 `DELETE FROM yado_hub.deleted_users WHERE user_id = '<AUTH_DEV_USER_ID>';`，或换一个用户 ID。

新的产品后端接入：在它那边实现 `DELETE /internal/v1/users/{userId}`（机器凭证鉴权、可重复调用，照 yadoA_be 的 `modules/internal`），
生成一对凭证，在 hub 的两个变量里各加一项，重启 hub。

## 数据联动

用户在芽豆资产里主动授权后，hub 用机器凭证向芽豆有物的后端（yadoi-be）要这个用户的物品购入价汇总，芽豆资产在账户页显示「物品估值」。
hub 只存授权记录（`yado_hub.data_links`：用户、来源 `yadoi`、使用方 `yadoa`、范围 `item_value_summary`、授权与取消时刻），
不存任何汇总数；每次取汇总都现向来源后端要。接口路径用 `{source}/{target}`，不是 `{product}`，路径参数不在 `yadoi` / `yadoa` 里返回 400。

- `GET /v1/links` 只列 `DATA_LINK_SOURCES` 里打开的来源；`PUT` 授权，撤销后再授权会清掉取消标记并更新授权时刻；`DELETE` 取消授权，来源有没有打开都可以调。
- `GET /v1/links/yadoi/yadoa/item-value-summary`：来源没开返回 404，没授权返回 403；已授权就带 yadoi-be 的机器凭证调
  `GET {地址}/internal/v1/users/{userId}/item-value-summary`，5 秒超时，失败、超时或响应不合契约都返回 502，成功时原样返回汇总数并加 `fetchedAt`。
- 四个接口都要 Logto 登录并按用户限流（每分钟 60 次、每天 3000 次，写在 `middleware/rate-limit.ts`）。
- 配置：`DATA_LINK_SOURCES`（见 `.env.example`），逗号分隔，目前只认 `yadoi`，默认空即不开任何联动。来源后端的地址与凭证复用
  `ACCOUNT_DELETION_SERVICES` / `ACCOUNT_DELETION_TOKENS` 里的 `yadoi-be`；打开 `yadoi` 却找不到 `yadoi-be`、或写了不认识 / 重复的来源，服务启动失败。
  dev 配 `yadoi`，线上等芽豆有物上架那天再配。
- 日志只记事件、用户 ID 与来源，不记金额；取汇总失败时记 `data_link_upstream_failed`（服务名、用户 ID、状态码或错误名，不含地址和凭证）。

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

## 接入一台跑 agentd 的 Mac

1. 在 Mac 上运行 `agentctl hub setup https://hub-api.yado1225.top`，它生成凭证（只存在 Mac 的
   `~/.yado-agents/hub.json`）并打印一行 `AGENT_MACHINE_TOKENS=<机器 ID>:<sha256>`。
2. 把这一行加进服务器 `/opt/yado/yado-hub/.env`（多台机器用逗号接在后面），重启 hub。
3. 一分钟内管理端「Agent」页能看到这台机器在线。换凭证用 `agentctl hub setup ... --rotate`，再替换 `.env` 里的那一行。

## 已知限制

- 限流计数在进程内存中，重启清零；只适用于单实例部署，扩成多实例时需改用 Redis。
- 管理员名单、agent 机器凭证、注销要调的下游服务与凭证在环境变量中，修改后需重启容器。
- 页面发给 Mac 的指令要等它下次来问（每分钟一次）才执行；Mac 离线时指令 10 分钟后作废。
- 页面上的实例、待办是 Mac 最近一次上传时的状态：Mac 有新事件时一分钟内上传，否则一小时一次；页面上的「立即同步」让它马上传。
- 「是否在线」看 Mac 最近一次来问的时间，只记在内存里；hub 重启后最多一分钟显示离线。

# 下次发布要做的事

<!-- 上线时要额外做的事（加环境变量、改 nginx、执行 SQL）一条一行写在这里，发布后会挪进 deploy/releases/ -->

- 注销改由 hub 编排（上线顺序）：先发 yado_ai、yadoA_be、yadoI_be（各自换成内部删除接口并配好 INTERNAL_MACHINE_TOKENS），再迁移、发 hub，最后发 App；顺序反了也不会只删一半：下游接口不在时 hub 返回 502，不会删 Logto 用户
- 迁移 0005（建 yado_hub.deleted_users）：新镜像上线前按 README「数据库迁移」用 `pnpm run db:migrate` 执行；只建表，旧镜像不受影响。新镜像的鉴权每次都查这张表，没迁移就上新镜像会让所有登录接口返回 500
- 环境变量（线上 `/opt/yado/yado-hub/.env`）：按 deploy/env.production.example 加 `ACCOUNT_DELETION_SERVICES`、`ACCOUNT_DELETION_TOKENS`（三个下游各生成一个凭证，sha256 填进对方的 INTERNAL_MACHINE_TOKENS）和 `LOGTO_M2M_APP_ID`、`LOGTO_M2M_APP_SECRET`（从 `/opt/yado/yadoa-be/.env` 挪过来）；没配时注销返回 503
- 环境变量（dev，mini 的 `~/yado-dev/compose.yaml` 的 yado-hub）：同样四项，M2M 用 `.env` 里现有的 `YADOA_M2M_APP_ID`、`YADOA_M2M_APP_SECRET`，并照 yadoa-be 加 `NODE_EXTRA_CA_CERTS: /internal-tls/server.crt` 和对应的 volume（hub 要经 logto-tls 调 dev Logto 的 Management API）
- 上线后验证：用一个测试账号在 App 里注销，hub 日志依次出现 `account_deletion_step` 的 feedback、data_links、yado-ai、yadoa-be、yadoi-be、logto、completed；`SELECT * FROM yado_hub.deleted_users WHERE completed_at IS NULL` 没有残留
- 迁移 0006（建 yado_hub.data_links，数据联动授权记录）：新镜像上线前按 README「数据库迁移」执行 `pnpm run db:migrate`，只建表；新镜像注销账号时会删这张表里该用户的行，没迁移就上新镜像会让注销返回 500
- dev（mini 的 `~/yado-dev/compose.yaml` 的 yado-hub）：加 `DATA_LINK_SOURCES=yadoi`。前提是 `ACCOUNT_DELETION_SERVICES` / `ACCOUNT_DELETION_TOKENS` 里已有 yadoi-be，否则 hub 启动失败；先用 `deploy-dev.sh` 更新 yadoI_be（带上 item-value-summary 内部接口），再更新 hub
- 线上：这次不配 `DATA_LINK_SOURCES`（空即不开联动，`GET /v1/links` 返回空列表）。芽豆有物上架那天，确认线上 yadoi-be 已带上 item-value-summary 内部接口，再在 `/opt/yado/yado-hub/.env` 加 `DATA_LINK_SOURCES=yadoi` 并重启 hub；芽豆资产不用发新版本
- 数据联动验证（dev）：`GET /v1/links` 返回 yadoi；授权后 `GET /v1/links/yadoi/yadoa/item-value-summary` 返回 200，hub 日志没有 `data_link_upstream_failed`
- 以后（这次上线之后的某次改动）：删掉 `src/db/schema.ts` 里已停用的 `feedbackDeletedUsers`，`db:generate` 出 DROP TABLE 迁移

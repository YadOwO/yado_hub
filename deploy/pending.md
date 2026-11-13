# 下次发布要做的事

<!-- 上线时要额外做的事（加环境变量、改 nginx、执行 SQL）一条一行写在这里，发布后会挪进 deploy/releases/ -->

执行迁移 drizzle/0004_feedback_deleted_users.sql（新建 yado_hub.feedback_deleted_users，注销墓碑，发反馈和注销接口依赖它）：pnpm run db:migrate

# 下次发布要做的事

<!-- 上线时要额外做的事（加环境变量、改 nginx、执行 SQL）一条一行写在这里，发布后会挪进 deploy/releases/ -->
- 上线前先执行迁移 drizzle/0002_feedback_diagnostics.sql（ALTER TABLE yado_hub.feedback_messages ADD COLUMN diagnostics jsonb），新代码查询会用到这一列，必须先迁移再部署新镜像。只加可空列，旧代码不受影响

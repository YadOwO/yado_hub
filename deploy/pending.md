# 下次发布要做的事

<!-- 上线时要额外做的事（加环境变量、改 nginx、执行 SQL）一条一行写在这里，发布后会挪进 deploy/releases/ -->
- 上线前先执行迁移 drizzle/0002_feedback_diagnostics.sql（ALTER TABLE yado_hub.feedback_messages ADD COLUMN diagnostics jsonb），新代码查询会用到这一列，必须先迁移再部署新镜像。只加可空列，旧代码不受影响
- 发布时更新服务器 nginx 配置 deploy/nginx/hub-api.yado1225.top.conf（location / 加 client_max_body_size 3m）并 reload nginx，否则带诊断的反馈会被 nginx 默认的 1 MB 上限拦下

# 下次发布要做的事

<!-- 上线时要额外做的事（加环境变量、改 nginx、执行 SQL）一条一行写在这里，发布后会挪进 deploy/releases/ -->

- 发布顺序（去掉 isDryRun）：hub 要先于不再传 isDryRun 的新版 agentd 上线（旧 hub 会拒绝它的同步），并和 yado_console 同一批发（新 hub 会拒绝旧 console 带 isDryRun 的指令）

# 下次发布要做的事

<!-- 上线时要额外做的事（加环境变量、改 nginx、执行 SQL）一条一行写在这里，发布后会挪进 deploy/releases/ -->

- 注销前验证身份与数据汇总（上线顺序）：先发 yado_ai、yadoA_be、yadoI_be（都带上只读的 `GET /internal/v1/users/{userId}/summary`），确认它们都上线了再发 hub，最后发 yadoA；顺序反了也不影响注销：下游没有 summary 接口时，hub 只把那一项显示为「暂时查不到」
- 环境变量：dev 和线上的 hub 都要加 `LOGTO_APP_IDS`（dev 填 `7snnjg90shlsuamug4zez`，线上填 `rgne9x102v0qrifpqakl6`），照 deploy/env.production.example；留空时「重新登录」这种验证方式返回 503，只用 Apple 登录（没有密码和邮箱）的账号就无法注销
- 确认 dev 和线上 Logto 的邮件连接器配了 Generic 模板（hub 调 Management API 的 `/api/verification-codes` 发验证码用这个模板），上线后用一个有邮箱的测试账号在 App 里发一次验证码试试，邮箱能收到才算配好
- hub 上线后，不带 `X-Account-Deletion-Ticket` 的 `DELETE /v1/account` 一律返回 426，旧版 yadoA 不能再注销，必须和新版 yadoA 一起验证（yadoA 还没上架，可以接受）
- `ACCOUNT_DELETION_SERVICES`、`ACCOUNT_DELETION_TOKENS` 和 Logto M2M 凭证沿用现有的，不用改；汇总接口复用同一套下游地址和凭证，M2M 应用也沿用（它已经有 Management API「all」权限，够调用户、密码校验、验证码这几个接口）

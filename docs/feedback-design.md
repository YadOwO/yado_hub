# 意见反馈设计

> yado_hub 的第一个功能。芽豆各产品共用，对话形式，必须登录。

## 结论

- 用户端：每个用户在每个产品下只有一个对话，和微信客服一样一直往下聊。
- 管理端：对话在后台按轮自动拆成多条「反馈单」，每条各有「待处理 / 已处理」状态；管理员在 App 内统一查看全部产品的反馈单，不做任何通知。
- 新服务 yado_hub：技术栈、目录结构、鉴权方式与 yado_ai 一致；Postgres 同一实例，独占 `yado_hub` schema。

## 部署信息

| 项 | 值 |
| --- | --- |
| 目录 | `yado/yado_hub` |
| 端口 | 7791（yadoI_be 7788、yadoA_be 7789、yado_ai 7790） |
| 域名 | `hub-api.yado1225.top` |
| Logto resource | `https://api.yado1225.top/hub` |
| 数据库 schema | `yado_hub` |

App 登录时要多申请这个 resource。App 未上线，不处理已登录设备的重新登录。

## 第一版范围

做：

1. yado_hub 后端：对话、反馈单、消息、用户未读，下方 10 个接口。
2. yadoA 用户端：「我的」入口与未读数、聊天页（纯文字）。
3. yadoA 管理端：反馈单列表（待处理 / 已处理 / 全部，按产品筛选）、详情（回复、改状态）。

不做：图片、任何推送、服务端自动回复、处理记录日志、标签分类、展示用户昵称、网页后台。

## 反馈单规则

- 用户第一次发消息时创建对话和第一条反馈单，状态为「待处理」。
- 用户发消息：最新一条反馈单是「待处理」就归入它；是「已处理」就新开一条「待处理」的反馈单。
- 管理员回复：归入最新一条反馈单，不改变状态（回复「收到，会修」时问题还没解决）。
- 管理员可把反馈单标记为「已处理」，也可以把最新一条改回「待处理」；旧的反馈单不能改回，避免同一对话出现两条待处理。
- 同一对话同一时刻最多一条「待处理」，由数据库部分唯一索引兜底。

## 表

`feedback_conversations`：(product, user_id) 唯一。

| 字段 | 说明 |
| --- | --- |
| id | uuid |
| product | 产品代号：`yadoa` / `yadoi` |
| user_id | Logto 用户 ID |
| user_read_seq | 用户已读到的消息序号；比它大的管理员消息算未读 |
| created_at | |

`feedback_tickets`：反馈单。

| 字段 | 说明 |
| --- | --- |
| id | uuid |
| conversation_id | |
| status | `pending` / `resolved` |
| created_at | 开单时间，即这一轮第一条用户消息的时间 |
| resolved_at | 最近一次标记已处理的时间，待处理时为空 |
| last_message_seq | 本单最新一条消息的序号，列表按它倒序，也作分页游标 |
| last_message_at | 本单最新一条消息的时间 |

`feedback_messages`：

| 字段 | 说明 |
| --- | --- |
| seq | 自增序号，排序与分页游标 |
| id | uuid，客户端生成，重发时幂等 |
| conversation_id / ticket_id | |
| sender | `user` / `admin` |
| content | 纯文本，1–1000 字 |
| client_info | jsonb，只有用户消息带：App 版本、系统版本、机型、语言 |
| created_at | 服务端时间 |

## 接口

用户端：挂 `requireAuth`，`{product}` 只接受已登记的产品代号。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/feedback/{product}/messages?before=&limit=` | 分页拉消息，新的在前 |
| POST | `/v1/feedback/{product}/messages` | 发消息：`id`、`content`、`clientInfo` |
| POST | `/v1/feedback/{product}/read` | 标记已读到 `seq` |
| GET | `/v1/feedback/{product}/unread` | 未读条数，给红点用 |

管理端：挂 `requireAuth` + `requireAdmin`（`/v1/admin/status` 只挂 `requireAuth`），管理员 Logto 用户 ID 配在环境变量 `ADMIN_USER_IDS`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/admin/status` | `isAdmin` 与待处理反馈单数；非管理员返回 `isAdmin: false` |
| GET | `/v1/admin/feedback/tickets?status=&product=&before=&limit=` | 反馈单列表：产品、用户 ID、状态、最后一条消息摘要 |
| GET | `/v1/admin/feedback/conversations/{id}` | 对话信息与它的全部反馈单，详情页画分隔线用 |
| GET | `/v1/admin/feedback/conversations/{id}/messages?before=&limit=` | 拉消息，带 `ticketId` 与用户的 `clientInfo` |
| POST | `/v1/admin/feedback/conversations/{id}/messages` | 回复，归入最新反馈单 |
| POST | `/v1/admin/feedback/tickets/{id}/status` | 改状态：`pending` / `resolved` |

限流：用户发消息每分钟 10 条、每天 100 条；其余接口与管理端不限。

## yadoA 客户端

用户端：

- 入口：「我的」根页面新开一张卡片放「意见反馈」，有未读时行尾显示未读数，「我的」Tab 显示角标。未登录点击先弹登录页。
- 未读数在 App 启动、回到前台、进入「我的」时拉取。
- 聊天页：顶部一条本地化欢迎语（只在客户端，不存库）；消息气泡、时间分隔；底部输入框；发送失败可重发；看到最新消息即标记已读；打开期间每 15 秒拉一次新消息。

管理端（`isAdmin` 为真时，同一入口进入反馈管理页）：

- 列表：顶部分段「待处理 / 已处理 / 全部」，默认待处理；可按产品筛选；按最后消息倒序；入口行尾显示待处理数。
- 详情：显示整段对话，反馈单之间画分隔线并标出状态；用户消息下方小字显示 client_info；导航栏按钮「标记已处理 / 改回待处理」。

## 以后

- 图片：复用头像的 OSS 上传。
- APNs 推送用户。
- 账号注销时删除该用户的对话。
- 管理端显示用户昵称：经 Logto Management API 查询。
- 处理记录日志、标签分类、网页后台。

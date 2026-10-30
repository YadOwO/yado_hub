# yado_hub 项目规则

本文件适用于 yado_hub 仓库（Node.js + TypeScript 的通用业务服务），是 Codex、Kiro CLI、
Claude Code 及其他代码 Agent 的项目规则唯一来源。

工程约定与 [yado_ai](../yado_ai) / [yadoA_be](../yadoAssets/yadoA_be) 保持一致。本服务是芽豆各产品的
**公共服务后端**：各产品都要用的功能（第一个是意见反馈）统一放这里，不为单个功能另开服务；AI 相关的放 yado_ai。
数据放在 `yado_hub` schema；用户只以 Logto 用户 ID 标识，不存昵称、邮箱等资料。

## Agent 与 Skill 使用边界

- 本仓库是个人项目，不适用 Webull 工作流。
- 禁止调用或遵循任何名称以 `wb-` 开头的 skill，包括但不限于 `wb-commit`、
  `wb-code-review`、`wb-create-git-branch`、`wb-mr`、`wb-read-prd` 和 `wb-test-gen`。
- Git 提交、代码审查、分支和需求处理应遵循用户当次指令与本文件规则，不套用 Webull
  的需求单号、分支名、提交信息或 MR 规范。

## 语言

- 对话回复、文档、代码注释统一用中文。
- 代码标识符（变量、函数、类型、配置键）用英文。

## 注释规范

- 新增或修改变量、常量、函数和方法时，尽量使用中文 `/** */` 注释说明其业务含义、
  职责或关键约束。
- 声明级注释优先使用 `/** */`，不要用 `//` 代替；流程说明或局部实现细节可以使用 `//`。
- 注释应解释“为什么”或业务语义，不要只是重复代码本身。

## 技术栈边界

- 框架为 Hono，不要引入 Express / NestJS / Fastify 的写法或中间件。
- 校验为 Zod（v4），业务 schema 一律从 `@hono/zod-openapi` 导入的 `z`，确保版本一致。
- 不要自行安装新依赖或引入新框架，需先与维护者确认。

## 类型安全

- 禁止 `any`。外部不可信数据用 `unknown` 或 schema 校验后再使用。
- 禁止 `@ts-ignore`；确有必要时用 `@ts-expect-error` 并写明原因。
- 禁止用 `as` 掩盖真实的类型不匹配，禁止 `as unknown as T`。
- 导出的函数、类型必须显式标注参数与返回值类型。
- `tsconfig` 已开启 `strict` 与 `noUncheckedIndexedAccess`，不要为消除报错而放宽配置。

## 命名

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 文件、目录 | kebab-case 或小写 | `admin-routes.ts`, `rate-limit.ts` |
| 变量、函数 | camelCase | `sendUserMessage`, `requireAdmin` |
| 布尔变量 | is/has/should 前缀 | `isProduction`, `isAdmin` |
| 常量 | UPPER_SNAKE_CASE | `MESSAGE_MAX_LENGTH` |
| 接口 | PascalCase + `I` 前缀 | `IErrorBody` |
| 类型别名、Schema | PascalCase | `AppErrorStatus`, `SendUserMessageSchema` |

## 分层职责

```
modules/<功能>/schemas.ts        Zod 契约：请求与对外响应，用户端与管理端共用
modules/<功能>/service.ts        数据读写与业务规则
modules/<功能>/routes.ts         用户端路由，挂在 /v1/<功能> 下，产品代号作为路径参数 {product}
modules/<功能>/admin-routes.ts   管理端路由，由 modules/admin 挂到 /v1/admin/<功能>
modules/admin/index.ts          管理端汇总与管理入口状态，可以引用各功能的 service
config/products.ts              已接入的产品代号
db/                             Drizzle 表定义（yado_hub schema）与连接池
shared/                         跨功能通用能力
middleware/                     请求级横切逻辑（鉴权、管理员、限流）
```

- 新增功能：建 `modules/<功能>/`，在 `app.ts` 中加一行 `app.route('/v1/<功能>', ...)`；有管理端时在
  `modules/admin/index.ts` 中加一行 route。
- 接入新产品：在 `config/products.ts` 的 `PRODUCT_CODES` 中加一项，不需要改功能代码。
- 功能之间不互相 import（`modules/admin` 除外），需要复用的逻辑下沉到 `shared/`。

## 接口约定

- 错误响应统一为 `{ code, message, details? }`，由 `shared/errors.ts` 的 `AppError` 与全局
  `onError` 产出，不要在路由里手写错误结构。
- 时刻字段对外输出 ISO 8601。
- `openapi.json` 是与 iOS 客户端之间的契约，新增路由必须用 `app.openapi()` 定义，不要用裸 `app.get()`。
- 列表接口用「before 游标 + limit」分页，游标是自增序号，响应带 `nextBefore`。

## 安全红线

- 用户端路由**必须**在 `createRoute` 的 `middleware` 字段挂 `requireAuth`；管理端路由依次挂
  `requireAuth` 与 `requireAdmin`。不要改用 `app.use('/*', ...)`：子应用挂载后该通配不匹配模块根路径，
  会造成接口绕过鉴权。
- 用户端查询一律按当前用户过滤，只能读写自己的数据。
- **日志不记录用户提交的正文**（反馈内容属于用户隐私），只记录功能、用户 ID、耗时与错误类型。
- 不要在日志或错误响应中输出 token、密钥、完整 JWT 内容。
- 不要提交 `.env`；新增配置项同步补充到 `.env.example` 与 `deploy/env.production.example`。

## 改动前后

- 改动运行时行为后，至少执行 `pnpm run typecheck` 与 `pnpm run build`。
- 改表结构后用 `pnpm run db:generate` 生成迁移并提交；不要用 `drizzle-kit push`。迁移不进流水线，需手工执行。
- 新增或修改接口后，实际启动服务验证，不要只依据类型检查就宣称完成。
- 输出完整可运行代码，不要留 `// ...` 之类的省略片段；确实无法实现的占位需显著标注并在回复中说明。

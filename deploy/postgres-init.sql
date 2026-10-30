-- 为 yado_hub 创建独立的数据库角色与 schema。
-- 在服务器上以超级用户执行一次：
--   docker exec -i yado-postgres-1 psql -U postgres -d yado < postgres-init.sql
-- 执行前把 <密码> 换成新生成的强密码（如 openssl rand -base64 24），并同步写入 yado-hub/.env 的 DATABASE_URL。
--
-- 用独立角色而不是复用其他产品的角色：yado-hub 被攻破时，也读不到 yadoa、yadoi、yado_ai、logto 的数据。

CREATE ROLE yado_hub LOGIN PASSWORD '<密码>';

-- schema 归 yado_hub 所有，迁移可以在其中自由建表
CREATE SCHEMA IF NOT EXISTS yado_hub AUTHORIZATION yado_hub;

-- 连接 yado 库；不授予其他 schema 的任何权限
GRANT CONNECT ON DATABASE yado TO yado_hub;

-- 不授予库级 CREATE：运行时角色被攻破时，也不能在共享库里新建 schema。
-- drizzle 每次迁移都会执行 CREATE SCHEMA IF NOT EXISTS "yado_hub"，Postgres 即使 schema 已存在也要求库级 CREATE 权限，
-- 因此只在执行迁移时临时授予，迁移后立即收回（步骤见 README「数据库迁移」）。

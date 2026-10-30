/**
 * 环境变量加载与校验。
 *
 * 校验失败时直接退出进程，避免服务带着错误配置运行。
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

/** 启动时校验配置并补齐默认值 */
const envSchema = z.object({
  /** HTTP 监听端口，与本地开发及部署端口配置保持一致 */
  PORT: z.coerce.number().int().positive().default(7791),
  /** 运行环境；生产环境用于强制关闭开发态免鉴权 */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Postgres 连接串；本服务只读写其中的 yado_hub schema */
  DATABASE_URL: z.string().min(1),

  /** Logto 的 issuer，例如 https://accounts.yado1225.top/oidc */
  LOGTO_ISSUER: z.string().min(1),
  /** 本服务在 Logto 中注册的 API resource indicator，作为 JWT 的 audience 校验 */
  LOGTO_AUDIENCE: z.string().min(1),
  /** JWKS 地址，缺省时由 issuer 推导为 {issuer}/jwks */
  LOGTO_JWKS_URL: z.string().min(1).optional(),

  /** 本地开发跳过 JWT 校验，生产环境强制失效 */
  AUTH_DEV_BYPASS: z.enum(['true', 'false']).default('false'),
  /** 开发态免鉴权时注入的用户标识，用于联调日志与按用户限流 */
  AUTH_DEV_USER_ID: z.string().min(1).default('dev-user-0001'),

  /** 管理员的 Logto 用户 ID，逗号分隔；只有这些账号能访问 /v1/admin 下的管理接口 */
  ADMIN_USER_IDS: z.string().default(''),

  /** 允许的跨域来源，逗号分隔；生产环境应配置具体域名而非 * */
  CORS_ORIGINS: z.string().min(1).default('*'),

  /** 每个用户每分钟最多发送的反馈消息数，防止连点或脚本刷接口 */
  FEEDBACK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** 每个用户每天最多发送的反馈消息数 */
  FEEDBACK_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(100),
});

/** 只对通过校验的环境变量继续初始化，避免错误配置进入运行阶段 */
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`环境变量校验失败：\n${details}\n请参考 .env.example 补全配置。`);
  process.exit(1);
}

/** 已通过校验并补齐默认值的原始配置，供下方派生运行时选项 */
const raw = parsed.data;
/** 生产环境标识，作为开发态免鉴权的强制关闭条件 */
const isProduction = raw.NODE_ENV === 'production';

/** 供全服务使用的已校验配置及派生选项；包含连接串，不可整体写入日志 */
export const env = {
  ...raw,
  isProduction,
  /** JWKS 实际地址 */
  logtoJwksUrl: raw.LOGTO_JWKS_URL ?? `${raw.LOGTO_ISSUER.replace(/\/$/, '')}/jwks`,
  /**
   * 是否启用开发态免鉴权。
   * 生产环境无论如何配置都为 false，防止误开导致接口裸奔。
   */
  isDevAuthBypassEnabled: raw.AUTH_DEV_BYPASS === 'true' && !isProduction,
  /** 管理员用户 ID 集合；未配置时为空，任何人都不是管理员 */
  adminUserIds: new Set(
    raw.ADMIN_USER_IDS.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  ),
} as const;

if (raw.AUTH_DEV_BYPASS === 'true' && isProduction) {
  console.warn('检测到 AUTH_DEV_BYPASS=true，但当前为生产环境，已强制忽略该配置。');
}

/**
 * 环境变量加载与校验。
 *
 * 校验失败时直接退出进程，避免服务带着错误配置运行。
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { parseAccountDeletionServices } from './account-deletion.js';
import { splitCommaSeparated } from './comma-separated.js';

loadDotenv({ quiet: true });

/**
 * 可选的非空字符串。.env 里写成 `KEY=` 会得到空字符串，这里把空字符串（含只有空白）视为未配置，
 * 避免留空的可选配置让服务启动失败。
 */
const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

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

  /**
   * 允许同步 agent 状态的机器：`机器 ID:凭证的 sha256`，逗号分隔，例如 `m5-mac:3f2a…`。
   * 只存哈希，不存凭证本身；凭证由 Mac 上的 `agentctl hub setup` 生成。未配置时同步接口一律 401。
   */
  AGENT_MACHINE_TOKENS: z
    .string()
    .default('')
    .refine(
      (value) =>
        splitCommaSeparated(value).every((item) =>
          /^[a-z0-9][a-z0-9-]{0,39}:[0-9a-f]{64}$/.test(item),
        ),
      { message: '格式应为 机器ID:sha256（64 位小写十六进制），多台用逗号分隔' },
    ),

  /**
   * Logto Machine-to-Machine 应用 ID：注销账号的最后一步用它调 Management API 删除 Logto 用户。
   * 留空时真实用户注销返回 503，开发态免鉴权的假用户不受影响。
   */
  LOGTO_M2M_APP_ID: optionalNonEmptyString,
  /** Logto Machine-to-Machine 应用密钥，与 LOGTO_M2M_APP_ID 成对配置 */
  LOGTO_M2M_APP_SECRET: optionalNonEmptyString,
  /** Logto Management API 的 resource indicator；留空时用 Logto 内置值 */
  LOGTO_MANAGEMENT_RESOURCE: optionalNonEmptyString,

  /**
   * 注销账号时按顺序调用的下游服务：`服务名=容器内网地址`，逗号分隔，
   * 例如 `yado-ai=http://yado-ai:7790,yadoa-be=http://yadoa-be:7789,yadoi-be=http://yadoi-be:7788`。
   * 留空时真实用户注销返回 503；格式错误或与 ACCOUNT_DELETION_TOKENS 对不上时启动失败。
   */
  ACCOUNT_DELETION_SERVICES: z.string().default(''),
  /**
   * 发给每个下游服务的机器凭证：`服务名:凭证`，逗号分隔，每个服务一个且互不相同。
   * 对方的 INTERNAL_MACHINE_TOKENS 里存 `yado-hub:<凭证的 sha256>`。
   */
  ACCOUNT_DELETION_TOKENS: z.string().default(''),
});

/** 只对通过校验的环境变量继续初始化，避免错误配置进入运行阶段 */
const parsed = envSchema
  .superRefine((value, context) => {
    const result = parseAccountDeletionServices(value.ACCOUNT_DELETION_SERVICES, value.ACCOUNT_DELETION_TOKENS);
    if (!result.ok) {
      context.addIssue({ code: 'custom', path: ['ACCOUNT_DELETION_SERVICES'], message: result.message });
    }
  })
  .safeParse(process.env);

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
/** 去掉末尾 `/` 的 Logto issuer，JWKS、token 与 Management API 地址都以它为基础拼接 */
const logtoIssuerBase = raw.LOGTO_ISSUER.replace(/\/$/, '');

/** 已在 superRefine 里校验过，这里解析必然成功；保险起见失败时按未配置处理 */
const accountDeletionServicesResult = parseAccountDeletionServices(
  raw.ACCOUNT_DELETION_SERVICES,
  raw.ACCOUNT_DELETION_TOKENS,
);

/** 供全服务使用的已校验配置及派生选项；包含连接串与密钥，不可整体写入日志 */
export const env = {
  ...raw,
  isProduction,
  /** JWKS 实际地址 */
  logtoJwksUrl: raw.LOGTO_JWKS_URL ?? `${logtoIssuerBase}/jwks`,
  /**
   * Logto Management API 配置：两个 M2M 凭证都配置时才可用，否则为 null。
   * tokenUrl 用于换取 M2M access token；apiBaseUrl 是 Management API 根地址，
   * 位于 Logto 域名根下的 /api（issuer 去掉末尾的 /oidc）。
   */
  logtoManagement:
    raw.LOGTO_M2M_APP_ID !== undefined && raw.LOGTO_M2M_APP_SECRET !== undefined
      ? {
          tokenUrl: `${logtoIssuerBase}/token`,
          apiBaseUrl: `${logtoIssuerBase.replace(/\/oidc$/, '')}/api`,
          resource: raw.LOGTO_MANAGEMENT_RESOURCE ?? 'https://default.logto.app/api',
          appId: raw.LOGTO_M2M_APP_ID,
          appSecret: raw.LOGTO_M2M_APP_SECRET,
        }
      : null,
  /** 注销账号时按顺序调用的下游服务；未配置时为空 */
  accountDeletionServices: accountDeletionServicesResult.ok ? accountDeletionServicesResult.services : [],
  /**
   * 是否启用开发态免鉴权。
   * 生产环境无论如何配置都为 false，防止误开导致接口裸奔。
   */
  isDevAuthBypassEnabled: raw.AUTH_DEV_BYPASS === 'true' && !isProduction,
  /** 管理员用户 ID 集合；未配置时为空，任何人都不是管理员 */
  adminUserIds: new Set(splitCommaSeparated(raw.ADMIN_USER_IDS)),
  /** 凭证哈希 → 机器 ID；未配置时为空，任何机器都不能同步 */
  agentMachineTokens: new Map(
    splitCommaSeparated(raw.AGENT_MACHINE_TOKENS).map((item) => {
      const [machineId = '', hash = ''] = item.split(':');
      return [hash, machineId] as const;
    }),
  ),
} as const;

if (raw.AUTH_DEV_BYPASS === 'true' && isProduction) {
  console.warn('检测到 AUTH_DEV_BYPASS=true，但当前为生产环境，已强制忽略该配置。');
}

if ((raw.LOGTO_M2M_APP_ID === undefined) !== (raw.LOGTO_M2M_APP_SECRET === undefined)) {
  console.warn('LOGTO_M2M_APP_ID 与 LOGTO_M2M_APP_SECRET 只配了一个，按未配置处理：真实用户注销会返回 503。');
}

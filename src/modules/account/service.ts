/**
 * 注销账号：把 deletion.ts 的编排、verification.ts 的验证身份与票据、summary.ts 的数据汇总，
 * 接上配置、数据库、下游服务与 Logto。
 *
 * 本模块汇总各功能的用户数据删除，所以可以引用各功能的 service；hub 自己目前有意见反馈与数据联动授权。
 */
import { env } from '../../config/env.js';
import { markUserDeleted, markUserDeletionCompleted } from '../../shared/deleted-users.js';
import { serviceNotConfigured } from '../../shared/errors.js';
import { verifyLogtoIdToken } from '../../shared/logto-jwks.js';
import { createLogtoManagementClient } from '../../shared/logto-management.js';
import { deleteUserFeedbackData } from '../feedback/service.js';
import { deleteUserDataLinks } from '../links/service.js';
import { deleteAccountEverywhere, deleteUserFromService, resolveAccountDeletionPlan } from './deletion.js';
import { collectAccountSummary, type IAccountSummary } from './summary.js';
import {
  AccountDeletionTicketStore,
  sendDeletionEmailCode,
  verifyIdentity,
  type IdentityProof,
  type IIssuedTicket,
} from './verification.js';

/** 进程内复用的 Logto Management API 客户端，共享 M2M token 缓存；没配 M2M 凭证时为 null */
const logtoClient = env.logtoManagement === null ? null : createLogtoManagementClient(env.logtoManagement);

/** 进程内的注销票据库；只放内存，和限流计数一样基于单实例部署，重启后用户重新验证即可 */
const ticketStore = new AccountDeletionTicketStore();

/**
 * 校验用户给出的身份凭据（密码、邮箱验证码或重新登录的 ID token），通过后签发 10 分钟有效的注销票据。
 *
 * @throws 400 IDENTITY_VERIFICATION_FAILED：没通过，details.reason 说明原因
 * @throws 502 IDENTITY_VERIFICATION_UNAVAILABLE：调 Logto 失败，可重试
 * @throws 503 SERVICE_NOT_CONFIGURED：Logto M2M 没配，或用 ID token 验证但 LOGTO_APP_IDS 为空
 */
export function verifyAccountIdentity(userId: string, proof: IdentityProof): Promise<IIssuedTicket> {
  return verifyIdentity(userId, proof, {
    logto: logtoClient,
    logtoAppIds: env.logtoAppIds,
    verifyIdToken: verifyLogtoIdToken,
    ticketStore,
    now: Date.now,
  });
}

/**
 * 给用户在 Logto 里的主邮箱发一封验证码邮件，供「邮箱验证码」验证方式使用。
 *
 * @throws 400 IDENTITY_VERIFICATION_FAILED：账号没有主邮箱（reason 为 email_unavailable）
 * @throws 502 IDENTITY_VERIFICATION_UNAVAILABLE：调 Logto 失败，可重试
 * @throws 503 SERVICE_NOT_CONFIGURED：Logto M2M 没配
 */
export function sendAccountVerificationCode(userId: string): Promise<void> {
  return sendDeletionEmailCode(userId, { logto: logtoClient });
}

/**
 * 注销前汇总各产品的数据量：并行调各下游的只读汇总接口，某个下游失败只标那一项，不抛错。
 * 没配置下游服务时返回空列表，不报 503（汇总只是给用户看的参考，真正注销时才要求配置齐全）。
 */
export function getAccountSummary(userId: string): Promise<IAccountSummary> {
  return collectAccountSummary(env.accountDeletionServices, userId);
}

/**
 * 注销账号：删除用户在 hub 与各下游服务的全部数据，最后删除 Logto 用户。可重复调用。
 *
 * 必须带注销前验证身份换到的票据；只有开发态免鉴权（生产环境强制关闭）的假用户跳过这项检查。
 * 票据只在全部步骤成功后作废，中途失败时在有效期内可以拿同一张票据重试。
 *
 * @param ticket 请求头 X-Account-Deletion-Ticket 的值，没带时为 undefined
 * @throws 426 APP_UPGRADE_REQUIRED：没带票据（旧版 App）
 * @throws 403 ACCOUNT_VERIFICATION_REQUIRED：票据无效、已过期或不属于当前用户
 * @throws 503 SERVICE_NOT_CONFIGURED：缺 Logto 凭证或下游服务列表，此时什么都没动
 * @throws 502 ACCOUNT_DELETION_FAILED：某个下游服务或 Logto 失败，前面的步骤已完成，重试即可
 * @throws 数据库错误：写注销名单、删反馈或删联动授权失败，交给全局 handleError 返回 500
 */
export async function deleteAccount(userId: string, ticket: string | undefined): Promise<void> {
  if (!env.isDevAuthBypassEnabled) {
    ticketStore.require(userId, ticket);
  }
  const plan = resolveAccountDeletionPlan({
    services: env.accountDeletionServices,
    isLogtoConfigured: logtoClient !== null,
    isDevAuthBypassEnabled: env.isDevAuthBypassEnabled,
  });
  await deleteAccountEverywhere(userId, plan, {
    markUserDeleted,
    deleteFeedback: deleteUserFeedbackData,
    deleteDataLinks: deleteUserDataLinks,
    deleteFromService: (service, id) => deleteUserFromService(service, id),
    deleteLogtoUser: async (id) => {
      // resolveAccountDeletionPlan 已保证要删 Logto 用户时客户端存在，这里只是让类型收窄
      if (logtoClient === null) {
        throw serviceNotConfigured();
      }
      await logtoClient.deleteUser(id);
    },
    markCompleted: markUserDeletionCompleted,
  });
  // 失败时上面已经抛出，走不到这里，票据保留供重试；全部成功后才作废
  ticketStore.consume(userId);
}

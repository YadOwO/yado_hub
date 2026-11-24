/**
 * 注销账号：把 deletion.ts 的编排接上配置、数据库、下游服务与 Logto。
 *
 * 本模块汇总各功能的用户数据删除，所以可以引用各功能的 service；hub 自己目前只有意见反馈。
 */
import { env } from '../../config/env.js';
import { markUserDeleted, markUserDeletionCompleted } from '../../shared/deleted-users.js';
import { serviceNotConfigured } from '../../shared/errors.js';
import { createLogtoManagementClient } from '../../shared/logto-management.js';
import { deleteUserFeedbackData } from '../feedback/service.js';
import { deleteAccountEverywhere, deleteUserFromService, resolveAccountDeletionPlan } from './deletion.js';

/** 进程内复用的 Logto Management API 客户端，共享 M2M token 缓存；没配 M2M 凭证时为 null */
const logtoClient = env.logtoManagement === null ? null : createLogtoManagementClient(env.logtoManagement);

/**
 * 注销账号：删除用户在 hub 与各下游服务的全部数据，最后删除 Logto 用户。可重复调用。
 *
 * @throws 503 SERVICE_NOT_CONFIGURED：缺 Logto 凭证或下游服务列表，此时什么都没动
 * @throws 502 ACCOUNT_DELETION_FAILED：某个下游服务或 Logto 失败，前面的步骤已完成，重试即可
 * @throws 数据库错误：写注销名单或删反馈失败，交给全局 handleError 返回 500
 */
export async function deleteAccount(userId: string): Promise<void> {
  const plan = resolveAccountDeletionPlan({
    services: env.accountDeletionServices,
    isLogtoConfigured: logtoClient !== null,
    isDevAuthBypassEnabled: env.isDevAuthBypassEnabled,
  });
  await deleteAccountEverywhere(userId, plan, {
    markUserDeleted,
    deleteFeedback: deleteUserFeedbackData,
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
}

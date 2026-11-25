/**
 * 逗号分隔配置的拆分。
 *
 * 本文件必须保持无副作用，也不能 import config/env.ts：
 * account-deletion.ts 的单元测试会间接引用它，测试不能依赖环境变量。
 */

/** 把逗号分隔的配置拆成列表，去掉每项首尾空白并丢弃空项 */
export function splitCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

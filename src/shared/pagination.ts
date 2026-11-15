/** 一页数据与下一页游标 */
export interface IPage<T> {
  items: T[];
  /** 下一页的 before 游标；没有更多时为 null */
  nextBefore: number | null;
}

/**
 * 把多查一条的结果切成一页：查询时 limit + 1，多出来的那条说明还有下一页。
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => number): IPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextBefore: hasMore && last !== undefined ? cursorOf(last) : null };
}

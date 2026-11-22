/**
 * 从 Authorization 头取出 Bearer 后面的凭证，并去掉首尾空白。
 *
 * 头不存在、或不是以 `bearer `（不区分大小写）开头时返回 null；
 * 返回值可能是空字符串，由调用方决定怎么报错。
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  return header.slice('bearer '.length).trim();
}

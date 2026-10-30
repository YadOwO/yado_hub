/**
 * 已接入本服务的产品。
 *
 * 新产品接入只需在 PRODUCT_CODES 中加一项；接口路径里的 {product} 只接受这里登记的代号。
 */

/** 产品代号，与 yado_ai 等服务保持一致 */
export const PRODUCT_CODES = ['yadoa', 'yadoi'] as const;

/** 产品代号 */
export type ProductCode = (typeof PRODUCT_CODES)[number];

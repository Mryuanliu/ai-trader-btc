import { createHmac } from 'crypto';

/** 币安风格签名：对排序后的 query string 做 HMAC-SHA256 */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** OKX 风格签名：对 (timestamp + method + path + body) 做 HMAC-SHA256 后 base64 */
export function hmacSha256Base64(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64');
}

export function buildQuery(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

/** OKX ISO8601 时间戳，毫秒精度 */
export function okxTimestamp(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1Z');
}

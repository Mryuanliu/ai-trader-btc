/**
 * 环境变量经 Joi 转换后布尔项会变成真正的 boolean，
 * 因此统一用该函数判断开关，避免 `value === 'true'` 失效。
 */
export function isTruthy(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return defaultValue;
}

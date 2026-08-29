import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Agent } from 'node:http';

/**
 * 统一代理出口：解析 HTTPS_PROXY / HTTP_PROXY / NO_PROXY，
 * 供 axios 的 httpsAgent 与 ws 的 agent 共用。
 *
 * 未配置代理时返回 undefined，调用方自然退化为直连，无回归风险。
 *
 * 注意：环境变量由 @nestjs/config 在应用初始化阶段注入 process.env，
 * 而本模块可能在注入完成前被 import，因此这里一律延迟到首次调用时才解析。
 */

interface ProxyConfig {
  url: string;
  noProxy: string[];
}

let configCache: ProxyConfig | null = null;
let agentCache: Agent | undefined;
let agentResolved = false;

function readConfig(): ProxyConfig {
  if (configCache) return configCache;
  configCache = {
    url:
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      '',
    noProxy: (process.env.NO_PROXY || process.env.no_proxy || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
  return configCache;
}

/** 测试与诊断用：强制丢弃缓存 */
export function resetProxyCache() {
  configCache = null;
  agentCache = undefined;
  agentResolved = false;
}

/** 当前生效的代理地址（未配置则为空串） */
export function getProxyUrl(): string {
  return readConfig().url;
}

/** 目标主机是否应绕过代理 */
export function shouldBypassProxy(host: string): boolean {
  const { url, noProxy } = readConfig();
  if (!url) return true;
  const target = host.toLowerCase();
  return noProxy.some((rule) => {
    if (rule === '*') return true;
    const bare = rule.replace(/^\./, '');
    return target === bare || target.endsWith(`.${bare}`);
  });
}

/**
 * 取（并缓存）代理 Agent。
 * 每次请求新建 Agent 会带来重复的 CONNECT 握手开销，故全局复用同一实例。
 */
export function getProxyAgent(): Agent | undefined {
  if (agentResolved) return agentCache;
  agentResolved = true;
  const { url } = readConfig();
  if (!url) {
    agentCache = undefined;
    return agentCache;
  }
  try {
    agentCache = new HttpsProxyAgent(url) as unknown as Agent;
  } catch (err) {
    // 代理地址非法时退化为直连，避免整个服务起不来
    // eslint-disable-next-line no-console
    console.error(`[proxy] 代理地址无效，已退化为直连: ${(err as Error).message}`);
    agentCache = undefined;
  }
  return agentCache;
}

/** 构造 axios 传输层配置：命中 NO_PROXY 时不挂代理 */
export function axiosTransport(host: string): {
  httpsAgent?: Agent;
  httpAgent?: Agent;
  proxy: false;
} {
  if (shouldBypassProxy(host)) return { proxy: false };
  const agent = getProxyAgent();
  return agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : { proxy: false };
}

/** 构造 ws 客户端配置 */
export function wsAgent(host: string): { agent?: Agent } {
  if (shouldBypassProxy(host)) return {};
  const agent = getProxyAgent();
  return agent ? { agent } : {};
}

/** 启动日志用的可读描述（隐藏代理密码） */
export function describeProxy(): string {
  const { url, noProxy } = readConfig();
  if (!url) return '未配置代理（直连）';
  const masked = url.replace(/\/\/([^@]+)@/, '//***@');
  return `已启用代理 ${masked}${noProxy.length ? `，绕过 ${noProxy.join(', ')}` : ''}`;
}

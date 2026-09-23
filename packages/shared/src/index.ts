// 基础类型
export * from './types/common';
export * from './types/market';
export * from './types/order';
export * from './types/futures';
export * from './types/news';
// 纯函数能力
export * from './order-normalizer';
export * from './position';
export * from './indicators/core';
// 前后端共用 DTO
export * from './dto/api';

// 已移除（2026-09-23 策略托管改造）：
// - ./strategy/*、./decision-diagnostics、./indicators/signals、./analysis/ic
//   —— 旧决策内核（信号合成 / 策略插件 / 诊断归因）
// - ./types/market-executor —— 跨市场执行器抽象，唯一消费者是被删的决策引擎
// - ./types/exit-rules、./types/agent —— 决策链路的出场规则与决策记录类型

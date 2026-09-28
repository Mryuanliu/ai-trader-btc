/**
 * pm2 进程守护配置 —— 仅用于「生产/常驻」跑后端编译产物（node dist/main）。
 *
 * 定位：解决的是**进程真崩溃（未捕获异常 / OOM / 被 kill）后无人值守拉起 + 开机自启**，
 * 属于运维层守护。它**不处理**「网络抖动导致 hedge 切换失败」——那类是策略启动返回
 * {ok:false} 的优雅失败，进程没退出，pm2 无从介入；那条路径由代码里的
 * `FuturesTradingService.ensureHedgeMode()` 退避重试负责。
 *
 * 用法（pm2 需全局装一次：`npm i -g pm2`）：
 *   pnpm build                       # 先产出 apps/server/dist
 *   pnpm start:pm2                   # pm2 start ecosystem.config.js
 *   pnpm pm2:logs / pm2:status / pm2:restart / pm2:stop
 *   pm2 save && pm2 startup          # 固化进程列表 + 开机自启（startup 会打印一条需 sudo 的命令）
 *
 * ⚠️ 别和开发用的 `nest start --watch` 同时跑：两者都抢 3001 端口。常驻只走 pm2。
 */
module.exports = {
  apps: [
    {
      name: 'ai-trader-server',
      cwd: './apps/server',
      script: 'dist/main.js',
      node_args: '--enable-source-maps', // 报错栈映射回 TS 源码行，便于排障
      env: {
        NODE_ENV: 'production',
        // PORT / HTTPS_PROXY / 数据库等都由 apps/server 启动时读仓库根 .env，这里不重复注入。
      },

      // —— 崩溃自愈，但防「重启风暴」——
      autorestart: true,
      exp_backoff_restart_delay: 200, // 重启间隔指数退避 200→400→…→15000ms
      min_uptime: '15s', // 存活不足 15s 判定为失败重启，计入 max_restarts
      max_restarts: 10, // 连续失败达上限后 pm2 停止拉起（需人工介入），避免无脑刷

      // —— 内存兜底：泄漏拖垮机器前主动重启（合约 WS + K 线缓存，给足余量）——
      max_memory_restart: '700M',

      // —— 优雅停机：留时间平仓收尾/关 WS，别 SIGKILL 太急 ——
      kill_timeout: 8000,

      // —— 日志（logs/ 已在 .gitignore）——
      out_file: './logs/pm2-server.out.log',
      error_file: './logs/pm2-server.err.log',
      merge_logs: true,
      time: true, // 每行日志前加时间戳
    },
  ],
};

/**
 * 飞书推送 smoke test:绕过事件总线与 FeishuService,直接用 axios 走一次
 * 「取 tenant_access_token + 发交互卡片」的两步 REST,验证
 * FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID 三件套是否配对且能真送达。
 *
 * 用法:
 *   cd apps/server
 *   npx ts-node scripts/feishu-smoke-test.ts
 */
import * as dotenv from 'dotenv';
import { join } from 'path';
import axios from 'axios';

dotenv.config({ path: join(__dirname, '../../../.env') });
dotenv.config({ path: join(__dirname, '../../../.env.local') });

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const chatId = process.env.FEISHU_CHAT_ID;

if (!appId || !appSecret || !chatId) {
  console.error('缺少环境变量:FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID 需全部设置');
  process.exit(1);
}

// proxy:false 让 axios 无视 HTTP_PROXY/HTTPS_PROXY(为访问币安而设),飞书直连即可
const http = axios.create({ proxy: false, timeout: 10_000 });

(async () => {
  try {
    const tokenRes = await http.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: appId, app_secret: appSecret },
    );
    const tokenData = tokenRes.data;
    if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
      console.error('取 tenant_access_token 失败:', tokenData);
      process.exit(2);
    }
    console.log('tenant_access_token OK,expire =', tokenData.expire);

    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'markdown',
          content: [
            '【测试推送】AI-Trader 飞书集成自检',
            `时间:${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
            `chat_id:${chatId}`,
            '如收到此卡片,说明 APP_ID/SECRET/CHAT_ID 三件套配置正确。',
          ].join('\n'),
        },
      ],
    });
    const sendRes = await http.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content },
      {
        headers: {
          Authorization: `Bearer ${tokenData.tenant_access_token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
    const sendData = sendRes.data;
    if (sendData.code && sendData.code !== 0) {
      console.error('发送失败:', sendData.code, sendData.msg, sendData);
      process.exit(3);
    }
    console.log('发送成功:message_id =', sendData?.data?.message_id);
  } catch (err: any) {
    console.error('异常:', err?.message, err?.response?.data ?? '');
    process.exit(4);
  }
})();

# 币安开发者文档 · 本地速查

> 从币安官方 `https://developers.binance.com/zh-CN/docs/llms.txt` 下载的 API 参考，
> 供本项目（合约/现货接入）开发时离线查阅。数据抓取时间：2026-08-30。
>
> 抓取方式（本机 Clash 代理 7897）：
> ```bash
> export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897
> curl -sSL https://developers.binance.com/zh-CN/docs/llms.txt -o docs/binance-api/llms-catalog.md
> ```

## 文件清单

| 文件 | 内容 |
|---|---|
| `llms-catalog.md` | 官方全量 API 目录索引（167KB），含所有产品线的接口清单，可 grep 定位接口 |
| `fapi-endpoints.txt` | U 本位合约（USDⓈ-M）全部 99 个 REST 接口清单（含方法/路径/中文说明） |
| `usds-futures-general-info.md` | U 本位合约通用信息：域名、Testnet/demo、签名方式、下单示例、错误码、限频 |
| `README.md` | 本文档（速查索引 + 关键结论） |

## 关键结论（已核实）

### U 本位合约环境域名

| 环境 | REST baseurl | WebSocket baseurl |
|---|---|---|
| 正式网（主网） | `https://fapi.binance.com` | `wss://fstream.binance.com` |
| **Testnet / demo** | **`https://demo-fapi.binance.com`** | **`wss://demo-fstream.binance.com`** |

> 官方把 U 本位合约的测试环境 REST baseurl 直接命名为 `demo-fapi.binance.com`，
> 即"合约 demo"与"合约 testnet"是同一个环境。本项目合约统一走这个 demo 域名。
> 对比现货：现货 demo（`demo-api.binance.com`）与 testnet（`testnet.binance.vision`）是两个不同环境。

### 合约测试网要点
- 用 GitHub 账号在 `https://testnet.binance.vision` 登录生成**独立 API key**（与现货 key 不通用）
- 虚拟资金，能真实下单、占用保证金、触发强平
- 已确认币安社区 2026-06 曾出现 `-1109 Invalid account` 后端故障（非客户端问题），已恢复/换账号可解

## U 本位合约核心接口速查（`demo-fapi.binance.com`）

### 行情（无需签名）
| 接口 | 说明 |
|---|---|
| `GET /fapi/v1/time` | 服务器时间 |
| `GET /fapi/v1/klines` | K 线（与现货行格式一致） |
| `GET /fapi/v1/premiumIndex` | 最新标记价格 + 资金费率 |
| `GET /fapi/v1/fundingRate` | 资金费率历史 |
| `GET /fapi/v1/exchangeInfo` | 交易规则与交易对（含 filters） |
| `GET /fapi/v1/leverageBracket` | 杠杆分层标准 |

### 账户（需签名，USER_DATA）
| 接口 | 说明 |
|---|---|
| `GET /fapi/v2/balance` / `v3` | 账户余额 |
| `GET /fapi/v2/account` / `v3` | 账户信息 |
| `GET /fapi/v2/positionRisk` / `v3` | **持仓风险（强平价/保证金/未实现盈亏）** |
| `GET /fapi/v1/income` | 账户损益流水（含资金费） |
| `GET /fapi/v1/userTrades` | 账户成交历史 |

### 交易（需签名，TRADE）
| 接口 | 说明 |
|---|---|
| `POST /fapi/v1/order` | 下单（市价/限价） |
| `GET /fapi/v1/order` | 查订单 |
| `DELETE /fapi/v1/order` | 撤单 |
| `GET /fapi/v1/openOrders` | 当前挂单 |
| `POST /fapi/v1/leverage` | **设置开仓杠杆** |
| `POST /fapi/v1/marginType` | **切换逐仓/全仓** |
| `GET /fapi/v1/positionSide/dual` | 查询持仓模式（单向/双向） |

### 下单关键参数
- `symbol`、`side`(BUY/SELL)、`type`(MARKET/LIMIT/STOP/TAKE_PROFIT…)、`quantity` 必填
- 限价单需 `price` + `timeInForce`(GTC/IOC/FOK/GTX)
- 合约特有：`positionSide`(LONG/SHORT/BOTH)、`reduceOnly`(只减仓)、`newClientOrderId`(自定义ID)
- 签名：HMAC-SHA256，`X-MBX-APIKEY` 头 + `signature` 参数（与现货同款，项目已有 `signature.ts` 复用）
- 限频：下单另有 `rateLimit/order` 权重限制，注意批量下单

## 注意
- 本目录为**参考快照**，币安接口可能有演进，重大改动以官网为准；可随时用上面的 curl 重新抓取刷新
- 涉及密钥/签名的示例仅为格式参考，切勿照抄示例里的密钥

# 基本信息

## Rest 基本信息

- 接口可能需要用户的 API
  Key，如何创建API-KEY请参考[这里](https://www.binance.com/cn/support/articles/360002502072)
- 本篇列出REST接口的baseurl **https://fapi.binance.com**
- 所有接口的响应都是JSON格式
- 响应中如有数组，数组元素以时间升序排列，越早的数据越提前。
- 所有时间、时间戳均为UNIX时间，单位为毫秒
- 所有数据类型采用JAVA的数据类型定义

### Testnet API 信息

- 本篇接口亦可接入testnet测试平台使用
- **testnet**的 REST baseurl 为 "https://demo-fapi.binance.com"
- **testnet**的 Websocket baseurl 为 "wss://demo-fstream.binance.com"

---

## 接口的基本信息

- `GET`方法的接口, 参数必须在`query string`中发送.
- `POST`, `PUT`, 和 `DELETE` 方法的接口, 参数可以在 `query string`中发送，也可以在
  `request body`中发送(content type
  `application/x-www-form-urlencoded`)。允许混合这两种方式发送参数。但如果同一个参数名在query
  string和request body中都有，query string中的会被优先采用。
- 对参数的顺序不做要求。

### HTTP 返回代码

- HTTP `4XX` 错误码用于指示错误的请求内容、行为、格式。
- HTTP `403` 错误码表示违反WAF限制(Web应用程序防火墙)。
- HTTP `408` 返回代码表示在等待后端服务器响应时发生了超时。
- HTTP `429` 错误码表示警告访问频次超限，即将被封IP
- HTTP `418` 表示收到429后继续访问，于是被封了。
- HTTP `5XX` 错误码用于指示Binance服务侧的问题。
  1. 如果返回内容里包含了报错信息 **"Request occur unknown error."**，请稍后重试请求。
- HTTP `503` 表示三种可能：
  1. 如果返回内容里包含了报错信息 **"Unknown error, please check your request or try again
     later."**，则表示API服务端已经向业务核心提交了请求但未能获取响应，特别需要注意的是其不代表请求失败，而是未知。很可能已经得到了执行，也有可能执行失败，需要做进一步确认。
  2. 如果返回内容里包含了报错信息 **"Service
     Unavailable."**，则表示本次API请求失败。这种情况下可能是服务暂不可用，您需要稍后重试。
  3. 如果返回内容里包含了报错信息 **"Internal error; unable to process your request. Please try
     again."**，则表示本次API请求失败。这种情况下您如果需要的话可以选择立即重试。
  4. 如果返回内容里包含了报错信息 **"Request throttled by system-level protection.
     Reduce-only/close-position orders are exempt. Please try
     again.(-1008)"**。这表示节点已超出最大并发限制，正在临时限流。平仓、仅减仓与取消订单均予以豁免，不会触发该错误。

### HTTP 503 状态码：错误类型与处理

#### A. “Unknown error, please check your request or try again later.”（执行状态未知）

- **语义**：API 成功接收请求，但在超时前未返回结果；**执行状态未知（可能已成功）**。
- **处理**：
  - **不要直接当失败重试**；先通过 **WebSocket 回报**或
    **orderId 查询**确认是否已执行，避免重复下单。
  - 高峰期尽量使用**单笔下单**替代批量下单以降低不确定性。
- **是否计入限速**：**可能计入，也可能不计入**, 请参考header中的rate计数信息

#### B. “Service Unavailable.”（失败）

- **语义**：服务暂不可用；**100% 失败**。
- **处理**：**退避重试**（如 200ms → 400ms → 800ms，上限 3–5 次）。
- **是否计入限速**：**不计入**

#### C. "Request throttled by system-level protection. Reduce-only/close-position orders are exempt. Please try again."（**-1008**，失败）

- **语义**：系统过载；**100% 失败**。
- **处理**：**退避重试**并**降低并发**；
- **适用接口**：
  - `POST /fapi/v1/order`
  - `POST /fapi/v1/batchOrders`
  - `POST /fapi/v1/order/test`
- **仅适用于 C 的豁免说明**：当请求满足**只减仓/平仓**条件时（`closePosition = true`，或
  `positionSide = BOTH` 且 `reduceOnly = true`，或 `LONG+SELL`，或
  `SHORT+BUY`），**不会受 -1008 过载的影响或享有优先处理**，以保障风险收敛。
  - 覆盖接口：`POST /fapi/v1/order`、`POST /fapi/v1/batchOrders`（当参数满足只减仓/平仓判定）

### 接口错误代码

- 每个接口都有可能抛出异常

> 异常响应格式如下：

```javascript
{
  "code": -1121,
  "msg": "Invalid symbol."
}
```

- 具体的错误码及其解释在[错误代码](#cf68bca02a)

---

## SDK和代码示例

**免责声明:**

- 以下SDK由合作方和用户提供，**非官方制作**行为。仅做熟悉api接口和学习使用，请广大用户谨慎使用并根据自身情况自行拓展研发。
- Binance 官方不对SDK的安全和性能做任何承诺，亦不会对使用SDK引起的风险甚至损失承担责任。

### Python3

**SDK:** 可以通过以下方式获取Binance Futures Connector SDK：

- 访问
  [https://github.com/binance/binance-connector-python](https://github.com/binance/binance-connector-python)

- 执行以下命令： `pip install binance-sdk-derivatives-trading-usds-futures`

### Java

可以通过以下方式获取SDK：

- 访问
  [https://github.com/binance/binance-connector-java](https://github.com/binance/binance-connector-java),

- 执行以下命令： `git clone https://github.com/binance/binance-connector-java.git`

---

## 访问限制

- 在
  `/fapi/v1/exchangeInfo`接口中`rateLimits`数组里包含有REST接口(不限于本篇的REST接口)的访问限制。包括带权重的访问频次限制、下单速率限制。本篇`枚举定义`章节有限制类型的进一步说明。
- 违反上述任何一个访问限制都会收到HTTP 429，这是一个警告.

<aside class="notice">
请注意，若用户被认定利用频繁挂撤单且故意低效交易意图发起攻击行为，Binance有权视具体情况进一步加强对其访问限制。
</aside>

### IP 访问限制

- 每个请求将包含一个`X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)`的头，其中包含当前IP所有请求的已使用权重。
- 每个路由都有一个"权重"，该权重确定每个接口计数的请求数。较重的接口和对多个交易对进行操作的接口将具有较重的"权重"。
- 收到429时，您有责任作为API退回而不向其发送更多的请求。
- **如果屡次违反速率限制和/或在收到429后未能退回，将导致API的IP被禁(http状态418)。**
- 频繁违反限制，封禁时间会逐渐延长 ，**对于重复违反者，将会被封从2分钟到3天**。
- **访问限制是基于IP的，而不是API Key**

<aside class="notice">
强烈建议您尽可能多地使用websocket消息获取相应数据,既可以保障消息的及时性，也可以减少请求带来的访问限制压力。
</aside>

### 下单频率限制

- 每个下单请求回报将包含一个`X-MBX-ORDER-COUNT-(intervalNum)(intervalLetter)`的头，其中包含当前账户已用的下单限制数量。
- 被拒绝或不成功的下单并不保证回报中包含以上头内容。
- **下单频率限制是基于每个账户计数的。**

## 接口鉴权类型

- 每个接口都有自己的鉴权类型，鉴权类型决定了访问时应当进行何种鉴权
- 如果需要 API-key，应当在HTTP头中以`X-MBX-APIKEY`字段传递
- API-key 与 API-secret 是大小写敏感的
- 可以在网页用户中心修改API-key 所具有的权限，例如读取账户信息、发送交易指令、发送提现指令

| 鉴权类型    | 描述                    |
| ----------- | ----------------------- |
| NONE        | 不需要鉴权的接口        |
| TRADE       | 需要有效的API-KEY和签名 |
| USER_DATA   | 需要有效的API-KEY和签名 |
| USER_STREAM | 需要有效的API-KEY       |
| MARKET_DATA | 需要有效的API-KEY       |

### 需要签名的接口 (TRADE 与 USER_DATA)

- 调用这些接口时，除了接口本身所需的参数外，还需要传递`signature`即签名参数。
- 签名使用`HMAC SHA256`算法. API-KEY所对应的API-Secret作为 `HMAC SHA256`
  的密钥，其他所有参数作为`HMAC SHA256`的操作对象，得到的输出即为签名。
- 签名大小写不敏感。
- 请确保`signature`在`query string`或`request body`的最后
- 当同时使用query string和request body时，`HMAC SHA256`的输入query string在前，request body在后

### 时间同步安全

- 签名接口均需要传递`timestamp`参数, 其值应当是请求发送时刻的unix时间戳(毫秒)
- 服务器收到请求时会判断请求中的时间戳，如果是5000毫秒之前发出的，则请求会被认为无效。这个时间窗口值可以通过发送可选参数`recvWindow`来自定义。
- 另外，如果服务器计算得出客户端时间戳在服务器时间的‘未来’一秒以上，也会拒绝请求。

> 逻辑伪代码：

```javascript
if (timestamp < serverTime + 1000 && serverTime - timestamp <= recvWindow) {
  // process request
} else {
  // reject request
}
```

**关于交易时效性**
互联网状况并不100%可靠，不可完全依赖,因此你的程序本地到币安服务器的时延会有抖动. 这是我们设置`recvWindow`的目的所在，如果你从事高频交易，对交易时效性有较高的要求，可以灵活设置recvWindow以达到你的要求。

<aside class="notice">
不推荐使用5秒以上的recvWindow
</aside>

### POST /fapi/v1/order 的示例 - HMAC Keys

以下是在linux bash环境下使用 echo
openssl 和curl工具实现的一个调用接口下单的示例apikey、secret仅供示范

| Key       | Value                                                            |
| --------- | ---------------------------------------------------------------- |
| apiKey    | dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83 |
| secretKey | 2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9 |

| 参数        | 取值          |
| ----------- | ------------- |
| symbol      | BTCUSDT       |
| side        | BUY           |
| type        | LIMIT         |
| timeInForce | GTC           |
| quantity    | 1             |
| price       | 9000          |
| recvWindow  | 5000          |
| timestamp   | 1591702613943 |

#### 示例 1: 所有参数通过 query string 发送

> **示例1:**

> **HMAC SHA256 签名:**

```shell
    $ echo -n "symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943" | openssl dgst -sha256 -hmac "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9"
    (stdin)= 3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9
```

> **curl 调用:**

```shell
    (HMAC SHA256)
    $ curl -H "X-MBX-APIKEY: dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83" -X POST 'https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943&signature= 3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9'
```

- **queryString:**

  symbol=BTCUSDT  
  &side=BUY  
  &type=LIMIT  
  &timeInForce=GTC  
  &quantity=1  
  &price=0.1  
  &recvWindow=5000  
  &timestamp=1499827319559

#### 示例 2: 所有参数通过 request body 发送

> **示例2:**

> **HMAC SHA256 签名:**

```shell
    $ echo -n "symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943" | openssl dgst -sha256 -hmac "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9"
    (stdin)= 3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9
```

> **curl 调用:**

```shell
    (HMAC SHA256)
    $ curl -H "X-MBX-APIKEY: dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83" -X POST 'https://fapi.binance.com/fapi/v1/order' -d 'symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943&signature= 3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9'
```

- **requestBody:**

  symbol=BTCUSDT  
  &side=BUY  
  &type=LIMIT  
  &timeInForce=GTC  
  &quantity=1  
  &price=9000  
  &recvWindow=5000  
  &timestamp=1591702613943

#### 示例 3: 混合使用 query string 与 request body

> **示例3:**

> **HMAC SHA256 签名:**

```shell
    $ echo -n "symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTCquantity=1&price=9000&recvWindow=5000&timestamp= 1591702613943" | openssl dgst -sha256 -hmac "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9"
    (stdin)= f9d0ae5e813ef6ccf15c2b5a434047a0181cb5a342b903b367ca6d27a66e36f2
```

> **curl 调用:**

```shell
    (HMAC SHA256)
    $ curl -H "X-MBX-APIKEY: dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83" -X POST 'https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC' -d 'quantity=1&price=9000&recvWindow=5000&timestamp=1591702613943&signature=f9d0ae5e813ef6ccf15c2b5a434047a0181cb5a342b903b367ca6d27a66e36f2'
```

- **queryString:** symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC
- **requestBody:** quantity=1&price=9000&recvWindow=5000&timestamp= 1591702613943

请注意，示例3中的签名有些许不同，在"GTC"和"quantity=1"之间**没有**"&"字符。

### POST /fapi/v1/order 的示例 - RSA Keys

- 这将逐步介绍如何通过有效的签名发送 payload。
- 我们接受 `PKCS#8` 格式的 RSA Key。
- 要获取 API Key，您需要在您的账户上上传您的 RSA Public Key。

对于这个例子，Private Key 将被引用为`test-prv-key.pem`。

| Key    | Value                                                            |
| ------ | ---------------------------------------------------------------- |
| apiKey | vE3BDAL1gP1UaexugRLtteaAHg3UO8Nza20uexEuW1Kh3tVwQfFHdAiyjjY428o2 |

| 参数       | 取值          |
| ---------- | ------------- |
| symbol     | BTCUSDT       |
| side       | SELL          |
| type       | MARKET        |
| quantity   | 1.23          |
| recvWindow | 9999999       |
| timestamp  | 1671090801999 |

> **有列出参数的签名 payload：**

```console
timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23
```

**第1步: Payload**

将参数列表排列成一个 string。 用 `&` 分隔每个参数。对于上述参数，签名 payload 如右所示。

**第2步: 计算签名**

2.1 - 将签名有效负载编码为 ASCII 数据。

> **第2.2步**

```console
 $ echo -n 'timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23' | openssl dgst -keyform PEM -sha256 -sign ./test-prv-key.pem
```

2.2 - 使用带有 SHA-256 hash 函数的 RSASSA-PKCS1-v1_5 算法对 payload 进行签名。

> **第2.3步**

```console
$ echo -n 'timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23' | openssl dgst -keyform PEM -sha256 -sign ./test-prv-key.pem | openssl enc -base64
aap36wD5loVXizxvvPI3wz9Cjqwmb3KVbxoym0XeWG1jZq8umqrnSk8H8dkLQeySjgVY91Ufs%2BBGCW%2B4sZjQEpgAfjM76riNxjlD3coGGEsPsT2lG39R%2F1q72zpDs8pYcQ4A692NgHO1zXcgScTGgdkjp%2Brp2bcddKjyz5XBrBM%3D
```

2.3 - 将输出编码为 base64 string。

> **第2.4步**

```console
$  echo -n 'timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23' | openssl dgst -keyform PEM -sha256 -sign ./test-prv-key.pem | openssl enc -base64 | tr -d '\n'
aap36wD5loVXizxvvPI3wz9Cjqwmb3KVbxoym0XeWG1jZq8umqrnSk8H8dkLQeySjgVY91Ufs%2BBGCW%2B4sZjQEpgAfjM76riNxjlD3coGGEsPsT2lG39R%2F1q72zpDs8pYcQ4A692NgHO1zXcgScTGgdkjp%2Brp2bcddKjyz5XBrBM%3D
```

2.4 - 删除签名中的所有 `\n`。

> **第2.5步**

```console
aap36wD5loVXizxvvPI3wz9Cjqwmb3KVbxoym0XeWG1jZq8umqrnSk8H8dkLQeySjgVY91Ufs%2BBGCW%2B4sZjQEpgAfjM76riNxjlD3coGGEsPsT2lG39R%2F1q72zpDs8pYcQ4A692NgHO1zXcgScTGgdkjp%2Brp2bcddKjyz5XBrBM%3D
```

2.5 - 由于签名可能包含 `/` 和 `=`，这可能会导致发送请求时出现问题。 所以签名必须是 URL 编码的。

> **第2.6步**

```console
 curl -H "X-MBX-APIKEY: vE3BDAL1gP1UaexugRLtteaAHg3UO8Nza20uexEuW1Kh3tVwQfFHdAiyjjY428o2" -X POST 'https://fapi.binance.com/fapi/v1/order?timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23&signature=aap36wD5loVXizxvvPI3wz9Cjqwmb3KVbxoym0XeWG1jZq8umqrnSk8H8dkLQeySjgVY91Ufs%2BBGCW%2B4sZjQEpgAfjM76riNxjlD3coGGEsPsT2lG39R%2F1q72zpDs8pYcQ4A692NgHO1zXcgScTGgdkjp%2Brp2bcddKjyz5XBrBM%3D'
```

2.6 - curl 命令

> **Bash 脚本**

```bash
#!/usr/bin/env bash
# 设置身份验证：
apiKey="vE3BDAL1gP1UaexugRLtteaAHg3UO8Nza20uexEuW1Kh3tVwQfFHdAiyjjY428o2"   ### 替换成您的 API Key
# 设置您的请求:
apiMethod="POST"
apiCall="v1/order"
apiParams="timestamp=1671090801999&recvWindow=9999999&symbol=BTCUSDT&side=SELL&type=MARKET&quantity=1.23"
function rawurlencode {
    local value="$1"
    local len=${#value}
    local encoded=""
    local pos c o
    for (( pos=0 ; pos<len ; pos++ ))
    do
        c=${value:$pos:1}
        case "$c" in
            [-_.~a-zA-Z0-9] ) o="${c}" ;;
            * )   printf -v o '%%%02x' "'$c"
        esac
        encoded+="$o"
    done
    echo "$encoded"
}
ts=$(date +%s000)
paramsWithTs="$apiParams&timestamp=$ts"
rawSignature=$(echo -n "$paramsWithTs" \
               | openssl dgst -keyform PEM -sha256 -sign ./test-prv-key.pem \  ### 替换成您的 Private Key。不要与任何人共享此文件。
               | openssl enc -base64 \
               | tr -d '\n')
signature=$(rawurlencode "$rawSignature")
curl -H "X-MBX-APIKEY: $apiKey" -X $apiMethod \
    "https://fapi.binance.com/fapi/$apiCall?$paramsWithTs&signature=$signature"
```

右边有示例 Bash 脚本执行上述类似的步骤.

## Postman 收藏

现在有一个包含 API 端点的 Postman 集合，方便快速使用。

更多信息请参阅此页面: [Binance API Postman](https://github.com/binance-exchange/binance-api-postman)

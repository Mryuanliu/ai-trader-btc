//+------------------------------------------------------------------+
//|                                       金麒麟源流改良版.mq5        |
//|                              双向网格马丁策略 · 挂单版             |
//|                              基于"新金麒麟AI云"MQ4原版100%复刻     |
//+------------------------------------------------------------------+
#property copyright "金麒麟源流改良版"
#property link      ""
#property description "金麒麟源流改良版 — 双向网格马丁策略（BUYSTOP/SELLSTOP挂单）"
#property version   "2.00"
#property strict

//=====================================================================
// 第一部分：枚举定义
//=====================================================================
// 开单模式：无延迟 / 按K线 / 按时间间隔
enum 开单模式枚举
  {
   开单_按K线  = 1,    // 开单时区模式
   开单_按时间 = 2,    // 开单时间间距(秒)模式
   开单_无延迟 = 3     // 不延迟模式
  };

//=====================================================================
// 第二部分：输入参数（全部汉化，对应MQ4原版extern参数）
//=====================================================================
input group "===== 价格限制 ====="
input double 入_买首单价格上限   = 0;        // B以上不开(首)
input double 入_卖首单价格下限   = 0;        // S以下不开(首)
input double 入_买补单价格上限   = 0;        // B以上不开(补)
input double 入_卖补单价格下限   = 0;        // S以下不开(补)
input string 入_限价开始时间     = "00:00";  // 限价开始时间
input string 入_限价结束时间     = "24:00";  // 限价结束时间

input group "===== 保护与模式 ====="
input bool   入_逆势保护         = true;     // 逆势保护开关
input bool   入_顺势保护         = true;     // 顺势保护开关
input bool   入_对锁顺势         = false;    // 完全对锁时挂上顺势开关
input bool   入_平仓后停止       = false;    // 平仓后停止交易
input int    入_冷却秒数         = 0;        // 整体平仓后多少秒后新局
input double 入_浮亏切换阈值     = 0;        // 浮亏多少启用第二参数

input group "===== 网格参数 ====="
input int    入_首单距离         = 30;       // 首单距离(点)
input int    入_最小距离         = 60;       // 最小距离(点)
input int    入_第二最小距离     = 60;       // 第二最小距离(点)
input int    入_挂单追踪点数     = 5;        // 挂单追踪点数
input int    入_补单间距         = 100;      // 补单间距(点)
input int    入_第二补单间距     = 100;      // 第二补单间距(点)
input 开单模式枚举 入_开单模式   = 开单_无延迟; // 开单模式(默认=不延迟)
input ENUM_TIMEFRAMES 入_开单时区 = PERIOD_M1;  // 开单时区
input int    入_开单间隔秒       = 30;       // 开单时间间距(秒)

input group "===== 风控参数 ====="
input double 入_单边浮亏上限     = 100000;   // 单边浮亏超过多少不继续加仓
input double 入_单边平仓限制     = 50;       // 单边平仓限制

input group "===== 手数参数 ====="
input double 入_起始手数         = 0.01;     // 起始手数
input double 入_最大手数         = 10;       // 最大开单手数
input double 入_累加手数         = 0;        // 累加手数
input double 入_倍率             = 1.3;      // 倍率
input int    入_手数小数位       = 2;        // 下单量小数位

input group "===== 平仓参数 ====="
input double 入_整体平仓金额     = 0.5;      // 整体平仓金额
input bool   入_单边平仓累加     = true;     // 单边平仓金额累加开关
input double 入_单边平仓金额     = 2;        // 单边平仓金额
input double 入_止损金额         = 0;        // 止损金额(0=不启用)

input group "===== 通用参数 ====="
input int    入_魔术号           = 958999848; // 魔术号
input int    入_最大单量         = 50;       // 最大单量
input int    入_点差限制         = 60;       // 点差限制
input int    入_杠杆限制         = 100;      // 平台杠杆限制
input string 入_EA开始时间       = "00:00";  // EA开始时间
input string 入_EA结束时间       = "24:00";  // EA结束时间
input color  入_多单均价颜色     = clrMediumSeaGreen; // 多单平均价颜色
input color  入_空单均价颜色     = clrCrimson;        // 空单平均价颜色
input string 入_备注1            = "备注1";  // 订单备注1(正常)
input string 入_备注2            = "备注2";  // 订单备注2(顺势)
input int    入_滑点             = 30;       // 滑点(点)

//=====================================================================
// 第三部分：运行时全局变量
//=====================================================================
// --- 面板常量 ---
const string 面板前缀   = "JQL5_";
const string 统计面板名 = "JQL5_统计";
const string 按钮面板名 = "JQL5_按钮";
const string 字体名称   = "Microsoft YaHei";
const int    基础字号   = 10;
const int    面板锚点   = CORNER_RIGHT_UPPER;
const int    面板宽度   = 320;   // 加宽，给数值留空间
const int    面板起始X  = 322;   // 面板左缘距图表右缘(增大=向左移)
const int    面板起始Y  = 35;    // 面板上缘距图表上缘
// 列偏移(从面板左缘算起，XDISTANCE = 面板起始X - 偏移)
const int    列_标签     = 18;   // 左侧标签列
const int    列_数值1    = 155;  // 居中数值列
const int    列_数值2    = 302;  // 右侧数值列(距面板右缘~18px)

// --- 持仓统计 ---
int      运_多单数量       = 0;
int      运_空单数量       = 0;
int      运_多单挂单数     = 0;
int      运_空单挂单数     = 0;
double   运_多单手数       = 0;
double   运_空单手数       = 0;
double   运_多单盈亏       = 0;   // 含swap+commission
double   运_空单盈亏       = 0;
double   运_总盈亏         = 0;
double   运_多单最高价     = 0;
double   运_多单最低价     = 0;
double   运_空单最高价     = 0;
double   运_空单最低价     = 0;
double   运_多单加权价格和 = 0;   // price * lots 累加
double   运_空单加权价格和 = 0;
double   运_多单均价       = 0;
double   运_空单均价       = 0;

// --- 挂单追踪 ---
ulong    运_最后多单挂单号 = 0;
ulong    运_最后空单挂单号 = 0;
double   运_最后多单挂单价 = 0;
double   运_最后空单挂单价 = 0;

// --- 状态标志 ---
bool     运_多单允许       = true;
bool     运_空单允许       = true;
bool     运_正常模式       = true;  // true=正常参数, false=保守参数
bool     运_多单失衡       = false; // 多单手数失衡
bool     运_空单失衡       = false; // 空单手数失衡
bool     运_暂停           = false;
int      运_滑点           = 30;

// --- 时间控制 ---
datetime 运_最后K线时间    = 0;     // 用于按K线开单
datetime 运_最后开单时间   = 0;     // 用于按时间开单
datetime 运_冷却结束时间   = 0;     // 平仓后冷却
string   运_EA名称         = "";

// --- 面板状态 ---
bool     运_统计面板可见   = true;
bool     运_按钮面板可见   = false;
int      运_按钮面板起始Y  = 500;   // 动态计算

// --- 逆势保护追踪 ---
double   运_多单峰值盈利   = 0;
double   运_空单峰值盈利   = 0;

//=====================================================================
// 第四部分：工具函数
//=====================================================================
// 获取当前买价
double 获取买价() { return SymbolInfoDouble(_Symbol, SYMBOL_BID); }

// 获取当前卖价
double 获取卖价() { return SymbolInfoDouble(_Symbol, SYMBOL_ASK); }

// 获取当前点差
int 获取点差() { return (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD); }

// 获取最小冻结距离
int 获取最小距离()
  {
   int freeze = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   int stop   = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   return MathMax(freeze, stop) + 1;
  }

// 检查是否在EA时间窗口内（MQ4原版用TimeLocal，回测用TimeCurrent）
bool 在EA时间内()
  {
   datetime now = MQLInfoInteger(MQL_TESTER) ? TimeCurrent() : TimeLocal();
   MqlDateTime dt;
   TimeToStruct(now, dt);
   int 当前分钟 = dt.hour * 60 + dt.min;

   int 开始分钟 = 字符串转分钟(入_EA开始时间);
   int 结束分钟 = 字符串转分钟(入_EA结束时间);

   if(开始分钟 <= 结束分钟)
      return (当前分钟 >= 开始分钟 && 当前分钟 < 结束分钟);
   else
      return (当前分钟 >= 开始分钟 || 当前分钟 < 结束分钟);
  }

// 检查是否在限价时间窗口内
bool 在限价时间内()
  {
   MqlDateTime dt;
   TimeCurrent(dt);
   int 当前分钟 = dt.hour * 60 + dt.min;

   int 开始分钟 = 字符串转分钟(入_限价开始时间);
   int 结束分钟 = 字符串转分钟(入_限价结束时间);

   if(开始分钟 <= 结束分钟)
      return (当前分钟 >= 开始分钟 && 当前分钟 < 结束分钟);
   else
      return (当前分钟 >= 开始分钟 || 当前分钟 < 结束分钟);
  }

// "HH:MM" 转分钟数
int 字符串转分钟(string 时间字符串)
  {
   string parts[];
   int n = StringSplit(时间字符串, ':', parts);
   if(n < 2) return 0;
   return (int)StringToInteger(parts[0]) * 60 + (int)StringToInteger(parts[1]);
  }

// 检查交易权限
bool 交易环境正常()
  {
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO)
      return true; // 模拟盘始终允许
   return (MQLInfoInteger(MQL_TRADE_ALLOWED) &&
           TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) &&
           AccountInfoInteger(ACCOUNT_TRADE_ALLOWED));
  }

// 检查是否为对冲账户
bool 是对冲账户()
  {
   return (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
  }

// 获取填充模式
ENUM_ORDER_TYPE_FILLING 获取填充模式()
  {
   long fillMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillMode & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if((fillMode & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

//=====================================================================
// 第五部分：交易函数
//=====================================================================
// 发送挂单（BUY_STOP 或 SELL_STOP）
// 返回：挂单ticket，失败返回0
ulong 发送挂单(ENUM_ORDER_TYPE 订单类型, double 手数, double 价格, string 备注)
  {
   MqlTradeRequest 请求 = {};
   MqlTradeResult  结果 = {};

   请求.action    = TRADE_ACTION_PENDING;
   请求.symbol    = _Symbol;
   请求.type      = 订单类型;
   请求.volume    = 手数;
   请求.price     = NormalizeDouble(价格, _Digits);
   请求.deviation = 运_滑点;
   请求.magic     = 入_魔术号;
   请求.comment   = 备注;
   请求.type_filling = 获取填充模式();

   // 设置过期时间为GTC
   请求.type_time = ORDER_TIME_GTC;

   if(!OrderSend(请求, 结果))
     {
      string 类型名 = (订单类型 == ORDER_TYPE_BUY_STOP) ? "BUY_STOP" : "SELL_STOP";
      PrintFormat("❌ 发送%s挂单失败: 价格=%.5f 手数=%.2f 错误=%d",
                  类型名, 价格, 手数, 结果.retcode);
      return 0;
     }

   PrintFormat("✅ %s挂单成功: 票号=%d 价格=%.5f 手数=%.2f",
               (订单类型 == ORDER_TYPE_BUY_STOP) ? "BUY_STOP" : "SELL_STOP",
               结果.order, 价格, 手数);
   return 结果.order;
  }

// 取消挂单
bool 取消挂单(ulong 票号)
  {
   MqlTradeRequest 请求 = {};
   MqlTradeResult  结果 = {};

   请求.action = TRADE_ACTION_REMOVE;
   请求.order  = 票号;

   if(!OrderSend(请求, 结果))
     {
      PrintFormat("❌ 取消挂单失败: 票号=%d 错误=%d", 票号, 结果.retcode);
      return false;
     }
   return true;
  }

// 修改挂单价格
bool 修改挂单价(ulong 票号, double 新价格)
  {
   if(!OrderSelect(票号)) return false;

   MqlTradeRequest 请求 = {};
   MqlTradeResult  结果 = {};

   请求.action = TRADE_ACTION_MODIFY;
   请求.order  = 票号;
   请求.price  = NormalizeDouble(新价格, _Digits);

   if(!OrderSend(请求, 结果))
     {
      // 10014 = 新价与现价太近，忽略
      if(结果.retcode != 10014)
         PrintFormat("❌ 修改挂单失败: 票号=%d 错误=%d", 票号, 结果.retcode);
      return false;
     }
   return true;
  }

// 平仓指定持仓
bool 平仓持仓(ulong 票号)
  {
   if(!PositionSelectByTicket(票号)) return false;

   MqlTradeRequest 请求 = {};
   MqlTradeResult  结果 = {};

   请求.action    = TRADE_ACTION_DEAL;
   请求.symbol    = _Symbol;
   请求.position  = 票号;
   请求.volume    = PositionGetDouble(POSITION_VOLUME);
   请求.deviation = 运_滑点;
   请求.magic     = 入_魔术号;
   请求.type_filling = 获取填充模式();

   if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
     {
      请求.type  = ORDER_TYPE_SELL;
      请求.price = 获取买价();
     }
   else
     {
      请求.type  = ORDER_TYPE_BUY;
      请求.price = 获取卖价();
     }

   if(!OrderSend(请求, 结果))
     {
      PrintFormat("❌ 平仓失败: 票号=%d 错误=%d", 票号, 结果.retcode);
      return false;
     }
   return true;
  }

// 批量平仓：方向(1=多, -1=空, 0=全部)，含挂单删除
// 返回平仓数量
int 批量平仓(int 方向)
  {
   int 已平数量 = 0;

   for(int 尝试 = 0; 尝试 < 10; 尝试++)
     {
      bool 本轮有操作 = false;

      // 先平持仓
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;

         long 类型 = PositionGetInteger(POSITION_TYPE);
         if(方向 == 1 && 类型 != POSITION_TYPE_BUY) continue;
         if(方向 == -1 && 类型 != POSITION_TYPE_SELL) continue;

         if(平仓持仓(ticket))
           {
            已平数量++;
            本轮有操作 = true;
           }
        }

      // 再删挂单
      for(int i = OrdersTotal() - 1; i >= 0; i--)
        {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
         if(OrderGetInteger(ORDER_MAGIC) != 入_魔术号) continue;

         long 类型 = OrderGetInteger(ORDER_TYPE);
         if(方向 == 1 && 类型 != ORDER_TYPE_BUY_STOP) continue;
         if(方向 == -1 && 类型 != ORDER_TYPE_SELL_STOP) continue;

         // 方向=0时也删
         if(方向 == 0 || 类型 == ORDER_TYPE_BUY_STOP || 类型 == ORDER_TYPE_SELL_STOP)
           {
            if(取消挂单(ticket))
              {
               本轮有操作 = true;
              }
           }
        }

      if(!本轮有操作) break;
      Sleep(1000);
     }

   return 已平数量;
  }

// 按盈亏平仓：关闭N个最盈利/最亏损的订单
// 模式: 1=最盈利优先, 2=最亏损优先
void 按盈亏平仓(int 订单方向, int 数量, int 模式)
  {
   while(数量 > 0)
     {
      double 最佳盈亏 = (模式 == 1) ? -DBL_MAX : DBL_MAX;
      ulong  最佳票号 = 0;
      bool   找到 = false;

      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;

         long 类型 = PositionGetInteger(POSITION_TYPE);
         if(订单方向 != -100)
           {
            if(订单方向 == 1 && 类型 != POSITION_TYPE_BUY) continue;
            if(订单方向 == -1 && 类型 != POSITION_TYPE_SELL) continue;
           }

         double 盈亏 = PositionGetDouble(POSITION_PROFIT) +
                       PositionGetDouble(POSITION_SWAP) +
                       PositionGetDouble(POSITION_COMMISSION);

         if(模式 == 1 && 盈亏 > 最佳盈亏) { 最佳盈亏 = 盈亏; 最佳票号 = ticket; 找到 = true; }
         if(模式 == 2 && 盈亏 < 最佳盈亏) { 最佳盈亏 = 盈亏; 最佳票号 = ticket; 找到 = true; }
        }

      if(!找到) break;

      // 模式1只平盈利单，模式2只平亏损单
      if(模式 == 1 && 最佳盈亏 < 0) break;
      if(模式 == 2 && 最佳盈亏 >= 0) break;

      if(平仓持仓(最佳票号))
         PrintFormat("按盈亏平仓: 票号=%d 盈亏=%.2f", 最佳票号, 最佳盈亏);

      数量--;
     }
  }

// 计算前N个最盈利/最亏损订单的盈亏总和
// 模式: 1=最盈利, 2=最亏损
double 计算TopN盈亏(int 订单方向, int 数量, int 模式)
  {
   double 盈亏数组[];
   int    数组大小 = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;

      long 类型 = PositionGetInteger(POSITION_TYPE);
      if(订单方向 != -100)
        {
         if(订单方向 == 1 && 类型 != POSITION_TYPE_BUY) continue;
         if(订单方向 == -1 && 类型 != POSITION_TYPE_SELL) continue;
        }

      double 盈亏 = PositionGetDouble(POSITION_PROFIT) +
                    PositionGetDouble(POSITION_SWAP) +
                    PositionGetDouble(POSITION_COMMISSION);

      ArrayResize(盈亏数组, 数组大小 + 1);
      盈亏数组[数组大小] = 盈亏;
      数组大小++;
     }

   if(数组大小 == 0) return 0;

   // 排序
   ArraySort(盈亏数组);

   double 总和 = 0;
   if(模式 == 1) // 最盈利：从大到小取前N
     {
      for(int i = 数组大小 - 1; i >= MathMax(0, 数组大小 - 数量); i--)
         总和 += 盈亏数组[i];
     }
   else // 最亏损：从小到大取前N
     {
      for(int i = 0; i < MathMin(数量, 数组大小); i++)
         总和 += 盈亏数组[i];
     }

   return 总和;
  }

//=====================================================================
// 第六部分：持仓状态扫描
//=====================================================================
void 更新持仓状态()
  {
   // 重置统计
   运_多单数量 = 0;       运_空单数量 = 0;
   运_多单挂单数 = 0;     运_空单挂单数 = 0;
   运_多单手数 = 0;       运_空单手数 = 0;
   运_多单盈亏 = 0;       运_空单盈亏 = 0;
   运_总盈亏 = 0;
   运_多单最高价 = 0;     运_多单最低价 = DBL_MAX;
   运_空单最高价 = 0;     运_空单最低价 = DBL_MAX;
   运_多单加权价格和 = 0; 运_空单加权价格和 = 0;
   运_最后多单挂单号 = 0; 运_最后空单挂单号 = 0;
   运_最后多单挂单价 = 0; 运_最后空单挂单价 = 0;

   // 扫描持仓
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;

      long   类型   = PositionGetInteger(POSITION_TYPE);
      double 手数   = PositionGetDouble(POSITION_VOLUME);
      double 开仓价 = PositionGetDouble(POSITION_PRICE_OPEN);
      double 盈亏   = PositionGetDouble(POSITION_PROFIT) +
                      PositionGetDouble(POSITION_SWAP) +
                      PositionGetDouble(POSITION_COMMISSION);

      if(类型 == POSITION_TYPE_BUY)
        {
         运_多单数量++;
         运_多单手数 += 手数;
         运_多单盈亏 += 盈亏;
         运_多单加权价格和 += 开仓价 * 手数;
         if(开仓价 > 运_多单最高价) 运_多单最高价 = 开仓价;
         if(开仓价 < 运_多单最低价) 运_多单最低价 = 开仓价;
        }
      else if(类型 == POSITION_TYPE_SELL)
        {
         运_空单数量++;
         运_空单手数 += 手数;
         运_空单盈亏 += 盈亏;
         运_空单加权价格和 += 开仓价 * 手数;
         if(开仓价 > 运_空单最高价) 运_空单最高价 = 开仓价;
         if(开仓价 < 运_空单最低价) 运_空单最低价 = 开仓价;
        }
     }

   运_总盈亏 = 运_多单盈亏 + 运_空单盈亏;

   // 计算均价
   运_多单均价 = (运_多单手数 > 0) ? 运_多单加权价格和 / 运_多单手数 : 0;
   运_空单均价 = (运_空单手数 > 0) ? 运_空单加权价格和 / 运_空单手数 : 0;

   // 修正无持仓时的最低价
   if(运_多单最低价 == DBL_MAX) 运_多单最低价 = 0;
   if(运_空单最低价 == DBL_MAX) 运_空单最低价 = 0;

   // 扫描挂单
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if(OrderGetInteger(ORDER_MAGIC) != 入_魔术号) continue;

      long 类型 = OrderGetInteger(ORDER_TYPE);

      if(类型 == ORDER_TYPE_BUY_STOP)
        {
         运_多单挂单数++;
         运_最后多单挂单号 = ticket;
         运_最后多单挂单价 = OrderGetDouble(ORDER_PRICE_OPEN);
        }
      else if(类型 == ORDER_TYPE_SELL_STOP)
        {
         运_空单挂单数++;
         运_最后空单挂单号 = ticket;
         运_最后空单挂单价 = OrderGetDouble(ORDER_PRICE_OPEN);
        }
     }

   // 手数失衡检测
   运_多单失衡 = false;
   运_空单失衡 = false;
   if(运_空单手数 > 0 && 运_多单手数 > 0)
     {
      if(运_空单手数 / 运_多单手数 > 3 && 运_空单手数 - 运_多单手数 > 0.2)
         运_多单失衡 = true;
      if(运_多单手数 / 运_空单手数 > 3 && 运_多单手数 - 运_空单手数 > 0.2)
         运_空单失衡 = true;
     }

   // 双参数模式判断（MQ4原版逻辑：init中Money取反，然后比较<=Money）
   if(入_浮亏切换阈值 != 0 && 运_总盈亏 <= -入_浮亏切换阈值)
      运_正常模式 = false;  // 保守模式
   else
      运_正常模式 = true;   // 正常模式
  }

//=====================================================================
// 第七部分：风控检查
//=====================================================================
bool 检查风控条件()
  {
   // 杠杆检查
   if((int)AccountInfoInteger(ACCOUNT_LEVERAGE) < 入_杠杆限制)
      return false;

   // 交易权限
   if(!交易环境正常())
      return false;

   // 最大单量
   int 总订单数 = 运_多单数量 + 运_空单数量 + 运_多单挂单数 + 运_空单挂单数;
   if(总订单数 >= 入_最大单量)
      return false;

   // 点差检查
   if(获取点差() > 入_点差限制)
      return false;

   return true;
  }

//=====================================================================
// 第八部分：手数计算
//=====================================================================
double 计算手数(int 已有数量)
  {
   double 手数;

   if(已有数量 == 0)
      手数 = 入_起始手数;
   else
      手数 = 已有数量 * 入_累加手数 + 入_起始手数 * MathPow(入_倍率, 已有数量);

   // 四舍五入到指定位数
   手数 = NormalizeDouble(手数, 入_手数小数位);

   // 上限
   if(手数 > 入_最大手数)
      手数 = 入_最大手数;

   // 下限
   double 最小手数 = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   if(手数 < 最小手数)
      手数 = 最小手数;

   return 手数;
  }

//=====================================================================
// 第九部分：网格开仓逻辑
//=====================================================================
// 检查是否可以发送新订单（时间控制）
bool 可以开单()
  {
   if(入_开单模式 == 开单_无延迟) return true;

   if(入_开单模式 == 开单_按K线)
     {
      datetime 当前K线时间 = iTime(_Symbol, 入_开单时区, 0);
      if(当前K线时间 != 运_最后K线时间)
        {
         运_最后K线时间 = 当前K线时间;
         return true;
        }
      return false;
     }

   if(入_开单模式 == 开单_按时间)
     {
      if(TimeCurrent() - 运_最后开单时间 >= 入_开单间隔秒)
        {
         运_最后开单时间 = TimeCurrent();
         return true;
        }
      return false;
     }

   return true;
  }

// 检查价格是否在限制范围内
bool 价格允许(ENUM_ORDER_TYPE 类型, double 价格)
  {
   // 首单价格限制
   if(运_多单数量 == 0 && 类型 == ORDER_TYPE_BUY_STOP)
     {
      if(入_买首单价格上限 > 0 && 价格 >= 入_买首单价格上限)
         return false;
     }
   if(运_空单数量 == 0 && 类型 == ORDER_TYPE_SELL_STOP)
     {
      if(入_卖首单价格下限 > 0 && 价格 <= 入_卖首单价格下限)
         return false;
     }

   // 补单价格限制（仅在限价时间窗口内生效）
   if(在限价时间内())
     {
      if(类型 == ORDER_TYPE_BUY_STOP && 入_买补单价格上限 > 0 && 价格 >= 入_买补单价格上限)
         return false;
      if(类型 == ORDER_TYPE_SELL_STOP && 入_卖补单价格下限 > 0 && 价格 <= 入_卖补单价格下限)
         return false;
     }

   return true;
  }

// 计算BUY挂单价格
double 计算多单挂单价()
  {
   double Ask = 获取卖价();
   double 距离, 间距;

   if(运_多单数量 == 0)
     {
      // 首单
      return NormalizeDouble(Ask + 入_首单距离 * _Point, _Digits);
     }

   // 补单
   距离 = 运_正常模式 ? 入_最小距离 : 入_第二最小距离;
   间距 = 运_正常模式 ? 入_补单间距 : 入_第二补单间距;

   double 目标价 = NormalizeDouble(Ask + 距离 * _Point, _Digits);

   // 间距验证：新价必须 >= 最高多单价 + 间距
   double 最低价 = NormalizeDouble(运_多单最高价 + 间距 * _Point, _Digits);
   if(目标价 < 最低价)
      目标价 = 最低价;

   return 目标价;
  }

// 计算SELL挂单价格
double 计算空单挂单价()
  {
   double Bid = 获取买价();
   double 距离, 间距;

   if(运_空单数量 == 0)
     {
      // 首单
      return NormalizeDouble(Bid - 入_首单距离 * _Point, _Digits);
     }

   // 补单
   距离 = 运_正常模式 ? 入_最小距离 : 入_第二最小距离;
   间距 = 运_正常模式 ? 入_补单间距 : 入_第二补单间距;

   double 目标价 = NormalizeDouble(Bid - 距离 * _Point, _Digits);

   // 间距验证：新价必须 <= 最低空单价 - 间距
   double 最高价 = NormalizeDouble(运_空单最低价 - 间距 * _Point, _Digits);
   if(目标价 > 最高价)
      目标价 = 最高价;

   return 目标价;
  }

// 检查并发送多单挂单（MQ4原版5条件逻辑）
void 检查多单开仓()
  {
   // 前置检查
   if(!运_多单允许) return;
   if(运_多单挂单数 > 0) return;  // 已有挂单，不重复
   if(运_多单盈亏 < -入_单边浮亏上限) return; // 单边浮亏超限

   // 冷却期检查
   if(TimeCurrent() < 运_冷却结束时间) return;

   // 时间检查
   if(!在EA时间内()) return;
   if(!检查风控条件()) return;
   if(!可以开单()) return;

   // 计算目标价
   double Ask = 获取卖价();
   double 距离 = 运_正常模式 ? 入_最小距离 : 入_第二最小距离;
   double 间距 = 运_正常模式 ? 入_补单间距 : 入_第二补单间距;
   double 目标价;
   string 备注 = 入_备注1;

   if(运_多单数量 == 0)
     {
      // 首单
      目标价 = NormalizeDouble(Ask + 入_首单距离 * _Point, _Digits);
     }
   else
     {
      // 补单：检查MQ4原版5个条件
      目标价 = NormalizeDouble(Ask + 距离 * _Point, _Digits);
      bool 条件满足 = false;

      // 卖方手数失衡（卖方手数 > 多方手数*3）
      bool 卖方失衡 = (运_空单手数 > 0 && 运_多单手数 / 运_空单手数 > 3 && 运_多单手数 - 运_空单手数 > 0.2);

      // 条件1: 目标价 >= 最高多单价 + 间距 AND 卖方失衡 AND 正常模式
      if(目标价 >= 运_多单最高价 + 间距 * _Point && 卖方失衡 && 运_正常模式)
         条件满足 = true;

      // 条件2: 目标价 >= 最高多单价 + 第二间距 AND 卖方失衡 AND 保守模式 AND 阈值!=0
      if(目标价 >= 运_多单最高价 + 入_第二补单间距 * _Point && 卖方失衡 && !运_正常模式 && 入_浮亏切换阈值 != 0)
         条件满足 = true;

      // 条件3: 目标价 <= 最低多单价 - 间距 AND 正常模式
      if(运_多单最低价 > 0 && 目标价 <= 运_多单最低价 - 间距 * _Point && 运_正常模式)
         条件满足 = true;

      // 条件4: 目标价 <= 最低多单价 - 第二间距 AND 保守模式 AND 阈值!=0
      if(运_多单最低价 > 0 && 目标价 <= 运_多单最低价 - 入_第二补单间距 * _Point && !运_正常模式 && 入_浮亏切换阈值 != 0)
         条件满足 = true;

      // 条件5: 对锁顺势 AND 目标价 >= 最高+间距 AND 多空手数相等
      if(入_对锁顺势 && 目标价 >= 运_多单最高价 + 间距 * _Point && 运_多单手数 == 运_空单手数 && 运_多单手数 > 0)
        {
         条件满足 = true;
         备注 = 入_备注2;  // 顺势标记
        }

      if(!条件满足) return;
     }

   // 价格限制检查
   if(!价格允许(ORDER_TYPE_BUY_STOP, 目标价)) return;

   // 计算手数
   double 手数 = 计算手数(运_多单数量);
   if(手数 <= 0) return;

   // 保证金检查（MQ4原版跳过此检查）
   // double 保证金需求 = 0;
   // if(!OrderCalcMargin(ORDER_TYPE_BUY_STOP, _Symbol, 手数, 目标价, 保证金需求))
   //     return;

   // 发送挂单
   ulong 票号 = 发送挂单(ORDER_TYPE_BUY_STOP, 手数, 目标价, 备注);
   if(票号 > 0)
      PrintFormat("📈 多单挂单: 手数=%.2f 价格=%.5f 第%d单 备注=%s",
                  手数, 目标价, 运_多单数量 + 1, 备注);
  }

// 检查并发送空单挂单（MQ4原版5条件逻辑）
void 检查空单开仓()
  {
   // 前置检查
   if(!运_空单允许) return;
   if(运_空单挂单数 > 0) return;
   if(运_空单盈亏 < -入_单边浮亏上限) return;

   // 冷却期检查
   if(TimeCurrent() < 运_冷却结束时间) return;

   // 时间检查
   if(!在EA时间内()) return;
   if(!检查风控条件()) return;
   if(!可以开单()) return;

   // 计算目标价
   double Bid = 获取买价();
   double 距离 = 运_正常模式 ? 入_最小距离 : 入_第二最小距离;
   double 间距 = 运_正常模式 ? 入_补单间距 : 入_第二补单间距;
   double 目标价;
   string 备注 = 入_备注1;

   if(运_空单数量 == 0)
     {
      // 首单
      目标价 = NormalizeDouble(Bid - 入_首单距离 * _Point, _Digits);
     }
   else
     {
      // 补单：检查MQ4原版5个条件
      目标价 = NormalizeDouble(Bid - 距离 * _Point, _Digits);
      bool 条件满足 = false;

      // 多方手数失衡（多方手数 > 空方手数*3）
      bool 多方失衡 = (运_多单手数 > 0 && 运_空单手数 / 运_多单手数 > 3 && 运_空单手数 - 运_多单手数 > 0.2);

      // 条件1: 目标价 <= 最低空单价 - 间距 AND 多方失衡 AND 正常模式
      if(运_空单最低价 > 0 && 目标价 <= 运_空单最低价 - 间距 * _Point && 多方失衡 && 运_正常模式)
         条件满足 = true;

      // 条件2: 目标价 <= 最低空单价 - 第二间距 AND 多方失衡 AND 保守模式 AND 阈值!=0
      if(运_空单最低价 > 0 && 目标价 <= 运_空单最低价 - 入_第二补单间距 * _Point && 多方失衡 && !运_正常模式 && 入_浮亏切换阈值 != 0)
         条件满足 = true;

      // 条件3: 目标价 >= 最高空单价 + 间距 AND 正常模式
      if(目标价 >= 运_空单最高价 + 间距 * _Point && 运_正常模式)
         条件满足 = true;

      // 条件4: 目标价 >= 最高空单价 + 第二间距 AND 保守模式 AND 阈值!=0
      if(目标价 >= 运_空单最高价 + 入_第二补单间距 * _Point && !运_正常模式 && 入_浮亏切换阈值 != 0)
         条件满足 = true;

      // 条件5: 对锁顺势 AND 目标价 <= 最低-间距 AND 多空手数相等
      if(入_对锁顺势 && 运_空单最低价 > 0 && 目标价 <= 运_空单最低价 - 间距 * _Point && 运_多单手数 == 运_空单手数 && 运_空单手数 > 0)
        {
         条件满足 = true;
         备注 = 入_备注2;  // 顺势标记
        }

      if(!条件满足) return;
     }

   // 价格限制检查
   if(!价格允许(ORDER_TYPE_SELL_STOP, 目标价)) return;

   // 计算手数
   double 手数 = 计算手数(运_空单数量);
   if(手数 <= 0) return;

   // 保证金检查（MQ4原版跳过此检查）
   // double 保证金需求 = 0;
   // if(!OrderCalcMargin(ORDER_TYPE_SELL_STOP, _Symbol, 手数, 目标价, 保证金需求))
   //     return;

   // 发送挂单
   ulong 票号 = 发送挂单(ORDER_TYPE_SELL_STOP, 手数, 目标价, 备注);
   if(票号 > 0)
      PrintFormat("📉 空单挂单: 手数=%.2f 价格=%.5f 第%d单 备注=%s",
                  手数, 目标价, 运_空单数量 + 1, 备注);
  }

//=====================================================================
// 第十部分：挂单追踪
//=====================================================================
void 挂单追踪()
  {
   if(入_挂单追踪点数 <= 0) return;

   // 多单挂单追踪
   if(运_最后多单挂单号 > 0 && 运_多单挂单数 > 0)
     {
      double 目标价 = 计算多单挂单价();
      double 偏差 = MathAbs(目标价 - 运_最后多单挂单价) / _Point;
      if(偏差 >= 入_挂单追踪点数)
        {
         if(修改挂单价(运_最后多单挂单号, 目标价))
            PrintFormat("🔄 多单挂单追踪: %.5f → %.5f", 运_最后多单挂单价, 目标价);
        }
     }

   // 空单挂单追踪
   if(运_最后空单挂单号 > 0 && 运_空单挂单数 > 0)
     {
      double 目标价 = 计算空单挂单价();
      double 偏差 = MathAbs(目标价 - 运_最后空单挂单价) / _Point;
      if(偏差 >= 入_挂单追踪点数)
        {
         if(修改挂单价(运_最后空单挂单号, 目标价))
            PrintFormat("🔄 空单挂单追踪: %.5f → %.5f", 运_最后空单挂单价, 目标价);
        }
     }
  }

//=====================================================================
// 第十一部分：平仓条件检查（5级优先级）
//=====================================================================
void 检查平仓条件()
  {
   int 总订单数 = 运_多单数量 + 运_空单数量;

   // === 级别0：Over模式 ===
   if(入_平仓后停止 && 总订单数 > 0 && 运_总盈亏 >= 入_整体平仓金额)
     {
      PrintFormat("🔒 Over模式触发: 总盈亏=%.2f >= %.2f", 运_总盈亏, 入_整体平仓金额);
      批量平仓(0);
      运_多单允许 = false;
      运_空单允许 = false;
      if(入_冷却秒数 > 0)
         运_冷却结束时间 = TimeCurrent() + 入_冷却秒数;
      return;
     }

   // === 级别1：单边止盈 ===
   if(运_多单数量 > 0)
     {
      double 止盈阈值 = 入_单边平仓金额;
      if(入_单边平仓累加)
         止盈阈值 *= 运_多单数量;

      // 逆势保护：检查失衡
      if(入_逆势保护 && 运_多单手数 > 0 && 运_空单手数 > 0)
        {
         double 最大盈利单盈亏 = 计算TopN盈亏(1, 1, 1);
         运_多单峰值盈利 = MathMax(运_多单峰值盈利, 最大盈利单盈亏);

         if(运_多单峰值盈利 > 0 && 运_多单手数 > 运_空单手数 * 3 && 运_多单手数 - 运_空单手数 > 0.2 && 运_多单数量 > 3)
           {
            PrintFormat("⚖️ 逆势保护触发(多单): 手数失衡 %.2f vs %.2f", 运_多单手数, 运_空单手数);
            按盈亏平仓(1, 1, 1); // 平最盈利多单
            按盈亏平仓(1, 1, 2); // 平最亏损多单
            运_多单峰值盈利 = 0;
            return;
           }
        }

      // 检查双方亏损限制（MQ4原版：双方盈亏都 > -MaxLossCloseAll才允许单边止盈）
      if((运_多单盈亏 > -入_单边平仓限制 && 运_空单盈亏 > -入_单边平仓限制) || 运_空单数量 == 0)
        {
         if(运_多单盈亏 >= 止盈阈值)
           {
            PrintFormat("💰 多单止盈: 盈亏=%.2f >= %.2f", 运_多单盈亏, 止盈阈值);
            批量平仓(1);
            if(入_冷却秒数 > 0)
               运_冷却结束时间 = TimeCurrent() + 入_冷却秒数;
            运_多单峰值盈利 = 0;
            return;
           }
        }
     }

   if(运_空单数量 > 0)
     {
      double 止盈阈值 = 入_单边平仓金额;
      if(入_单边平仓累加)
         止盈阈值 *= 运_空单数量;

      // 逆势保护
      if(入_逆势保护 && 运_多单手数 > 0 && 运_空单手数 > 0)
        {
         double 最大盈利单盈亏 = 计算TopN盈亏(-1, 1, 1);
         运_空单峰值盈利 = MathMax(运_空单峰值盈利, 最大盈利单盈亏);

         if(运_空单峰值盈利 > 0 && 运_空单手数 > 运_多单手数 * 3 && 运_空单手数 - 运_多单手数 > 0.2 && 运_空单数量 > 3)
           {
            PrintFormat("⚖️ 逆势保护触发(空单): 手数失衡 %.2f vs %.2f", 运_空单手数, 运_多单手数);
            按盈亏平仓(-1, 1, 1);
            按盈亏平仓(-1, 1, 2);
            运_空单峰值盈利 = 0;
            return;
           }
        }

      if((运_多单盈亏 > -入_单边平仓限制 && 运_空单盈亏 > -入_单边平仓限制) || 运_多单数量 == 0)
        {
         if(运_空单盈亏 >= 止盈阈值)
           {
            PrintFormat("💰 空单止盈: 盈亏=%.2f >= %.2f", 运_空单盈亏, 止盈阈值);
            批量平仓(-1);
            if(入_冷却秒数 > 0)
               运_冷却结束时间 = TimeCurrent() + 入_冷却秒数;
            运_空单峰值盈利 = 0;
            return;
           }
        }
     }

   // === 级别2：顺势保护 ===
   if(入_顺势保护 && 运_多单数量 > 0 && 运_空单数量 > 0)
     {
      // 检查是否有备注2的订单
      bool 有多单SS = 检查备注订单(POSITION_TYPE_BUY, 入_备注2);
      bool 有空单SS = 检查备注订单(POSITION_TYPE_SELL, 入_备注2);

      if((有多单SS || 有空单SS) && 运_总盈亏 >= 入_整体平仓金额)
        {
         PrintFormat("🔄 顺势保护触发: 总盈亏=%.2f", 运_总盈亏);
         批量平仓(0);
         if(入_冷却秒数 > 0)
            运_冷却结束时间 = TimeCurrent() + 入_冷却秒数;
         return;
        }
     }

   // === 级别3：整体止盈 ===
   if(总订单数 > 0 && 运_总盈亏 >= 入_整体平仓金额)
     {
      // 需要某侧亏损 >= 单边平仓限制
      if(运_多单盈亏 <= -入_单边平仓限制 || 运_空单盈亏 <= -入_单边平仓限制)
        {
         PrintFormat("💰 整体止盈: 总盈亏=%.2f", 运_总盈亏);
         批量平仓(0);
         if(入_冷却秒数 > 0)
            运_冷却结束时间 = TimeCurrent() + 入_冷却秒数;
         return;
        }
     }

   // === 级别4：止损 ===
   if(入_止损金额 != 0 && 总订单数 > 0 && 运_总盈亏 <= -入_止损金额)
     {
      PrintFormat("🛑 止损触发: 总盈亏=%.2f <= -%.2f", 运_总盈亏, 入_止损金额);
      批量平仓(0);
      if(入_冷却秒数 > 0)
         运_冷却结束时间 = TimeCurrent() + 入_冷却秒数;
      return;
     }

   // === 级别5：手数失衡强制平仓 ===
   if(运_多单数量 > 3 && 运_多单手数 > 运_空单手数 * 3 && 运_多单手数 - 运_空单手数 > 0.2)
     {
      PrintFormat("⚖️ 多单手数失衡强制平: %.2f vs %.2f", 运_多单手数, 运_空单手数);
      按盈亏平仓(1, 1, 1); // 平最盈利多单
     }
   if(运_空单数量 > 3 && 运_空单手数 > 运_多单手数 * 3 && 运_空单手数 - 运_多单手数 > 0.2)
     {
      PrintFormat("⚖️ 空单手数失衡强制平: %.2f vs %.2f", 运_空单手数, 运_多单手数);
      按盈亏平仓(-1, 1, 1);
     }
  }

// 检查某方向是否有指定备注的订单
bool 检查备注订单(ENUM_POSITION_TYPE 类型, string 备注)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;
      if(PositionGetInteger(POSITION_TYPE) != 类型) continue;
      if(PositionGetString(POSITION_COMMENT) == 备注)
         return true;
     }
   return false;
  }

//=====================================================================
// 第十二部分：绘制平均价线和价格限制线
//=====================================================================
void 绘制平均价线()
  {
   // 多单平均价线
   if(运_多单数量 > 0 && 运_多单均价 > 0)
     {
      绘制水平线("多单均价线", 运_多单均价, 入_多单均价颜色);
     }
   else
     {
      ObjectDelete(0, "多单均价线");
     }

   // 空单平均价线
   if(运_空单数量 > 0 && 运_空单均价 > 0)
     {
      绘制水平线("空单均价线", 运_空单均价, 入_空单均价颜色);
     }
   else
     {
      ObjectDelete(0, "空单均价线");
     }
  }

void 绘制价格限制线()
  {
   绘制限价线("买首单上限", 入_买首单价格上限);
   绘制限价线("卖首单下限", 入_卖首单价格下限);
   绘制限价线("买补单上限", 入_买补单价格上限);
   绘制限价线("卖补单下限", 入_卖补单价格下限);
  }

void 绘制水平线(string 名称, double 价格, color 颜色)
  {
   ObjectDelete(0, 名称);
   ObjectCreate(0, 名称, OBJ_HLINE, 0, 0, 价格);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 颜色);
   ObjectSetInteger(0, 名称, OBJPROP_STYLE, STYLE_DOT);
   ObjectSetInteger(0, 名称, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, true);
  }

void 绘制限价线(string 名称, double 价格)
  {
   if(价格 <= 0)
     {
      ObjectDelete(0, 名称);
      return;
     }
   ObjectDelete(0, 名称);
   ObjectCreate(0, 名称, OBJ_HLINE, 0, 0, 价格);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, clrGold);
   ObjectSetInteger(0, 名称, OBJPROP_STYLE, STYLE_DASHDOT);
   ObjectSetInteger(0, 名称, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, true);
  }

//=====================================================================
// 第十三部分：统计面板（100%复刻MQ4原版）
//=====================================================================
// 辅助：创建矩形标签
void 创建矩形(string 名称, int X, int Y, int 宽, int 高, color 背景色, color 边框色 = clrNONE, int 边框宽 = 0)
  {
   ObjectCreate(0, 名称, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, 面板锚点);
   ObjectSetInteger(0, 名称, OBJPROP_XDISTANCE, X);
   ObjectSetInteger(0, 名称, OBJPROP_YDISTANCE, Y);
   ObjectSetInteger(0, 名称, OBJPROP_XSIZE, 宽);
   ObjectSetInteger(0, 名称, OBJPROP_YSIZE, 高);
   ObjectSetInteger(0, 名称, OBJPROP_BGCOLOR, 背景色);
   ObjectSetInteger(0, 名称, OBJPROP_BORDER_COLOR, 边框色);
   ObjectSetInteger(0, 名称, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, 面板锚点);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, false);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, 名称, OBJPROP_ZORDER, 0);
  }

// 辅助：创建文本标签
void 创建文本(string 名称, int X, int Y, string 文本, int 字号, color 颜色, string 字体 = "Microsoft YaHei")
  {
   ObjectCreate(0, 名称, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, 面板锚点);
   ObjectSetInteger(0, 名称, OBJPROP_XDISTANCE, X);
   ObjectSetInteger(0, 名称, OBJPROP_YDISTANCE, Y);
   ObjectSetString(0, 名称, OBJPROP_TEXT, 文本);
   ObjectSetString(0, 名称, OBJPROP_FONT, 字体);
   ObjectSetInteger(0, 名称, OBJPROP_FONTSIZE, 字号);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 颜色);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, false);
  }

// 辅助：创建按钮（MQ4原版文字色=白色）
void 创建按钮(string 名称, int X, int Y, int 宽, int 高, string 文本, color 背景色, color 文字色 = clrWhite)
  {
   ObjectCreate(0, 名称, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, 面板锚点);
   ObjectSetInteger(0, 名称, OBJPROP_XDISTANCE, X);
   ObjectSetInteger(0, 名称, OBJPROP_YDISTANCE, Y);
   ObjectSetInteger(0, 名称, OBJPROP_XSIZE, 宽);
   ObjectSetInteger(0, 名称, OBJPROP_YSIZE, 高);
   ObjectSetString(0, 名称, OBJPROP_TEXT, 文本);
   ObjectSetString(0, 名称, OBJPROP_FONT, 字体名称);
   ObjectSetInteger(0, 名称, OBJPROP_FONTSIZE, 基础字号);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 文字色);
   ObjectSetInteger(0, 名称, OBJPROP_BGCOLOR, 背景色);
   ObjectSetInteger(0, 名称, OBJPROP_BORDER_COLOR, 背景色);
   ObjectSetInteger(0, 名称, OBJPROP_STATE, false);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, 名称, OBJPROP_ZORDER, 1);
  }

// 构建统计面板
void 构建统计面板()
  {
   int X = 面板起始X;      // 322
   int Y = 面板起始Y;      // 35
   int W = 面板宽度;       // 320
   int RH = 基础字号 * 2;  // 行高 20px
   int L  = 列_标签;       // 18  (标签列偏移)
   int V1 = 列_数值1;      // 155 (数值列1偏移)
   int V2 = 列_数值2;      // 302 (数值列2偏移)

   // ===== 背景 (高度470, 覆盖所有统计内容) =====
   创建矩形(统计面板名+"背景", X, Y, W, 470, Snow, (color)8421376, 10);

   // ===== 行1: 多空状态 (Y+12) =====
   string 多状态 = 运_多单允许 ? "多 ✓" : "多 ✗";
   color  多颜色 = 运_多单允许 ? clrGreen : clrTomato;
   创建文本(统计面板名+"多状态", X-L, Y+12, 多状态, 基础字号+1, 多颜色);

   string 空状态 = 运_空单允许 ? "空 ✓" : "空 ✗";
   color  空颜色 = 运_空单允许 ? clrGreen : clrTomato;
   创建文本(统计面板名+"空状态", X-V1, Y+12, 空状态, 基础字号+1, 空颜色);

   // ===== 获利统计区 (LightCyan背景, Y+30~Y+115) =====
   创建矩形(统计面板名+"获利区", X-10, Y+30, W-20, 82, LightCyan);
   创建文本(统计面板名+"获利标题", X-160, Y+34, "▌获利统计", 基础字号+1, clrBlack);

   double 今日获利 = 计算历史获利(0);
   double 昨日获利 = 计算历史获利(1);
   double 总计获利 = 计算历史获利(2);
   string 货币 = AccountInfoString(ACCOUNT_CURRENCY);

   绘制获利行(统计面板名+"今日", X-L, Y+54, "今日获利:", 今日获利, 货币);
   绘制获利行(统计面板名+"昨日", X-L, Y+72, "昨日获利:", 昨日获利, 货币);
   绘制获利行(统计面板名+"总计", X-L, Y+90, "总计获利:", 总计获利, 货币);

   // ===== 账户信息 (Y+122~Y+176) =====
   int 账户Y = Y + 125;
   创建文本(统计面板名+"余额名", X-L, 账户Y,       "账户余额:",   基础字号, clrTeal);
   创建文本(统计面板名+"余额值", X-V1, 账户Y,       DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2), 基础字号, clrTeal);

   创建文本(统计面板名+"净值名", X-L, 账户Y+RH,     "账户净值:",   基础字号, clrTeal);
   创建文本(统计面板名+"净值值", X-V1, 账户Y+RH,     DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2), 基础字号, clrGreen);

   创建文本(统计面板名+"比例名", X-L, 账户Y+RH*2,   "预付款比例:", 基础字号, clrTeal);
   double 保证金 = AccountInfoDouble(ACCOUNT_MARGIN);
   double 比例 = (保证金 > 0) ? AccountInfoDouble(ACCOUNT_EQUITY) / 保证金 * 100.0 : 0;
   创建文本(统计面板名+"比例值", X-V1, 账户Y+RH*2,   DoubleToString(比例, 2) + "%", 基础字号, clrDarkBlue);

   // ===== 账号浮盈区 (Y+192~Y+257, 高度65) =====
   int 浮盈Y = Y + 195;
   double 账号盈亏 = AccountInfoDouble(ACCOUNT_PROFIT);
   color 浮盈背景 = (账号盈亏 > 0) ? Honeydew : (账号盈亏 < 0 ? MistyRose : Snow);
   string 浮盈标签 = (运_多单数量 + 运_空单数量 == 0) ? "账号空仓：" :
                     (账号盈亏 >= 0 ? "账号盈利：" : "账号亏损：");
   color 浮盈颜色 = (运_多单数量 + 运_空单数量 == 0) ? LightSkyBlue :
                    (账号盈亏 >= 0 ? clrBrown : clrCrimson);

   创建矩形(统计面板名+"账号浮盈背景", X-125, 浮盈Y, 185, 65, 浮盈背景);
   创建文本(统计面板名+"账号浮盈名",   X-127, 浮盈Y+6,  浮盈标签, 14, 浮盈颜色);
   创建文本(统计面板名+"账号浮盈值",   X-295, 浮盈Y+26, DoubleToString(账号盈亏, 2) + "$", 基础字号+2, 浮盈颜色);
   double 浮盈百分比 = (AccountInfoDouble(ACCOUNT_BALANCE) > 0) ? 账号盈亏 / AccountInfoDouble(ACCOUNT_BALANCE) * 100.0 : 0;
   创建文本(统计面板名+"账号浮盈百分", X-280, 浮盈Y+44, DoubleToString(浮盈百分比, 2) + "%", 基础字号, 浮盈颜色);

   // ===== EA浮盈区 (Y+268~Y+333, 高度65) =====
   int EA浮盈Y = Y + 268;
   color EA背景 = (运_总盈亏 > 0) ? Honeydew : (运_总盈亏 < 0 ? MistyRose : Snow);
   string EA标签 = (运_多单数量 + 运_空单数量 == 0) ? "EA等开仓：" :
                   (运_总盈亏 >= 0 ? "EA浮盈：" : "EA浮亏：");
   color EA颜色 = (运_多单数量 + 运_空单数量 == 0) ? LightSkyBlue :
                  (运_总盈亏 >= 0 ? clrBrown : clrCrimson);

   创建矩形(统计面板名+"EA浮盈背景", X-125, EA浮盈Y, 185, 65, EA背景);
   创建文本(统计面板名+"EA浮盈名",   X-127, EA浮盈Y+6,  EA标签, 14, EA颜色);
   创建文本(统计面板名+"EA浮盈值",   X-295, EA浮盈Y+26, DoubleToString(运_总盈亏, 2) + "$", 基础字号+2, EA颜色);

   // ===== 持仓汇总 (Y+345~Y+405) =====
   int 汇总Y = Y + 348;

   color 多单盈亏色 = (运_多单盈亏 >= 0) ? (color)9109504 : (color)3937500;
   创建文本(统计面板名+"买单名", X-L,  汇总Y,       "买单:", 基础字号, clrCadetBlue);
   创建文本(统计面板名+"买单手", X-V1, 汇总Y,       DoubleToString(运_多单手数, 2) + "手", 基础字号, clrDarkBlue);
   创建文本(统计面板名+"买单盈", X-V2, 汇总Y,       DoubleToString(运_多单盈亏, 2) + " " + 货币, 基础字号, 多单盈亏色);

   color 空单盈亏色 = (运_空单盈亏 >= 0) ? (color)9109504 : (color)3937500;
   创建文本(统计面板名+"卖单名", X-L,  汇总Y+RH,    "卖单:", 基础字号, clrTomato);
   创建文本(统计面板名+"卖单手", X-V1, 汇总Y+RH,    DoubleToString(运_空单手数, 2) + "手", 基础字号, clrTomato);
   创建文本(统计面板名+"卖单盈", X-V2, 汇总Y+RH,    DoubleToString(运_空单盈亏, 2) + " " + 货币, 基础字号, 空单盈亏色);

   color 总盈亏色 = (运_总盈亏 >= 0) ? (color)9109504 : (color)3937500;
   创建文本(统计面板名+"总名", X-L,  汇总Y+RH*2,   "总共:", 基础字号, clrGreen);
   创建文本(统计面板名+"总手", X-V1, 汇总Y+RH*2,   DoubleToString(运_多单手数+运_空单手数, 2) + "手", 基础字号, clrDarkBlue);
   创建文本(统计面板名+"总盈", X-V2, 汇总Y+RH*2,   DoubleToString(运_总盈亏, 2) + " " + 货币, 基础字号, 总盈亏色);

   // ===== 分隔线 (Y+420) =====
   int 分隔Y = Y + 420;
   创建矩形(统计面板名+"分隔线", X-10, 分隔Y, W-20, 1, PowderBlue);

   // ===== EA名称 =====
   创建文本(统计面板名+"EA名", X-170, 分隔Y+6, MQLInfoString(MQL_PROGRAM_NAME), 基础字号, clrGreen);

   // ===== 展开/收起按钮 =====
   string 按钮文本 = 运_按钮面板可见 ? "▼ 收起" : "▲ 展开";
   创建按钮(统计面板名+"展开收起", X-260, 分隔Y+5, 55, 22, 按钮文本, clrPowderBlue, clrBlack);

   // 按钮面板起始Y
   运_按钮面板起始Y = 分隔Y + 35;

   ChartRedraw(0);
  }

// 绘制获利行：标签→数值→百分比 三列对齐
void 绘制获利行(string 前缀, int X_标签, int Y, string 标签名, double 金额, string 货币)
  {
   int X_数值 = 面板起始X - 列_数值1;  // 数值列
   int X_百分 = 面板起始X - 列_数值2;  // 百分比列

   color 颜色 = (金额 >= 0) ? (color)25600 : (color)3937500;
   创建文本(前缀+"名",   X_标签, Y, 标签名, 基础字号, clrBlack);
   创建文本(前缀+"值",   X_数值, Y, DoubleToString(金额, 2) + "  " + 货币, 基础字号, 颜色);

   double 基数 = 计算历史获利基数();
   double 百分比 = (基数 > 0) ? 金额 / 基数 * 100.0 : 0;
   创建文本(前缀+"百分", X_百分, Y, DoubleToString(百分比, 2) + "%", 基础字号, 颜色);
  }

// 计算历史获利：0=今日, 1=昨日, 2=全部
double 计算历史获利(int 模式)
  {
   datetime now = TimeCurrent();
   datetime todayStart = StringToTime(TimeToString(now, TIME_DATE));
   datetime yesterdayStart = todayStart - 86400;

   datetime 开始时间, 结束时间;
   if(模式 == 0)      { 开始时间 = todayStart;     结束时间 = now; }
   else if(模式 == 1) { 开始时间 = yesterdayStart;  结束时间 = todayStart; }
   else               { 开始时间 = 0;               结束时间 = now; }

   if(!HistorySelect(开始时间, 结束时间)) return 0;

   double 总利润 = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(ticket, DEAL_MAGIC) != 入_魔术号) continue;

      long 入场 = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(入场 != DEAL_ENTRY_OUT && 入场 != DEAL_ENTRY_OUT_BY) continue;

      总利润 += HistoryDealGetDouble(ticket, DEAL_PROFIT) +
                HistoryDealGetDouble(ticket, DEAL_SWAP) +
                HistoryDealGetDouble(ticket, DEAL_COMMISSION);
     }
   return 总利润;
  }

// 计算历史获利基数（总入金）
double 计算历史获利基数()
  {
   datetime now = TimeCurrent();
   if(!HistorySelect(0, now)) return 0;

   double 总入金 = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      long 类型 = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(类型 == DEAL_TYPE_BALANCE || 类型 == DEAL_TYPE_CREDIT)
         总入金 += HistoryDealGetDouble(ticket, DEAL_PROFIT);
     }
   return MathAbs(总入金);
  }

//=====================================================================
// 第十四部分：按钮面板（100%复刻MQ4原版）
//=====================================================================
void 构建按钮面板()
  {
   int X = 面板起始X;
   int Y = 运_按钮面板起始Y;
   int W = 面板宽度;
   int 全宽 = W - 20;              // 300
   int 半宽 = (W - 30) / 2;       // 145
   int 行高 = 34;
   int 按钮高 = 28;

   // 背景
   创建矩形(按钮面板名+"背景", X, Y, W, 225, PowderBlue, (color)15453831);

   int 一行Y = Y + 5;
   int 二行Y = 一行Y + 行高;
   int 三行Y = 二行Y + 行高;
   int 四行Y = 三行Y + 行高;
   int 五行Y = 四行Y + 行高;
   int 六行Y = 五行Y + 行高;

   // 行1：停止交易（全宽）
   string 停止文本 = (运_多单允许 || 运_空单允许) ? "⏸  停止交易" : "▶  开启交易";
   color  停止颜色 = (运_多单允许 || 运_空单允许) ? clrSteelBlue : clrBrown;
   创建按钮(按钮面板名+"停止交易", X-10, 一行Y, 全宽, 按钮高, 停止文本, 停止颜色);

   // 行2：停止做多 + 停止做空
   string 多文本 = 运_多单允许 ? "⏸  停止做多" : "▶  开启做多";
   color  多颜色 = 运_多单允许 ? clrSteelBlue : clrBrown;
   创建按钮(按钮面板名+"停止做多", X-10, 二行Y, 半宽, 按钮高, 多文本, 多颜色);

   string 空文本 = 运_空单允许 ? "⏸  停止做空" : "▶  开启做空";
   color  空颜色 = 运_空单允许 ? clrSteelBlue : clrBrown;
   创建按钮(按钮面板名+"停止做空", X-10+半宽+10, 二行Y, 半宽, 按钮高, 空文本, 空颜色);

   // 行3：获利单平仓 + 亏损单平仓
   创建按钮(按钮面板名+"获利单平仓", X-10, 三行Y, 半宽, 按钮高, "获利单平仓", clrTeal);
   创建按钮(按钮面板名+"亏损单平仓", X-10+半宽+10, 三行Y, 半宽, 按钮高, "亏损单平仓", clrTeal);

   // 行4：多单平仓 + 空单平仓
   创建按钮(按钮面板名+"多单平仓", X-10, 四行Y, 半宽, 按钮高, "多单平仓", clrTeal);
   创建按钮(按钮面板名+"空单平仓", X-10+半宽+10, 四行Y, 半宽, 按钮高, "空单平仓", clrTeal);

   // 行5：Symbol全部平仓 + EA全部平仓
   创建按钮(按钮面板名+"品种全部平仓", X-10, 五行Y, 半宽, 按钮高, _Symbol+"全平", clrTeal);
   创建按钮(按钮面板名+"EA全部平仓",   X-10+半宽+10, 五行Y, 半宽, 按钮高, "EA全平", clrTeal);

   // 行6：账号全部平仓（全宽）
   创建按钮(按钮面板名+"账号全部平仓", X-10, 六行Y, 全宽, 按钮高, "账号全部平仓", clrSeaGreen);

   ChartRedraw(0);
  }

// 更新统计面板（刷新动态数据）
void 更新统计面板()
  {
   // 删除旧面板并重建
   删除面板对象(统计面板名);
   删除面板对象(按钮面板名);

   if(运_统计面板可见)
      构建统计面板();

   if(运_按钮面板可见)
      构建按钮面板();
  }

// 删除指定前缀的所有图表对象
void 删除面板对象(string 前缀)
  {
   int total = ObjectsTotal(0, -1, -1);
   for(int i = total - 1; i >= 0; i--)
     {
      string name = ObjectName(0, i);
      if(StringFind(name, 前缀) == 0)
         ObjectDelete(0, name);
     }
  }

//=====================================================================
// 第十五部分：按钮事件处理
//=====================================================================
void 处理按钮点击(string 对象名)
  {
   // --- 停止交易 ---
   if(对象名 == 按钮面板名+"停止交易")
     {
      bool 当前运行 = (运_多单允许 || 运_空单允许);
      运_多单允许 = !当前运行;
      运_空单允许 = !当前运行;
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 停止做多 ---
   if(对象名 == 按钮面板名+"停止做多")
     {
      运_多单允许 = !运_多单允许;
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 停止做空 ---
   if(对象名 == 按钮面板名+"停止做空")
     {
      运_空单允许 = !运_空单允许;
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 获利单平仓 ---
   if(对象名 == 按钮面板名+"获利单平仓")
     {
      获利单平仓();
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 亏损单平仓 ---
   if(对象名 == 按钮面板名+"亏损单平仓")
     {
      亏损单平仓();
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 多单平仓 ---
   if(对象名 == 按钮面板名+"多单平仓")
     {
      批量平仓(1);
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 空单平仓 ---
   if(对象名 == 按钮面板名+"空单平仓")
     {
      批量平仓(-1);
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 品种全部平仓 ---
   if(对象名 == 按钮面板名+"品种全部平仓")
     {
      品种全部平仓();
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- EA全部平仓 ---
   if(对象名 == 按钮面板名+"EA全部平仓")
     {
      批量平仓(0);
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 账号全部平仓 ---
   if(对象名 == 按钮面板名+"账号全部平仓")
     {
      账号全部平仓();
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }

   // --- 统计面板展开/收起 ---
   if(对象名 == 统计面板名+"展开收起")
     {
      运_按钮面板可见 = !运_按钮面板可见;
      ObjectSetInteger(0, 对象名, OBJPROP_STATE, false);
      更新统计面板();
      return;
     }
  }

// 获利单平仓（按Magic过滤，当前品种，MQ4原版逻辑）
void 获利单平仓()
  {
   for(int 尝试 = 0; 尝试 < 10; 尝试++)
     {
      bool 本轮有操作 = false;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;

         double 盈亏 = PositionGetDouble(POSITION_PROFIT) +
                       PositionGetDouble(POSITION_SWAP);
         if(盈亏 < 0) continue;

         if(平仓持仓(ticket)) 本轮有操作 = true;
        }
      if(!本轮有操作) break;
      Sleep(1000);
     }
  }

// 亏损单平仓（按Magic过滤，当前品种，MQ4原版逻辑）
void 亏损单平仓()
  {
   for(int 尝试 = 0; 尝试 < 10; 尝试++)
     {
      bool 本轮有操作 = false;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != 入_魔术号) continue;

         double 盈亏 = PositionGetDouble(POSITION_PROFIT) +
                       PositionGetDouble(POSITION_SWAP);
         if(盈亏 >= 0) continue;

         if(平仓持仓(ticket)) 本轮有操作 = true;
        }
      if(!本轮有操作) break;
      Sleep(1000);
     }
  }

// 品种全部平仓（当前品种，任意Magic）
void 品种全部平仓()
  {
   for(int 尝试 = 0; 尝试 < 10; 尝试++)
     {
      bool 本轮有操作 = false;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;

         if(平仓持仓(ticket)) 本轮有操作 = true;
        }

      // 删除当前品种挂单
      for(int i = OrdersTotal() - 1; i >= 0; i--)
        {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;

         if(取消挂单(ticket)) 本轮有操作 = true;
        }

      if(!本轮有操作) break;
      Sleep(1000);
     }
  }

// 账号全部平仓（所有品种，所有Magic）
void 账号全部平仓()
  {
   for(int 尝试 = 0; 尝试 < 10; 尝试++)
     {
      bool 本轮有操作 = false;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;

         if(平仓持仓(ticket)) 本轮有操作 = true;
        }

      for(int i = OrdersTotal() - 1; i >= 0; i--)
        {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;

         if(取消挂单(ticket)) 本轮有操作 = true;
        }

      if(!本轮有操作) break;
      Sleep(1000);
     }
  }

//=====================================================================
// 第十六部分：MQL5 生命周期函数
//=====================================================================
int OnInit()
  {
   // 检查对冲账户
   if(!是对冲账户())
     {
      Alert("❌ 本EA需要对冲(Hedging)账户！当前账户不支持。");
      return INIT_FAILED;
     }

   // 初始化运行时变量
   运_EA名称 = MQLInfoString(MQL_PROGRAM_NAME);
   运_滑点 = 入_滑点;

   // 设置定时器（用于面板刷新）
   EventSetTimer(3);

   // 绘制价格限制线
   绘制价格限制线();

   // 构建面板
   构建统计面板();

   PrintFormat("✅ %s 初始化完成 | 魔术号=%d | 品种=%s",
               运_EA名称, 入_魔术号, _Symbol);

   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   // 删除所有面板对象
   删除面板对象(面板前缀);

   // 删除平均价线
   ObjectDelete(0, "多单均价线");
   ObjectDelete(0, "空单均价线");

   // 删除价格限制线
   ObjectDelete(0, "买首单上限");
   ObjectDelete(0, "卖首单下限");
   ObjectDelete(0, "买补单上限");
   ObjectDelete(0, "卖补单下限");

   EventKillTimer();
   ChartRedraw(0);

   PrintFormat("❌ %s 已卸载，原因=%d", 运_EA名称, reason);
  }

void OnTimer()
  {
   // 定时刷新面板
   更新持仓状态();
   更新统计面板();
  }

void OnTick()
  {
   // Step 1: 更新持仓状态
   更新持仓状态();

   // Step 2: 风控检查
   if(!检查风控条件())
     {
      运_多单允许 = false;
      运_空单允许 = false;
     }
   else
     {
      // 恢复UI设置（如果不是手动停止）
      // 注意：不自动恢复，尊重用户手动操作
     }

   // Step 3: EA时间检查
   if(!在EA时间内())
     {
      运_多单允许 = false;
      运_空单允许 = false;
     }

   // Step 4: 暂停检查
   if(运_暂停)
     {
      更新统计面板();
      return;
     }

   // Step 5: 检查平仓条件
   检查平仓条件();

   // Step 6: 挂单追踪
   挂单追踪();

   // Step 7: 检查开仓
   if(运_多单允许)
      检查多单开仓();

   if(运_空单允许)
      检查空单开仓();

   // Step 8: 绘制平均价线
   绘制平均价线();

   // Step 9: 更新面板
   更新统计面板();
  }

void OnChartEvent(const int id, const long& lparam, const double& dparam, const string& sparam)
  {
   if(id == CHARTEVENT_OBJECT_CLICK)
     {
      处理按钮点击(sparam);
     }
  }
//+------------------------------------------------------------------+

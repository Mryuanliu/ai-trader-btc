//+------------------------------------------------------------------+
//|                                            恒鑫EA量化.mq5        |
//+------------------------------------------------------------------+
#property description "声明:"
#property description "1.本EA只作为交易辅助工具，不作任何盈利保证；"
#property description "2.投资风险，入市需谨慎；"
#property description "3.用本软件参与一切非法行为，与作者和本软件无关；"
#property description "4.EA属于虚拟产品一旦发货正常加载使用不支持退货退款。"
#property description "5.联系微信：num7000"
//#property version   "V16"
#property strict
//#resource "bg.bmp"  // 背景图片资源(编译进ex5,发别人也能看到)

#include <Trade\Trade.mqh>
//+------------------------------------------------------------------+
//| 本EA仅支持马丁加仓模式                                           |
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| 画线模式枚举                                                     |
//+------------------------------------------------------------------+
enum ENUM_LINE_MODE
{
   LINE_BODY = 0,          // 0
   LINE_WHOLE = 1          // 1
};

//+------------------------------------------------------------------+
//| ATR过滤模式枚举                                                  |
//+------------------------------------------------------------------+
enum ENUM_ATR_MODE
{
   ATR_NONE = 0,           // 0
   ATR_BODY = 1,           // 1
   ATR_WHOLE = 2           // 2
};

//+------------------------------------------------------------------+
//| 授权参数(不显示在参数页面)                                       |
//+------------------------------------------------------------------+
string   g_authAccount  = "3056431,3034916,1156321";               // 授权账号(英文逗号隔开 空=不限)
string   g_licenseKey   = "V8-2026";        // 授权密钥
datetime g_expiryDate   = D'2029.08.1';    // 授权到期日

//+------------------------------------------------------------------+
//| 输入参数                                                         |
//+------------------------------------------------------------------+
input group "════════════ 基础设置 ══════════════"
input ENUM_TIMEFRAMES InpPeriod = PERIOD_M1;       // 交易周期
input bool     InpEnableDualGroup = true;          // 双组模式(关=单组A)
int      InpABOpenGapBars   = 0;             // AB组开仓间隔(K线数)

input group "════════════ 马丁加仓模式 ════════════"
int      InpAddMode        = 1;              // 加仓模式:0=固定间隔,1=阶梯间隔
int      InpAddDistance    = 500;            // 固定加仓间隔(点) [模式0使用]
input string   InpStageAddDistances = "100,200,300,400,500"; // 阶梯间隔序列(点,逗号分隔) [模式1使用]
input string   InpLotSequence    = "0.01,0.01";    // 自定义加仓手数
input double   InpLossAmount     = 25;             // 止损金额


bool     InpUseAddTracking    = true;        // 启用追踪加仓
int      InpAddTriggerPoints  = 30;          // 突破挂单距离点
int      InpAddTrailPoints    = 20;          // 挂单追踪步长


int      InpTrailStep    = 10;               // 移动止盈步长
int      InpFirstTrailActive = 100;          // 马丁首单:移动止盈激活点数
int      InpAddTrailActive = 30;             // 马丁加仓后:移动止盈激活点数

input group "════════════ 过滤条件 ══════════════"
input ENUM_LINE_MODE InpLineMode = LINE_BODY;      // 画线模式
input ENUM_ATR_MODE InpATRMode = ATR_BODY;         // ATR过滤模式
int      InpEMAPeriod   = 10;                // EMA周期
int      InpATRPeriod    = 14;               // ATR周期
double   InpATRMultiple  = 1.0;              // ATR倍数

double   InpFractalProtectionAmount =5000000;    // 分型保护金额(浮亏达到此金额平仓)


double   InpNetProtectionDistance = 1000;    // 结余保护距离
bool     InpUseNetProtection = false;        // 结余保护开关
int      InpMaxLosses    = 99;               // 连续止损次数触发暂停
int      InpPauseMinutes = 30;               // 暂停时长(分钟)


int      InpCloseRetryMs    = 2000;          // 平仓重试间隔(毫秒)
int      InpCloseMaxRetries = 5;             // 平仓最大重试次数
int      InpMagicNumber  = 20268888;         // 幻数
int      InpMaxSlippage  = 30;               // 最大滑点(点)
string   InpComment      = "突破开仓";       // 订单注释

input string   InpNoTradeWindow = "="; // 禁止时段(北京时间),"-"=禁用
input group "════════════ 界面设置 ══════════════"
input int      InpUIFontSize   = 15;               // 字体大小
input color    InpUIBgColor    = clrBlack;         // 背景颜色
input color    InpUITextColor  = clrWhite;         // 文字颜色
input int      InpUIWidth      = 410;              // 面板宽度
input int      InpUIX          = 0;               // 左边距
input int      InpUIY          = 20;               // 上边距
input bool     InpShowBgImage  = true;             // 显示背景图片

//+------------------------------------------------------------------+
//| 状态                                                             |
//+------------------------------------------------------------------+
enum EA_STATE
{
   STATE_WAIT_FIRST_CANDLE,    // 等第一根K线收盘
   STATE_WAIT_SIGNAL,          // 等信号
   STATE_IN_TRADE,             // 持仓中
   STATE_CLOSING,              // 异步平仓中
   STATE_WAIT_AFTER_CLOSE      // 平仓后等K线收盘
};

//+------------------------------------------------------------------+
//| 全局变量                                                         |
//+------------------------------------------------------------------+
CTrade  trade;
EA_STATE g_state = STATE_WAIT_FIRST_CANDLE;

#define GROUP_COUNT 2
string g_groupNames[GROUP_COUNT] = {"A", "B"};
int    g_groupMagics[GROUP_COUNT];
bool   g_groupClosing[GROUP_COUNT] = {false, false};
int    g_ctxGroup = 0; // 当前上下文组(0=A,1=B)
datetime g_groupLastOpenBarTime[GROUP_COUNT] = {0, 0}; // 记录每组最近开仓K线时间

struct GROUP_RUNTIME
{
   int     direction;
   int     orderTickets[50];
   double  orderLots[50];
   double  orderPrices[50];
   int     orderCount;
   double  totalLots;
   double  avgPrice;
   double  entryPrice;
   double  SL;
   double  trailLine;
   bool    trailActive;
   bool    isFirstOrder;
   string  closeReason;
   double  closeProfit;
   int     closeRetries;
   bool    autoTradingWarned;
   datetime closeRequestTime;
   ulong   closeTickets[50];
   int     closeTicketCount;
   bool    addTrackingActive;
   double  addExtremePrice;
   double  addTriggerPrice;
   datetime closeBarTime;     // 平仓时的K线时间(防同K线重开)
   bool    kLineTraded;        // 组内K线已交易标记
   bool    isOpening;          // 该组是否正在开仓（防止并发）
};

GROUP_RUNTIME g_groupRt[GROUP_COUNT];

// 启动时记录的时间
datetime g_startBarTime = 0;
datetime g_prevBarTime = 0;
bool     g_firstBarChecked = false;

// 标记K线数据
double  g_kOpen    = 0;
double  g_kHigh    = 0;
double  g_kLow     = 0;
double  g_kClose   = 0;
double  g_kATR     = 0;
datetime g_candleTime = 0;

// EMA单均线方向
int     g_bias        = 0;     // 1=多头排列 -1=空头排列 0=不明
bool    g_emaReady    = false; // 单均线就绪
double  g_emaVal    = 0;     // 单EMA当前值
bool    g_atrOk    = false;

// 当前持仓方向
int     g_direction = 0;

// 加仓模式持仓数组
int     g_orderTickets[50];
double  g_orderLots[50];
double  g_orderPrices[50];
int     g_orderCount = 0;
double  g_totalLots  = 0;
double  g_avgPrice   = 0;

// 自定义手数序列数组
double  g_lotSequence[50];
int     g_maxOrders = 0;

// 阶梯加仓间隔数组
double  g_stageDistances[50];   // 存储解析后的阶梯间隔
int     g_stageCount = 0;       // 间隔个数

// 止盈相关
double  g_entryPrice    = 0;
double  g_SL            = 0;
double  g_trailLine     = 0;
bool    g_trailActive   = false;
bool    g_isFirstOrder  = true;

// 每K线一次限制
bool   g_kLineTraded   = false;  // [FIX1] 工作变量，per-group持久化在GROUP_RUNTIME中
datetime g_signalUsedBarTime = 0;   // 任意组开仓后记录K线时间，同K线禁止另一组开仓
datetime g_closeBarTime = 0;

// 异步平仓相关
string  g_closeReason      = "";       // 平仓原因
double  g_closeProfit      = 0;        // 平仓时记录的盈亏
int     g_closeRetries     = 0;        // 已重试次数
bool    g_autoTradingWarned = false;   // 防止10027重复警告
datetime g_closeRequestTime = 0;       // 上次平仓请求时间
ulong   g_closeTickets[50];            // 待平仓单号
int     g_closeTicketCount = 0;        // 待平仓单数

// 指标句柄
int     g_atrHandle  = INVALID_HANDLE;
int     g_emaHandle = INVALID_HANDLE;   // 单EMA句柄

// 画线
string  g_lineHighName   = "EMA2_High";
string  g_lineLowName    = "EMA2_Low";
string  g_lineSLName     = "EMA2_SL_A";
string  g_lineTrailName  = "EMA2_Trail_A";
string  g_lineAvgName    = "EMA2_Avg_A";

// 今日统计
int     g_todayWins    = 0;
int     g_todayLosses   = 0;
double  g_todayProfit  = 0;
datetime g_todayDate   = 0;

// 累计统计(跨EA重启保留)
int     g_stat_totalTrades = 0;     // 总交易次数
int     g_stat_wins        = 0;     // 盈利次数
int     g_stat_losses      = 0;     // 亏损次数
double  g_stat_totalProfit = 0;    // 累计盈利金额
double  g_stat_totalLoss   = 0;    // 累计亏损金额
double  g_stat_maxProfit   = 0;    // 最大单笔盈利
double  g_stat_maxLoss     = 0;    // 最大单笔亏损

bool    g_isAuthorized = false;
string  g_gvPrefix     = "EMA2_";



// 连续止损暂停变量
int     g_consecutiveLosses = 0;    // 连续止损次数
datetime g_pauseUntilTime = 0;      // 暂停截止时间

// 结余保护变量
bool    g_permanentlyStopped = false;   // 永久停止标志
double  g_maxBalance = 0;               // 最大结余(只升不降)

// 今日最大浮盈浮亏
double  g_todayMaxProfit = 0;          // 今日最大浮盈
double  g_todayMaxLoss = 0;            // 今日最大浮亏

// UI对象前缀
string  g_uiPrefix = "EMA2_UI_";
// 禁止时段(北京时间)
bool    g_inNoTradeWindow = false;   // 当前是否在禁止时段
datetime g_noTradeStartBarTime = 0;  // 被禁止开仓的K线时间(封锁一根K)

string  g_closeBtnName = "EMA2_UI_CloseBtn";
string  g_closeBtnAName = "EMA2_UI_CloseBtnA";
string  g_closeBtnBName = "EMA2_UI_CloseBtnB";

// 马丁追踪加仓相关变量
bool    g_addTrackingActive = false;     // 追踪加仓是否激活
double  g_addExtremePrice = 0;           // 极端价(做空=最高,做多=最低)
double  g_addTriggerPrice = 0;           // 挂单线价格
string  g_lineAddName = "EMA_AddTrigger_A"; // 挂单线名称

// 分型保护变量(按组)
bool    g_fractalPending[GROUP_COUNT] = {false, false};       // 分型触发待观察标记

//+------------------------------------------------------------------+
//| 解析阶梯间隔序列                                                 |
//+------------------------------------------------------------------+
void ParseStageDistances(string seqStr, double &dists[], int &count)
{
   ArrayInitialize(dists, 0);
   count = 0;
   string parts[];
   int n = StringSplit(seqStr, ',', parts);
   for(int i = 0; i < n; i++)
   {
      string s = parts[i];
      StringReplace(s, " ", "");
      if(StringLen(s) == 0) continue;
      double val = StringToDouble(s);
      if(val > 0)
      {
         dists[count] = val;
         count++;
         if(count >= 50) break;
      }
   }
}

//+------------------------------------------------------------------+
//| 获取当前加仓间隔（根据模式和订单数）                              |
//+------------------------------------------------------------------+
double GetCurrentAddDistance()
{
   if(InpAddMode == 0)  // 固定间隔
      return InpAddDistance;
   else  // 阶梯间隔
   {
      // g_orderCount 是当前持仓订单数（含首单），第N次加仓对应的索引为 N-1 = g_orderCount - 1
      int idx = g_orderCount - 1;  // 因为首单时 g_orderCount=1, 首次加仓应取序列第0个
      if(idx < 0) idx = 0;
      if(idx >= g_stageCount)
         idx = g_stageCount - 1;
      if(g_stageCount == 0) return InpAddDistance; // 容错
      return g_stageDistances[idx];
   }
}

//+------------------------------------------------------------------+
//| 双组上下文                                                        |
//+------------------------------------------------------------------+
int CurrentGroupMagic()
{
   return g_groupMagics[g_ctxGroup];
}

string CurrentGroupTag()
{
   return g_groupNames[g_ctxGroup];
}

string CurrentGroupComment()
{
   return InpComment + "_" + CurrentGroupTag();
}

void SetGroupContext(int group)
{
   if(group < 0 || group >= GROUP_COUNT) return;
   g_ctxGroup = group;
   trade.SetExpertMagicNumber(CurrentGroupMagic());
   g_lineSLName = "EMA2_SL_" + CurrentGroupTag();
   g_lineTrailName = "EMA2_Trail_" + CurrentGroupTag();
   g_lineAvgName = "EMA2_Avg_" + CurrentGroupTag();
   g_lineAddName = "EMA2_AddTrigger_" + CurrentGroupTag();
}

bool HasGroupPosition(int group)
{
   int oldGroup = g_ctxGroup;
   SetGroupContext(group);
   bool found = false;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(!PositionSelectByTicket(tk)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != CurrentGroupMagic()) continue;
      found = true;
      break;
   }
   SetGroupContext(oldGroup);
   return found;
}

bool HasAnyGroupPosition()
{
   for(int g = 0; g < GROUP_COUNT; g++)
   {
      if(HasGroupPosition(g)) return true;
   }
   return false;
}

int MaxWorkingGroups()
{
   return InpEnableDualGroup ? GROUP_COUNT : 1;
}

bool PassABOpenGapForGroup(int targetGroup)
{
   // 单组模式不需要AB间隔限制
   if(!InpEnableDualGroup) return true;

   // 仅当另一组当前有持仓/平仓流程中时,才限制AB开仓间隔
   datetime refOpenBar = 0;
   for(int g = 0; g < GROUP_COUNT; g++)
   {
      if(g == targetGroup) continue;
      if(!HasGroupPosition(g) && !g_groupClosing[g]) continue;
      if(g_groupLastOpenBarTime[g] > refOpenBar)
         refOpenBar = g_groupLastOpenBarTime[g];
   }
   if(refOpenBar <= 0) return true;

   int shift = iBarShift(_Symbol, InpPeriod, refOpenBar, false);
   if(shift < 0) return true;

   int minShift = MathMax(0, InpABOpenGapBars) + 1;
   return (shift >= minShift);
}

int FindFreeGroup()
{
   int busy = 0;
   for(int g = 0; g < GROUP_COUNT; g++)
   {
      if(g_groupClosing[g] || HasGroupPosition(g)) busy++;
   }
   if(busy >= MaxWorkingGroups()) return -1;

   for(int g = 0; g < GROUP_COUNT; g++)
   {
      if(g >= MaxWorkingGroups()) break;
      if(g_groupClosing[g]) continue;
      if(!HasGroupPosition(g)) return g;
   }
   return -1;
}

void ResetGroupRuntime(int group)
{
   if(group < 0 || group >= GROUP_COUNT) return;
   g_groupRt[group].direction = 0;
   ArrayInitialize(g_groupRt[group].orderTickets, 0);
   ArrayInitialize(g_groupRt[group].orderLots, 0);
   ArrayInitialize(g_groupRt[group].orderPrices, 0);
   g_groupRt[group].orderCount = 0;
   g_groupRt[group].totalLots = 0;
   g_groupRt[group].avgPrice = 0;
   g_groupRt[group].entryPrice = 0;
   g_groupRt[group].SL = 0;
   g_groupRt[group].trailLine = 0;
   g_groupRt[group].trailActive = false;
   g_groupRt[group].isFirstOrder = true;
   g_groupRt[group].closeReason = "";
   g_groupRt[group].closeProfit = 0;
   g_groupRt[group].closeRetries = 0;
   g_groupRt[group].autoTradingWarned = false;
   g_groupRt[group].closeRequestTime = 0;
   ArrayInitialize(g_groupRt[group].closeTickets, 0);
   g_groupRt[group].closeTicketCount = 0;
   g_groupRt[group].addTrackingActive = false;
   g_groupRt[group].addExtremePrice = 0;
   g_groupRt[group].addTriggerPrice = 0;
   g_groupRt[group].closeBarTime = 0;
   g_groupRt[group].isOpening = false;
}

void LoadGroupRuntime(int group)
{
   SetGroupContext(group);
   g_direction = g_groupRt[group].direction;
   ArrayCopy(g_orderTickets, g_groupRt[group].orderTickets);
   ArrayCopy(g_orderLots, g_groupRt[group].orderLots);
   ArrayCopy(g_orderPrices, g_groupRt[group].orderPrices);
   g_orderCount = g_groupRt[group].orderCount;
   g_totalLots = g_groupRt[group].totalLots;
   g_avgPrice = g_groupRt[group].avgPrice;
   g_entryPrice = g_groupRt[group].entryPrice;
   g_SL = g_groupRt[group].SL;
   g_trailLine = g_groupRt[group].trailLine;
   g_trailActive = g_groupRt[group].trailActive;
   g_isFirstOrder = g_groupRt[group].isFirstOrder;
   g_closeReason = g_groupRt[group].closeReason;
   g_closeProfit = g_groupRt[group].closeProfit;
   g_closeRetries = g_groupRt[group].closeRetries;
   g_autoTradingWarned = g_groupRt[group].autoTradingWarned;
   g_closeRequestTime = g_groupRt[group].closeRequestTime;
   ArrayCopy(g_closeTickets, g_groupRt[group].closeTickets);
   g_closeTicketCount = g_groupRt[group].closeTicketCount;
   g_addTrackingActive = g_groupRt[group].addTrackingActive;
   g_addExtremePrice = g_groupRt[group].addExtremePrice;
   g_addTriggerPrice = g_groupRt[group].addTriggerPrice;
   g_closeBarTime = g_groupRt[group].closeBarTime;
   g_kLineTraded = g_groupRt[group].kLineTraded;
}

void SaveGroupRuntime(int group)
{
   g_groupRt[group].direction = g_direction;
   ArrayCopy(g_groupRt[group].orderTickets, g_orderTickets);
   ArrayCopy(g_groupRt[group].orderLots, g_orderLots);
   ArrayCopy(g_groupRt[group].orderPrices, g_orderPrices);
   g_groupRt[group].orderCount = g_orderCount;
   g_groupRt[group].totalLots = g_totalLots;
   g_groupRt[group].avgPrice = g_avgPrice;
   g_groupRt[group].entryPrice = g_entryPrice;
   g_groupRt[group].SL = g_SL;
   g_groupRt[group].trailLine = g_trailLine;
   g_groupRt[group].trailActive = g_trailActive;
   g_groupRt[group].isFirstOrder = g_isFirstOrder;
   g_groupRt[group].closeReason = g_closeReason;
   g_groupRt[group].closeProfit = g_closeProfit;
   g_groupRt[group].closeRetries = g_closeRetries;
   g_groupRt[group].autoTradingWarned = g_autoTradingWarned;
   g_groupRt[group].closeRequestTime = g_closeRequestTime;
   ArrayCopy(g_groupRt[group].closeTickets, g_closeTickets);
   g_groupRt[group].closeTicketCount = g_closeTicketCount;
   g_groupRt[group].addTrackingActive = g_addTrackingActive;
   g_groupRt[group].addExtremePrice = g_addExtremePrice;
   g_groupRt[group].addTriggerPrice = g_addTriggerPrice;
   g_groupRt[group].closeBarTime = g_closeBarTime;
   g_groupRt[group].kLineTraded = g_kLineTraded;
}

//+------------------------------------------------------------------+
//| 持久化                                                            |
//+------------------------------------------------------------------+
void SaveState()
{
   GlobalVariableSet(g_gvPrefix + "state",        (double)g_state);
   GlobalVariableSet(g_gvPrefix + "prevBarTime",  (double)g_prevBarTime);
   // closeBarTime按组保存
   GlobalVariableSet(g_gvPrefix + "closeBarTime_0", (double)g_groupRt[0].closeBarTime);
   GlobalVariableSet(g_gvPrefix + "closeBarTime_1", (double)g_groupRt[1].closeBarTime);
   GlobalVariableSet(g_gvPrefix + "firstBarChecked", g_firstBarChecked ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "kOpen",        g_kOpen);
   GlobalVariableSet(g_gvPrefix + "kHigh",        g_kHigh);
   GlobalVariableSet(g_gvPrefix + "kLow",         g_kLow);
   GlobalVariableSet(g_gvPrefix + "kClose",       g_kClose);
   GlobalVariableSet(g_gvPrefix + "kATR",         g_kATR);
   GlobalVariableSet(g_gvPrefix + "candleTime",   (double)g_candleTime);
   GlobalVariableSet(g_gvPrefix + "bias",         (double)g_bias);
   GlobalVariableSet(g_gvPrefix + "emaReady",     g_emaReady ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "atrOk",        g_atrOk ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "direction",    (double)g_direction);
   // kLineTraded 按组保存，signalUsedBarTime 保持全局（跨组互斥）
   GlobalVariableSet(g_gvPrefix + "entryPrice",   g_entryPrice);
   GlobalVariableSet(g_gvPrefix + "SL",           g_SL);
   GlobalVariableSet(g_gvPrefix + "trailLine",    g_trailLine);
   GlobalVariableSet(g_gvPrefix + "trailActive",  g_trailActive ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "isFirstOrder", g_isFirstOrder ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "orderCount",   (double)g_orderCount);
   GlobalVariableSet(g_gvPrefix + "totalLots",    g_totalLots);
   GlobalVariableSet(g_gvPrefix + "avgPrice",     g_avgPrice);
   GlobalVariableSet(g_gvPrefix + "todayWins",    (double)g_todayWins);
   GlobalVariableSet(g_gvPrefix + "todayLosses",  (double)g_todayLosses);
   GlobalVariableSet(g_gvPrefix + "todayProfit",  g_todayProfit);
   GlobalVariableSet(g_gvPrefix + "todayDate",    (double)g_todayDate);

   // 连续止损暂停变量持久化
   GlobalVariableSet(g_gvPrefix + "consecutiveLosses", (double)g_consecutiveLosses);
   GlobalVariableSet(g_gvPrefix + "pauseUntilTime",    (double)g_pauseUntilTime);

   // 结余保护变量持久化
   GlobalVariableSet(g_gvPrefix + "permanentlyStopped", g_permanentlyStopped ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "maxBalance",         g_maxBalance);

   // 今日最大浮盈浮亏持久化
   GlobalVariableSet(g_gvPrefix + "todayMaxProfit",    g_todayMaxProfit);
   GlobalVariableSet(g_gvPrefix + "todayMaxLoss",      g_todayMaxLoss);

   // 脉冲模式变量持久化
   // 脉冲模式变量已删除

   // 追踪加仓变量持久化
   GlobalVariableSet(g_gvPrefix + "addTrackingActive", g_addTrackingActive ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "addExtremePrice",   g_addExtremePrice);
   GlobalVariableSet(g_gvPrefix + "addTriggerPrice",   g_addTriggerPrice);
   // 禁止时段变量持久化
   GlobalVariableSet(g_gvPrefix + "inNoTradeWindow", g_inNoTradeWindow ? 1.0 : 0.0);
   // 分型保护变量持久化(按组)
   GlobalVariableSet(g_gvPrefix + "fractalPending_0", g_fractalPending[0] ? 1.0 : 0.0);
   GlobalVariableSet(g_gvPrefix + "fractalPending_1", g_fractalPending[1] ? 1.0 : 0.0);
}

void LoadState()
{
   if(!GlobalVariableCheck(g_gvPrefix + "state")) return;

   if(GlobalVariableCheck(g_gvPrefix + "inNoTradeWindow"))
      g_inNoTradeWindow = (GlobalVariableGet(g_gvPrefix + "inNoTradeWindow") != 0);

   g_state       = (EA_STATE)(int)GlobalVariableGet(g_gvPrefix + "state");
   g_prevBarTime = (datetime)GlobalVariableGet(g_gvPrefix + "prevBarTime");
   // closeBarTime按组加载
   if(GlobalVariableCheck(g_gvPrefix + "closeBarTime_0"))
      g_groupRt[0].closeBarTime = (datetime)GlobalVariableGet(g_gvPrefix + "closeBarTime_0");
   else
      g_groupRt[0].closeBarTime = 0;
   if(GlobalVariableCheck(g_gvPrefix + "closeBarTime_1"))
      g_groupRt[1].closeBarTime = (datetime)GlobalVariableGet(g_gvPrefix + "closeBarTime_1");
   else
      g_groupRt[1].closeBarTime = 0;
   g_firstBarChecked = (GlobalVariableGet(g_gvPrefix + "firstBarChecked") != 0);
   g_kOpen       = GlobalVariableGet(g_gvPrefix + "kOpen");
   g_kHigh       = GlobalVariableGet(g_gvPrefix + "kHigh");
   g_kLow        = GlobalVariableGet(g_gvPrefix + "kLow");
   g_kClose      = GlobalVariableGet(g_gvPrefix + "kClose");
   g_kATR        = GlobalVariableGet(g_gvPrefix + "kATR");
   g_candleTime  = (datetime)GlobalVariableGet(g_gvPrefix + "candleTime");
   g_bias        = (int)GlobalVariableGet(g_gvPrefix + "bias");
   g_emaReady    = (GlobalVariableGet(g_gvPrefix + "emaReady") != 0);
   g_atrOk       = (GlobalVariableGet(g_gvPrefix + "atrOk") != 0);
   g_direction   = (int)GlobalVariableGet(g_gvPrefix + "direction");
   // kLineTraded 按组保存
   // signalUsedBarTime 保持全局
   g_entryPrice  = GlobalVariableGet(g_gvPrefix + "entryPrice");
   g_SL          = GlobalVariableGet(g_gvPrefix + "SL");
   g_trailLine   = GlobalVariableGet(g_gvPrefix + "trailLine");
   g_trailActive = (GlobalVariableGet(g_gvPrefix + "trailActive") != 0);
   g_isFirstOrder  = (GlobalVariableGet(g_gvPrefix + "isFirstOrder") != 0);
   g_orderCount  = (int)GlobalVariableGet(g_gvPrefix + "orderCount");
   g_totalLots   = GlobalVariableGet(g_gvPrefix + "totalLots");
   g_avgPrice    = GlobalVariableGet(g_gvPrefix + "avgPrice");

   g_todayWins   = (int)GlobalVariableGet(g_gvPrefix + "todayWins");
   g_todayLosses = (int)GlobalVariableGet(g_gvPrefix + "todayLosses");
   g_todayProfit = GlobalVariableGet(g_gvPrefix + "todayProfit");
   g_todayDate   = (datetime)GlobalVariableGet(g_gvPrefix + "todayDate");

   // 连续止损暂停变量恢复
   if(GlobalVariableCheck(g_gvPrefix + "consecutiveLosses"))
      g_consecutiveLosses = (int)GlobalVariableGet(g_gvPrefix + "consecutiveLosses");
   if(GlobalVariableCheck(g_gvPrefix + "pauseUntilTime"))
      g_pauseUntilTime = (datetime)GlobalVariableGet(g_gvPrefix + "pauseUntilTime");

   // 结余保护变量恢复
   if(GlobalVariableCheck(g_gvPrefix + "permanentlyStopped"))
      g_permanentlyStopped = (GlobalVariableGet(g_gvPrefix + "permanentlyStopped") != 0);
   if(GlobalVariableCheck(g_gvPrefix + "maxBalance"))
      g_maxBalance = GlobalVariableGet(g_gvPrefix + "maxBalance");

   // 今日最大浮盈浮亏恢复
   if(GlobalVariableCheck(g_gvPrefix + "todayMaxProfit"))
      g_todayMaxProfit = GlobalVariableGet(g_gvPrefix + "todayMaxProfit");
   if(GlobalVariableCheck(g_gvPrefix + "todayMaxLoss"))
      g_todayMaxLoss = GlobalVariableGet(g_gvPrefix + "todayMaxLoss");

   // 脉冲模式变量恢复



   // 追踪加仓变量恢复
   if(GlobalVariableCheck(g_gvPrefix + "addTrackingActive"))
      g_addTrackingActive = (GlobalVariableGet(g_gvPrefix + "addTrackingActive") != 0);
   if(GlobalVariableCheck(g_gvPrefix + "addExtremePrice"))
      g_addExtremePrice = GlobalVariableGet(g_gvPrefix + "addExtremePrice");
   if(GlobalVariableCheck(g_gvPrefix + "addTriggerPrice"))
      g_addTriggerPrice = GlobalVariableGet(g_gvPrefix + "addTriggerPrice");

   // 分型保护变量恢复(按组)
   if(GlobalVariableCheck(g_gvPrefix + "fractalPending_0"))
      g_fractalPending[0] = (GlobalVariableGet(g_gvPrefix + "fractalPending_0") != 0);
   if(GlobalVariableCheck(g_gvPrefix + "fractalPending_1"))
      g_fractalPending[1] = (GlobalVariableGet(g_gvPrefix + "fractalPending_1") != 0);

   // 跨日重置统计
   MqlDateTime dt;
   TimeToStruct(TimeLocal(), dt);
   datetime today = StringToTime(StringFormat("%04d.%02d.%02d", dt.year, dt.mon, dt.day));
   if(g_todayDate > 0 && today > g_todayDate)
   {
      g_todayWins = 0; g_todayLosses = 0; g_todayProfit = 0; g_todayDate = today;
      g_todayMaxProfit = 0; g_todayMaxLoss = 0;  // 同时清除最大浮盈浮亏
   }
   else if(g_todayDate == 0)
   {
      g_todayDate = today;  // 首次运行或GV不存在,只设日期不重置
   }

   // 异步平仓恢复:如果重启时还在STATE_CLOSING,检查持仓是否已平
   if(g_state == STATE_CLOSING)
   {
      Print("【恢复】检测到异步平仓状态,重新检查持仓...");
      // 不做任何操作,OnTick中的STATE_CLOSING会处理
   }
   }

//+------------------------------------------------------------------+
//| 保存累计统计数据(跨EA重启保留)                                  |
//+------------------------------------------------------------------+
void SaveStatistics()
{
   GlobalVariableSet(g_gvPrefix + "stat_totalTrades", (double)g_stat_totalTrades);
   GlobalVariableSet(g_gvPrefix + "stat_wins",        (double)g_stat_wins);
   GlobalVariableSet(g_gvPrefix + "stat_losses",      (double)g_stat_losses);
   GlobalVariableSet(g_gvPrefix + "stat_totalProfit", g_stat_totalProfit);
   GlobalVariableSet(g_gvPrefix + "stat_totalLoss",   g_stat_totalLoss);
   GlobalVariableSet(g_gvPrefix + "stat_maxProfit",   g_stat_maxProfit);
   GlobalVariableSet(g_gvPrefix + "stat_maxLoss",     g_stat_maxLoss);
}

//+------------------------------------------------------------------+
//| 加载累计统计数据                                                  |
//+------------------------------------------------------------------+
void LoadStatistics()
{
   if(GlobalVariableCheck(g_gvPrefix + "stat_totalTrades"))
   {
      g_stat_totalTrades = (int)GlobalVariableGet(g_gvPrefix + "stat_totalTrades");
      g_stat_wins        = (int)GlobalVariableGet(g_gvPrefix + "stat_wins");
      g_stat_losses      = (int)GlobalVariableGet(g_gvPrefix + "stat_losses");
      g_stat_totalProfit = GlobalVariableGet(g_gvPrefix + "stat_totalProfit");
      g_stat_totalLoss   = GlobalVariableGet(g_gvPrefix + "stat_totalLoss");
      g_stat_maxProfit   = GlobalVariableGet(g_gvPrefix + "stat_maxProfit");
      g_stat_maxLoss     = GlobalVariableGet(g_gvPrefix + "stat_maxLoss");
      Print("【统计数据恢复】总交易:", g_stat_totalTrades,
            " 盈:", g_stat_wins, " 亏:", g_stat_losses,
            " 净盈亏:$", DoubleToString(g_stat_totalProfit - g_stat_totalLoss, 2));
   }
}

//+------------------------------------------------------------------+
//| 重绘所有线(切换周期/参数后恢复)                                  |
//+------------------------------------------------------------------+
void RedrawLines()
{
   // 检查是否有区间数据
   if(g_kHigh > 0 && g_kLow > 0)
   {
      DrawRangeLines();
      Print("【重绘】区间线已恢复 高:", g_kHigh, " 低:", g_kLow);
   }

   // 检查是否有止损数据
   if(g_SL > 0)
   {
      DrawSLLine();
      Print("【重绘】止损线已恢复:", g_SL);
   }

   // 检查是否有追踪止盈线
   if(g_trailLine > 0 && g_trailActive)
   {
      DrawTrailLine();
      Print("【重绘】追踪线已恢复:", g_trailLine);
   }

   // 检查是否有均价线
   if(g_avgPrice > 0)
   {
      DrawAvgLine();
      Print("【重绘】均价线已恢复:", g_avgPrice);
   }

   // 检查是否有追踪加仓挂单线
   if(g_addTriggerPrice > 0 && g_addTrackingActive)
   {
      DrawAddTriggerLine();
      Print("【重绘】挂单线已恢复:", g_addTriggerPrice);
   }
}

//+------------------------------------------------------------------+
//| 清除运行时状态全局变量(保留统计数据)                            |
//+------------------------------------------------------------------+
void ClearRuntimeGlobals()
{
   // 清除运行时状态的全局变量,但保留统计数据(stat_xxx)
   string prefix = g_gvPrefix;
   int total = GlobalVariablesTotal();

   // 从后往前遍历,因为删除会改变索引
   for(int i = total - 1; i >= 0; i--)
   {
      string name = GlobalVariableName(i);
      // 只删除非统计数据、非今日统计的前缀匹配变量
      if(StringFind(name, prefix) == 0 && StringFind(name, "stat_") < 0 && StringFind(name, "today") < 0)
      {
         GlobalVariableDel(name);
      }
   }
   Print("【清理】运行时状态已清除,统计数据和今日统计已保留");
}

//+------------------------------------------------------------------+
//| 授权                                                              |
//+------------------------------------------------------------------+
bool CheckAuthorization()
{
   // 1. 检查授权账户(支持多个账号，用英文逗号分隔)
   if(g_authAccount != "")
   {
      long accountLogin = AccountInfoInteger(ACCOUNT_LOGIN);
      string accountStr = IntegerToString(accountLogin);
      
      // 将授权账号字符串按逗号分割成数组
      string authList[];
      int count = StringSplit(g_authAccount, ',', authList);
      bool authorized = false;
      
      for(int i = 0; i < count; i++)
      {
         // 去除可能的前后空格
         StringTrimLeft(authList[i]);
         StringTrimRight(authList[i]);
         if(authList[i] == accountStr)
         {
            authorized = true;
            break;
         }
      }
      
      if(!authorized)
      {
         Alert("【授权失败】账户未授权!\n当前账户: ", accountStr, "\n授权账户: ", g_authAccount);
         Print("【授权失败】当前账户:", accountStr, " 授权账户:", g_authAccount);
         return false;
      }
   }
   
   // 2. 检查授权密钥
   if(g_licenseKey != "" && g_licenseKey != "TRIAL")
   {
      bool keyOk = (g_licenseKey == "V2-2026") || (g_licenseKey == "V6-2026") || 
                   (g_licenseKey == "V8-2026") || (g_licenseKey == "V9-2026");
      if(!keyOk)
      {
         Alert("【授权失败】密钥无效!\n当前密钥: ", g_licenseKey);
         Print("【授权失败】密钥无效:", g_licenseKey);
         return false;
      }
   }
   
   // 3. 检查授权到期时间(服务器时间)
   datetime serverTime = TimeTradeServer();
   datetime localTime = TimeLocal();
   int offsetHours = (int)((serverTime - localTime) / 3600);
   datetime expiryUTC = g_expiryDate - offsetHours * 3600;
   if(serverTime >= expiryUTC)
   {
      Alert("【授权失败】授权已到期!\n服务器时间: ", TimeToString(serverTime, TIME_DATE), 
            "\n到期日: ", TimeToString(expiryUTC, TIME_DATE));
      Print("【授权失败】授权已到期,服务器时间:", TimeToString(serverTime, TIME_DATE), 
            " 到期日:", TimeToString(expiryUTC, TIME_DATE));
      return false;
   }
   
   Print("【授权成功】账户:", AccountInfoInteger(ACCOUNT_LOGIN),
         " 密钥:", g_licenseKey,
         " 到期:", TimeToString(expiryUTC, TIME_DATE),
         " 剩余:", (int)((expiryUTC - serverTime) / 86400), "天");
   return true;
}

//+------------------------------------------------------------------+
//| 授权到期检测 + 强制平仓停止                                       |
//+------------------------------------------------------------------+
void StopIfExpired()
{
   // 如果已经永久停止,跳过
   if(g_permanentlyStopped) return;

   datetime serverTime = TimeTradeServer();
   datetime localTime = TimeLocal();
   int offsetHours = (int)((serverTime - localTime) / 3600);
   datetime expiryUTC = g_expiryDate - offsetHours * 3600;

   if(serverTime < expiryUTC) return;  // 未到期

   // ========== 授权已到期,执行强制停止 ==========
   Print("【授权到期】服务器时间已超过授权到期日,强制平仓并停止EA");
   Alert("【授权到期】服务器时间已超过授权到期日!\n所有持仓将被平掉,EA将停止工作。\n到期日: ", TimeToString(expiryUTC, TIME_DATE));

   // 关闭所有A组持仓
   LoadGroupRuntime(0);
   DoClose("授权到期强制平仓");
   SaveGroupRuntime(0);

   // 关闭所有B组持仓
   LoadGroupRuntime(1);
   DoClose("授权到期强制平仓");
   SaveGroupRuntime(1);

   // 标记永久停止(OnTick中的IsPermanentlyStopped()会拦截后续所有交易)
   g_permanentlyStopped = true;
   Print("【授权到期】所有持仓已平,EA已永久停止");
}

//+------------------------------------------------------------------+
//| 获取当前运行中K线的时间                                           |
//+------------------------------------------------------------------+
datetime GetCurrentBarTime()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, InpPeriod, 0, 1, rates) < 1) return 0;
   return rates[0].time;
}

//+------------------------------------------------------------------+
//| 解析手数序列字符串(逗号分隔)                                      |
//+------------------------------------------------------------------+
void ParseLotSequence(string seqStr, double &lots[], int &count)
{
   ArrayInitialize(lots, 0);
   count = 0;

   string parts[];
   int n = StringSplit(seqStr, ',', parts);

   for(int i = 0; i < n; i++)
   {
      string s = parts[i];
      StringReplace(s, " ", "");
      if(StringLen(s) == 0) continue;

      double lot = StringToDouble(s);
      if(lot > 0)
      {
         lots[count] = lot;
         count++;
         if(count >= 50) break;
      }
   }
}

//+------------------------------------------------------------------+
//| 获取上一根已收盘K线数据(rates[1])                               |
//+------------------------------------------------------------------+
bool GetLastClosedCandle(double &open, double &high, double &low, double &close, double &atrVal, double &emaVal, datetime &time)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, InpPeriod, 0, 2, rates) < 2) return false;

   open  = rates[1].open;
   high  = rates[1].high;
   low   = rates[1].low;
   close = rates[1].close;
   time  = rates[1].time;

   // ATR
   atrVal = 0;
   if(g_atrHandle != INVALID_HANDLE)
   {
      double buf[];
      ArraySetAsSeries(buf, true);
      if(CopyBuffer(g_atrHandle, 0, 0, 2, buf) >= 2)
         atrVal = buf[1];
   }

   // 单EMA
   emaVal = 0;
   if(g_emaHandle != INVALID_HANDLE)
   {
      double buf[];
      ArraySetAsSeries(buf, true);
      if(CopyBuffer(g_emaHandle, 0, 0, 2, buf) >= 2)
         emaVal = buf[1];
   }

   return true;
}

//+------------------------------------------------------------------+
//| 画线                                                              |
//+------------------------------------------------------------------+
void DeleteAllLines()
{
   ObjectDelete(0, g_lineHighName);
   ObjectDelete(0, g_lineLowName);
   int oldGroup = g_ctxGroup;
   for(int g = 0; g < GROUP_COUNT; g++)
   {
      SetGroupContext(g);
      ObjectDelete(0, g_lineSLName);
      ObjectDelete(0, g_lineTrailName);
      ObjectDelete(0, g_lineAvgName);
      ObjectDelete(0, g_lineAddName);
   }
   SetGroupContext(oldGroup);
}

void DeleteTradeLines()
{
   ObjectDelete(0, g_lineSLName);
   ObjectDelete(0, g_lineTrailName);
   ObjectDelete(0, g_lineAvgName);
   ObjectDelete(0, g_lineAddName);
}

void DrawRangeLines()
{
   // 脉冲模式不画线
   // 脉冲模式已移除

   double upper = 0, lower = 0;

   if(InpLineMode == LINE_BODY)
   {
      if(g_kOpen <= 0 || g_kClose <= 0) return;
      upper = MathMax(g_kOpen, g_kClose);
      lower = MathMin(g_kOpen, g_kClose);
   }
   else
   {
      if(g_kHigh <= 0 || g_kLow <= 0) return;
      upper = g_kHigh;
      lower = g_kLow;
   }

   ObjectDelete(0, g_lineHighName);
   ObjectCreate(0, g_lineHighName, OBJ_HLINE, 0, 0, upper);
   ObjectSetInteger(0, g_lineHighName, OBJPROP_COLOR, clrBlue);
   ObjectSetInteger(0, g_lineHighName, OBJPROP_STYLE, STYLE_SOLID);
   ObjectSetInteger(0, g_lineHighName, OBJPROP_WIDTH, 2);

   ObjectDelete(0, g_lineLowName);
   ObjectCreate(0, g_lineLowName, OBJ_HLINE, 0, 0, lower);
   ObjectSetInteger(0, g_lineLowName, OBJPROP_COLOR, clrBlue);
   ObjectSetInteger(0, g_lineLowName, OBJPROP_STYLE, STYLE_SOLID);
   ObjectSetInteger(0, g_lineLowName, OBJPROP_WIDTH, 2);
}

// 获取当前组的标记线颜色
color GetGroupColor()
{
   return (g_ctxGroup == 0) ? clrOrange : clrMagenta;  // A组橙色,B组紫色
}

// 获取当前组的标签文字
string GetGroupLabel()
{
   return (g_ctxGroup == 0) ? "A" : "B";
}

void DrawSLLine()
{
   if(g_SL <= 0) { ObjectDelete(0, g_lineSLName); return; }
   ObjectDelete(0, g_lineSLName);
   ObjectCreate(0, g_lineSLName, OBJ_HLINE, 0, 0, g_SL);
   ObjectSetInteger(0, g_lineSLName, OBJPROP_COLOR, GetGroupColor());
   ObjectSetInteger(0, g_lineSLName, OBJPROP_STYLE, STYLE_DASH);
   ObjectSetInteger(0, g_lineSLName, OBJPROP_WIDTH, 2);
   ObjectSetString(0, g_lineSLName, OBJPROP_TEXT, GetGroupLabel() + "止损");
}

void DrawTrailLine()
{
   if(!g_trailActive || g_trailLine <= 0 || g_entryPrice <= 0)
   {
      ObjectDelete(0, g_lineTrailName);
   return;
   }
   // g_trailLine是浮盈点数,需转换为实际价格
   double trailPrice = (g_direction == 1) ?
      g_entryPrice + g_trailLine * _Point :
      g_entryPrice - g_trailLine * _Point;
   trailPrice = NormalizeDouble(trailPrice, _Digits);
   ObjectDelete(0, g_lineTrailName);
   ObjectCreate(0, g_lineTrailName, OBJ_HLINE, 0, 0, trailPrice);
   ObjectSetInteger(0, g_lineTrailName, OBJPROP_COLOR, GetGroupColor());
   ObjectSetInteger(0, g_lineTrailName, OBJPROP_STYLE, STYLE_DASH);
   ObjectSetInteger(0, g_lineTrailName, OBJPROP_WIDTH, 2);
   ObjectSetString(0, g_lineTrailName, OBJPROP_TEXT, GetGroupLabel() + "追踪");
}

void DrawAvgLine()
{
   if(g_avgPrice <= 0) return;

   ObjectDelete(0, g_lineAvgName);
   ObjectCreate(0, g_lineAvgName, OBJ_HLINE, 0, 0, g_avgPrice);
   ObjectSetInteger(0, g_lineAvgName, OBJPROP_COLOR, GetGroupColor());
   ObjectSetInteger(0, g_lineAvgName, OBJPROP_STYLE, STYLE_DASH);
   ObjectSetInteger(0, g_lineAvgName, OBJPROP_WIDTH, 2);
   ObjectSetString(0, g_lineAvgName, OBJPROP_TEXT, GetGroupLabel() + "均价");
}

//+------------------------------------------------------------------+
//| 画挂单线(紫色实线)                                              |
//+------------------------------------------------------------------+
void DrawAddTriggerLine()
{
   if(g_addTriggerPrice <= 0) return;

   ObjectDelete(0, g_lineAddName);
   ObjectCreate(0, g_lineAddName, OBJ_HLINE, 0, 0, g_addTriggerPrice);
   ObjectSetInteger(0, g_lineAddName, OBJPROP_COLOR, GetGroupColor());
   ObjectSetInteger(0, g_lineAddName, OBJPROP_STYLE, STYLE_DASH);
   ObjectSetInteger(0, g_lineAddName, OBJPROP_WIDTH, 2);
   ObjectSetString(0, g_lineAddName, OBJPROP_TEXT, GetGroupLabel() + "加仓");
}

//+------------------------------------------------------------------+
//| 查找本EA持仓                                                      |
//+------------------------------------------------------------------+
int FindMyTicket()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(!PositionSelectByTicket(tk)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != CurrentGroupMagic()) continue;
      return (int)tk;
   }
   return 0;
}

//+------------------------------------------------------------------+
//| 检查是否还有本EA的持仓                                            |
//+------------------------------------------------------------------+
bool HasMyPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(!PositionSelectByTicket(tk)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != CurrentGroupMagic()) continue;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| 统一处理交易错误                                                   |
//| 返回 false 表示交易失败(常规错误),返回 true 表示已处理特殊错误并停止 |
//+------------------------------------------------------------------+
bool HandleTradeError(uint retcode, string operation)
{
   if(retcode == 10027)  // 自动交易被客户端禁用
   {
      if(!g_autoTradingWarned)  // 只警告一次,不刷屏
      {
         g_autoTradingWarned = true;
         Print("╔══════════════════════════════════════════════════════════╗");
         Print("║  ⚠️  自动交易被禁用!请检查 MT5 右上角【EA交易】按钮是否为绿色  ║");
         Print("║     EA 已暂停运行,等待您恢复自动交易后自动继续              ║");
         Print("╚══════════════════════════════════════════════════════════╝");
      }
      return true;
   }
   else if(retcode == 10019 || retcode == 10025)  // 无持仓 / 无持仓可用于平
   {
      Print("【" + operation + "】当前无持仓(可能已平仓),忽略");
      return true;  // 已处理,不是错误
   }
   else if(retcode == 10014)  // 无效持仓单号
   {
      Print("【" + operation + "】无效持仓单号,跳过");
      return true;  // 已处理,不是错误
   }
   else if(retcode == 10006)  // 无持仓(平仓类)
   {
      Print("【" + operation + "】无持仓,跳过");
      return true;
   }
   return false;  // 其他错误,返回 false 让调用方处理
}

//+------------------------------------------------------------------+
//| 恢复单组持仓状态(A/B) - 按时间排序修复版                         |
//+------------------------------------------------------------------+
bool RestoreGroupPositions(int group)
{
   Print("【诊断】RestoreGroupPositions 被调用，组=", group);
   SetGroupContext(group);
   ResetGroupRuntime(group);
   LoadGroupRuntime(group);
   ArrayInitialize(g_orderTickets,0);
   ArrayInitialize(g_orderLots,0);
   ArrayInitialize(g_orderPrices,0);
   ArrayInitialize(g_closeTickets,0);
   g_orderCount=0;
   g_totalLots=0;
   g_avgPrice=0;
   g_direction=0;
   g_entryPrice=0;
   g_SL=0;
   g_trailLine=0;
   g_trailActive=false;
   g_isFirstOrder=true;
   g_closeTicketCount=0;
   g_closeRetries=0;
   g_groupClosing[group]=false;
   ResetAddTracking();

   // ---- 新增：临时结构体用于排序 ----
   struct PosInfo { datetime time; int ticket; double lots; double price; int type; };
   PosInfo temp[];
   ArrayResize(temp, 0);

   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong tk=PositionGetTicket(i);
      if(!PositionSelectByTicket(tk)) continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=CurrentGroupMagic()) continue;

      int size = ArraySize(temp);
      ArrayResize(temp, size+1);
      temp[size].time  = (datetime)PositionGetInteger(POSITION_TIME);
      temp[size].ticket = (int)tk;
      temp[size].lots  = PositionGetDouble(POSITION_VOLUME);
      temp[size].price = PositionGetDouble(POSITION_PRICE_OPEN);
      temp[size].type  = (PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?1:-1;
   }

   if(ArraySize(temp)==0) return false; // 无持仓

   // ---- 按开仓时间升序排序（默认升序） ----
   ArraySort(temp);   
   ArrayReverse(temp);
   string sortCheck = "【排序验证】排序后订单顺序(时间升序): ";
   for(int idx=0; idx<ArraySize(temp); idx++) {
       sortCheck += StringFormat("[%d]时间:%s 价格:%.2f ", 
                                  idx, 
                                  TimeToString(temp[idx].time), 
                                  temp[idx].price);
   }
   Print(sortCheck);

   // ---- 按排序后的顺序填充数组 ----
   int count=0;
   for(int i=0; i<ArraySize(temp); i++)
   {
      g_orderTickets[count] = temp[i].ticket;
      g_orderLots[count]   = temp[i].lots;
      g_orderPrices[count] = temp[i].price;
      if(g_direction==0) g_direction = temp[i].type;
      count++;
      if(count>=50) break;
   }

   g_orderCount = count;
   g_entryPrice = g_orderPrices[0]; // 首单价格
   g_SL = 0; // 重启后止损需重新计算（可由后续逻辑设定）

   // 计算总手数和均价
   double sumLots=0, sumPrice=0;
   for(int i=0;i<g_orderCount;i++)
   {
      sumLots  += g_orderLots[i];
      sumPrice += g_orderLots[i]*g_orderPrices[i];
   }
   g_totalLots = sumLots;
   g_avgPrice  = (sumLots>0)?(sumPrice/sumLots):0;
   g_isFirstOrder = (g_orderCount<=1);

   string arrayCheck = "【数组验证】g_orderPrices填充后顺序: ";
   for(int idx=0; idx<g_orderCount; idx++) {
       arrayCheck += StringFormat("价格[%d]:%.2f ", idx, g_orderPrices[idx]);
   }
   Print(arrayCheck);

   // 更新各组最新开仓时间（取最晚的时间）
   datetime latestPosTime = 0;
   for(int i=0;i<ArraySize(temp);i++)
      if(temp[i].time > latestPosTime) latestPosTime = temp[i].time;
   g_groupLastOpenBarTime[group] = latestPosTime;

   // 画线
   DrawAvgLine();
   DrawSLLine();

   Print("[GroupRestore]",CurrentGroupTag()," Count:",g_orderCount," Dir:",(g_direction==1?"Long":"Short"));
   SaveGroupRuntime(group);
   return true;
}

//+------------------------------------------------------------------+
//| 初始化                                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   g_groupMagics[0] = InpMagicNumber * 10 + 1;
   g_groupMagics[1] = InpMagicNumber * 10 + 2;
   g_groupLastOpenBarTime[0] = 0;
   g_groupLastOpenBarTime[1] = 0;
   ResetGroupRuntime(0);
   ResetGroupRuntime(1);
   SetGroupContext(0);
   trade.SetDeviationInPoints(InpMaxSlippage);
   trade.SetTypeFilling(ORDER_FILLING_FOK);
   trade.SetAsyncMode(true);

   g_atrHandle = iATR(_Symbol, InpPeriod, InpATRPeriod);
   if(g_atrHandle == INVALID_HANDLE) Print("【警告】ATR创建失败");

   g_emaHandle = iMA(_Symbol, InpPeriod, InpEMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
   if(g_emaHandle == INVALID_HANDLE) Print("【警告】EMA指标创建失败");

   // 解析阶梯间隔
   ParseStageDistances(InpStageAddDistances, g_stageDistances, g_stageCount);
   if(g_stageCount == 0 && InpAddMode == 1)
      Print("【警告】阶梯间隔序列解析为空，将使用固定间隔值作为后备");

   g_isAuthorized = CheckAuthorization();
   g_emaReady = false;

   // 启动时检查授权是否已到期
   StopIfExpired();
   if(g_permanentlyStopped)
   {
      Print("【授权到期】EA已停止工作,请联系更新授权");
      return INIT_FAILED;
   }

   // 初始化自定义手数序列
   ParseLotSequence(InpLotSequence, g_lotSequence, g_maxOrders);

   if(g_maxOrders == 0)
   {
      Print("【错误】手数序列未设置");
      return INIT_FAILED;
   }

   Print("【手数序列】共", g_maxOrders, "仓,首仓:", g_lotSequence[0], ",末仓:", g_lotSequence[g_maxOrders-1]);
   if(InpAddMode == 1)
   {
      string distStr = "";
      for(int i=0;i<g_stageCount;i++)
         distStr += (i==0?"":",") + DoubleToString(g_stageDistances[i],0);
      Print("【阶梯间隔】共", g_stageCount, "档:", distStr);
   }
   else
      Print("【固定间隔】", InpAddDistance, "点");

   // 初始化异步平仓数组(按当前组上下文)
   ArrayInitialize(g_closeTickets, 0);
   g_closeTicketCount = 0;
   g_closeRetries = 0;
   g_groupClosing[0] = false;
   g_groupClosing[1] = false;

   // 尝试恢复状态
   LoadState();

   // A/B 持仓恢复(先恢复,再画线,避免用旧GV值画线)
   bool hasAnyPosition = false;
   bool groupHasPos[2] = {false, false};
   for(int g = 0; g < GROUP_COUNT; g++)
   {
      if(RestoreGroupPositions(g))
      {
         hasAnyPosition = true;
         groupHasPos[g] = true;
      }
   }

   // 重绘画线:有持仓的组画线,无持仓的组清除残留线
   for(int g = 0; g < GROUP_COUNT; g++)
   {
      SetGroupContext(g);
      if(groupHasPos[g])
         RedrawLines();
      else
         DeleteTradeLines();
   }

   SetGroupContext(0);
   // 脉冲模式已移除

   // 双组模式:全局状态仅负责信号等待,不再用单组IN_TRADE阻塞
   g_state = STATE_WAIT_FIRST_CANDLE;
   datetime curBar = GetCurrentBarTime();
   if(curBar > 0)
      g_prevBarTime = curBar; // 强制等待当前K线收盘后再进入信号检测
   if(hasAnyPosition)
      Print("【双均线2.0启动】检测到组持仓,继续监控并允许空闲组接信号");
   else
      Print("【双均线2.0启动】等待当前K线收盘...");
   LoadStatistics();  // 恢复累计统计数据

   // 初始化UI
   UpdateComment();
   //CreateBgImage();  // 创建背景图片
   Print("【V8启动】UI初始化完成");

   Print("【禁止时段】参数: ", InpNoTradeWindow, "  北京时间");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| 卸载                                                              |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   // === 原因分流 ===
   if(reason == REASON_PARAMETERS || reason == REASON_CHARTCHANGE)
   {
      // 切换周期或改参数:保存状态,不清运行时
      SaveState();
      DeleteUIObjects();
    //DeleteBgImage();
      Print("【V8暂停】切换周期/参数,状态已保存");
   }
   else if(reason == REASON_REMOVE || reason == REASON_CLOSE)
   {
      // 完全卸载:删所有东西,清运行时,保留统计数据
      DeleteAllLines();
      DeleteUIObjects();
     //DeleteBgImage();
      ClearRuntimeGlobals();
      Print("【V8停止】");
   }

   // === 指标句柄:所有情况下都必须释放,防止句柄泄漏 ===
   // 注意:OnInit 里句柄为0时 iATR/iMA 返回 INVALID_HANDLE,
   //       这里释放后置为 INVALID_HANDLE,下次 OnInit 会重新创建
   if(g_atrHandle != INVALID_HANDLE)    { IndicatorRelease(g_atrHandle);    g_atrHandle    = INVALID_HANDLE; }
   if(g_emaHandle != INVALID_HANDLE){ IndicatorRelease(g_emaHandle); g_emaHandle = INVALID_HANDLE; }
}

//+------------------------------------------------------------------+
//| 图表事件(窗口大小变化时重居中背景图)                             |
//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
   // 窗口大小变化:重居中背景图
   // if(id == CHARTEVENT_CHART_CHANGE && InpShowBgImage)
   //    CreateBgImage();

   // 按钮点击:全部平仓 / A组平仓 / B组平仓
   if(id == CHARTEVENT_OBJECT_CLICK &&
      (sparam == g_closeBtnName || sparam == g_closeBtnAName || sparam == g_closeBtnBName))
   {
      if(sparam == g_closeBtnName)
      {
         // 全部平仓:遍历A/B所有有仓位的组
         bool hasAny = false;
         for(int g = 0; g < GROUP_COUNT; g++)
         {
            if(!HasGroupPosition(g)) continue;
            hasAny = true;
            LoadGroupRuntime(g);  // 必须加载该组的订单数据!
            DoClose("用户点击全部平仓");
            SaveGroupRuntime(g);  // 保存平仓状态
         }
         if(hasAny)
         {
            ChartRedraw();  // 立即刷新图表,让UI立即更新
            Print("【用户点击】全部平仓按钮");
         }
         else
         {
            Print("【用户点击】全部平仓按钮 - 无持仓,忽略");
         }
      }
      else
      {
         // 分组平仓:仅平对应组
         int targetGroup = (sparam == g_closeBtnAName) ? 0 : 1;
         string tag = (targetGroup == 0) ? "A" : "B";
         if(HasGroupPosition(targetGroup))
         {
            LoadGroupRuntime(targetGroup);  // 必须加载该组的订单数据!
            DoClose("用户点击" + tag + "组平仓");
            SaveGroupRuntime(targetGroup);  // 保存平仓状态
            Print("【用户点击】" + tag + "组平仓按钮");
         }
         else
         {
            Print("【用户点击】" + tag + "组平仓按钮 - 该组无持仓,忽略");
         }
      }
      SetGroupContext(0);
      // 按钮恢复未选中状态
      ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
      ChartRedraw(0);
   }
}

//+------------------------------------------------------------------+
//| 交易事务通知(加速异步平仓检测)                                   |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
{
   // 双组模式由OnTick统一轮询处理平仓完成,此处不做单组状态门控
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
}

//+------------------------------------------------------------------+
//| 标记K线(统一处理)                                               |
//+------------------------------------------------------------------+
void MarkCandle(double open, double high, double low, double close, double atrVal, double emaVal, datetime time)
{
   g_candleTime = time;
   // 新K线时重置信号互斥（允许新K线开仓）
   if(g_signalUsedBarTime > 0 && time > g_signalUsedBarTime)
      g_signalUsedBarTime = 0;
   // 新K线时重置所有组的 kLineTraded，允许各组在新K线重新开仓
   for(int g = 0; g < GROUP_COUNT; g++)
      g_groupRt[g].kLineTraded = false;
   g_kOpen   = NormalizeDouble(open, _Digits);
   g_kHigh   = NormalizeDouble(high, _Digits);
   g_kLow    = NormalizeDouble(low, _Digits);
   g_kClose  = NormalizeDouble(close, _Digits);
   g_kATR    = atrVal;

   // 单EMA方向判断:收盘价 vs EMA
   g_bias = 0;
   g_emaReady = false;
   g_emaVal = emaVal;

   // 单均线版本:无差值检查
   g_emaReady = (emaVal > 0);

   if(emaVal > 0)
   {
      // 多头方向:收盘价 > EMA
      if(close > emaVal)
         g_bias = 1;
      // 空头方向:收盘价 < EMA
      else if(close < emaVal)
         g_bias = -1;
      else
         g_bias = 0;
   }

   // ATR条件
   g_atrOk = false;
   if(InpATRMode != ATR_NONE)
   {
      if(g_kATR > 0)
      {
         double comparePts = 0;
         if(InpATRMode == ATR_BODY)
            comparePts = MathAbs(g_kClose - g_kOpen) / _Point;
         else if(InpATRMode == ATR_WHOLE)
            comparePts = (g_kHigh - g_kLow) / _Point;
         double atrPts = g_kATR / _Point;
         double mult = (InpATRMultiple <= 0) ? 1.0 : InpATRMultiple;
         g_atrOk = (comparePts > atrPts * mult);
      }
   }
   else
   {
      g_atrOk = true;
   }

   DrawRangeLines();

   // 首根K线收盘后,切换到信号等待状态
   if(g_state == STATE_WAIT_FIRST_CANDLE)
      g_state = STATE_WAIT_SIGNAL;

   SaveState();
}
//+------------------------------------------------------------------+
//| 信号处理                                                        |
//+------------------------------------------------------------------+
void ProcessSignal()
{

   if(g_state!=STATE_WAIT_SIGNAL)return;
   if(!g_isAuthorized)return;
   if(IsPaused())return;
   if(IsPermanentlyStopped())return;
   // 禁止时段
   if(CheckNoTradeWindow()){
      g_inNoTradeWindow=true;
      g_noTradeStartBarTime=g_candleTime;
      Print("[Blocked] No trade window active");
      return;
   }
   CheckBreakout();
}

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| 开仓(加仓模式首单)                                              |
//+------------------------------------------------------------------+
bool DoOpenMartingale(int direction)
{
   if(g_state != STATE_WAIT_SIGNAL) return false;
   if(!g_isAuthorized) return false;
   if(g_maxOrders <= 0) return false;

   // ===== 互斥锁：防止同一组同时开仓 =====
   if(g_groupRt[g_ctxGroup].isOpening) return false;
   g_groupRt[g_ctxGroup].isOpening = true;

   // 最后释放锁（无论成功与否）
   bool success = false;
   int tk = 0;
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double price = (direction == 1) ? ask : bid;
   double lots = g_lotSequence[0];

   // 再次检查持仓（防止在获取锁期间被其他组干扰）
   if(HasMyPosition())
   {
      Print("【开仓拦截】该组已有持仓，跳过首单开仓");
      g_groupRt[g_ctxGroup].isOpening = false;
      return false;
   }

   // 同步开仓
   trade.SetAsyncMode(false);
   bool ok = (direction == 1) ?
      trade.Buy(lots, _Symbol, price, 0, 0, CurrentGroupComment()) :
      trade.Sell(lots, _Symbol, price, 0, 0, CurrentGroupComment());
   trade.SetAsyncMode(true);

   if(!ok)
   {
      uint retcode = trade.ResultRetcode();
      if(HandleTradeError(retcode, "开仓")) { g_groupRt[g_ctxGroup].isOpening = false; return false; }
      Print("【开仓失败】", retcode);
      g_groupRt[g_ctxGroup].isOpening = false;
      return false;
   }

   // 获取成交单号
   ulong resultDeal = trade.ResultDeal();
   if(resultDeal > 0 && PositionSelectByTicket(resultDeal))
   {
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == CurrentGroupMagic())
         tk = (int)resultDeal;
   }

   // 如果无法获取，则通过遍历查找（兜底）
   if(tk == 0)
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(!PositionSelectByTicket(t)) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != CurrentGroupMagic()) continue;
         int posType = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
         if(posType == direction) { tk = (int)t; break; }
      }
   }

   if(tk == 0)
   {
      Print("【开仓失败】找不到持仓，但订单可能已提交，请检查");
      g_groupRt[g_ctxGroup].isOpening = false;
      return false;
   }

   // ===== 立即更新数组（不再依赖 Sleep 后的遍历） =====
   ArrayInitialize(g_orderTickets, 0);
   ArrayInitialize(g_orderLots, 0);
   ArrayInitialize(g_orderPrices, 0);

   g_orderTickets[0] = tk;
   g_orderLots[0] = lots;
   g_orderPrices[0] = price;
   g_orderCount = 1;
   g_totalLots = lots;
   g_avgPrice = price;
   g_direction = direction;
   g_entryPrice = price;
   g_SL = 0;
   g_trailActive = false;
   g_trailLine = 0;
   g_isFirstOrder = true;

   DrawAvgLine();

   Print("【马丁首单】", (direction == 1 ? "多" : "空"),
         " 手数:", lots, " 价格:", price);

   g_groupLastOpenBarTime[g_ctxGroup] = GetCurrentBarTime();
   SaveState();

   // 释放锁
   g_groupRt[g_ctxGroup].isOpening = false;
   return true;
}

//+------------------------------------------------------------------+
//| 加仓(加仓模式)                                                  |
//+------------------------------------------------------------------+
bool DoAddOrder()
{
   // 马丁模式已设为默认
   if(g_orderCount <= 0) return false;
   if(g_orderCount >= g_maxOrders)
   {
      Print("【加仓停止】已达到仓数上限:", g_maxOrders, "仓");
      return false;
   }

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   double newLots = g_lotSequence[g_orderCount];

   if(newLots < 0.01)
   {
      Print("【加仓停止】手数错误:", newLots);
      return false;
   }

   double price = (g_direction == 1) ? ask : bid;

   // 加仓也用同步模式，确保仓位创建后再继续
   trade.SetAsyncMode(false);
   bool ok = (g_direction == 1) ?
      trade.Buy(newLots, _Symbol, price, 0, 0, CurrentGroupComment()) :
      trade.Sell(newLots, _Symbol, price, 0, 0, CurrentGroupComment());
   trade.SetAsyncMode(true);

   if(!ok)
   {
      uint retcode = trade.ResultRetcode();
      if(HandleTradeError(retcode, "加仓")) return false;
      Print("【加仓失败】", retcode);
      return false;
   }

   Sleep(300);

   // [FIX3] 精确匹配:优先用经纪商返回的成交单号，兜底遍历找最接近价格+排除已跟踪票
   ulong resultDeal = trade.ResultDeal();
   int tk = 0;
   if(resultDeal > 0)
   {
      // 优先使用经纪商返回的成交单号
      if(PositionSelectByTicket(resultDeal))
      {
         if(PositionGetString(POSITION_SYMBOL) == _Symbol)
            if(PositionGetInteger(POSITION_MAGIC) == CurrentGroupMagic())
               tk = (int)resultDeal;
      }
   }
   if(tk == 0)
   {
      // 兜底:遍历找当前组+同方向+价格最接近发单价+不在g_orderTickets中的票
      double targetPrice = (g_direction == 1) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double bestDiff = 1e10;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(!PositionSelectByTicket(t)) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != CurrentGroupMagic()) continue;
         int posType = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
         if(posType != g_direction) continue;
         // 跳过已在 g_orderTickets 中的票，防止重复跟踪
         bool alreadyTracked = false;
         for(int j = 0; j < g_orderCount; j++)
            if((int)g_orderTickets[j] == (int)t) { alreadyTracked = true; break; }
         if(alreadyTracked) continue;
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double diff = MathAbs(openPrice - targetPrice);
         if(diff < bestDiff) { bestDiff = diff; tk = (int)t; }
      }
   }

   if(tk == 0) { Print("【加仓失败】找不到持仓"); return false; }

   g_orderTickets[g_orderCount] = tk;
   g_orderLots[g_orderCount] = newLots;
   g_orderPrices[g_orderCount] = price;
   g_orderCount++;
   g_isFirstOrder = false;

   // 计算总手数和均价
   double mainLots = 0;
   double mainSum = 0;
   for(int i = 0; i < g_orderCount; i++)
   {
      mainLots += g_orderLots[i];
      mainSum += g_orderPrices[i] * g_orderLots[i];
   }

   if(mainLots > 0)
      g_avgPrice = mainSum / mainLots;
   g_totalLots = mainLots;

   DrawAvgLine();
   SaveState();

   Print("【加仓】手数:", newLots, " 累计:", g_totalLots, " 均价:", g_avgPrice);
   return true;
}

//+------------------------------------------------------------------+
//| 检查加仓条件(原逻辑,不启用追踪时使用)                           |
//+------------------------------------------------------------------+
void CheckAddOrder()
{
   // 马丁模式已设为默认
   if(g_orderCount <= 0) return;
   if(g_orderCount >= g_maxOrders) return;

   // 启用追踪加仓时,走新逻辑
   if(InpUseAddTracking)
   {
      CheckAddOrderWithTracking();
   return;
   }

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   double diff = 0;
   if(g_direction == 1)
      diff = (g_orderPrices[0] - ask) / _Point;
   else
      diff = (bid - g_orderPrices[0]) / _Point;

   // 获取当前应使用的加仓间隔（阶梯或固定）
   double addDist = GetCurrentAddDistance();
   double needDiff = addDist * g_orderCount;

   if(diff >= needDiff)
   {
      Print("【满足加仓条件】当前亏损:", DoubleToString(diff, 0),
            "点 需要:", DoubleToString(needDiff, 0), "点");
      DoAddOrder();
   }
   return;
}

//+------------------------------------------------------------------+
//| 检查加仓条件(追踪挂单模式)                                       |
//+------------------------------------------------------------------+
void CheckAddOrderWithTracking()
{
   // 马丁模式已设为默认
   if(g_orderCount <= 0) return;
   if(g_orderCount >= g_maxOrders) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point = _Point;

   // 计算正常加仓价(以上一次加仓价为基准)
   double lastAddPrice = g_orderPrices[g_orderCount - 1];  // 上一次加仓价
   double addDist = GetCurrentAddDistance();               // 获取当前间隔
   double normalAddPrice;
   if(g_direction == 1)  // 多单,价格跌了才加仓
   {
      normalAddPrice = lastAddPrice - addDist * _Point;  // 上一次价格 - 间隔
   }
   else  // 空单,价格涨了才加仓
   {
      normalAddPrice = lastAddPrice + addDist * _Point;  // 上一次价格 + 间隔
   }

   // 计算触发门槛价 = 正常加仓价 ± 30点(逆势方向再突破30点)
   double triggerThreshold;
   if(g_direction == 1)  // 多单,价格要跌得更低
   {
      triggerThreshold = normalAddPrice - InpAddTriggerPoints * point;
   }
   else  // 空单,价格要涨得更高
   {
      triggerThreshold = normalAddPrice + InpAddTriggerPoints * point;
   }

   // 检查是否触发追踪
   if(g_direction == 1)  // 多单,价格跌了才加仓
   {
      // 价格跌破触发门槛 → 激活追踪或更新极端价
      if(bid <= triggerThreshold)
      {
         if(!g_addTrackingActive)
         {
            // 首次触发,记录极端价(最低价)
            g_addTrackingActive = true;
            g_addExtremePrice = bid;
            g_addTriggerPrice = g_addExtremePrice + InpAddTrailPoints * point;  // 挂单线在极端价上方
            DrawAddTriggerLine();
            Print("【追踪加仓激活】多单 上次加仓价:", DoubleToString(lastAddPrice, _Digits),
                  " 触发价:", DoubleToString(triggerThreshold, _Digits),
                  " 挂单线:", DoubleToString(g_addTriggerPrice, _Digits));
            return;  // [FIX2] 激活后立即返回，防止同tick价格快速反弹触发两次加仓
         }
         else
         {
            // 更新极端价(只降不升,记录更低的低点)
            if(bid < g_addExtremePrice)
            {
               g_addExtremePrice = bid;
               g_addTriggerPrice = g_addExtremePrice + InpAddTrailPoints * point;  // 挂单线跟着往下移
               DrawAddTriggerLine();
            }
         }
      }
   }
   else  // 空单,价格涨了才加仓
   {
      // 价格涨破触发门槛 → 激活追踪或更新极端价
      if(ask >= triggerThreshold)
      {
         if(!g_addTrackingActive)
         {
            // 首次触发,记录极端价(最高价)
            g_addTrackingActive = true;
            g_addExtremePrice = ask;
            g_addTriggerPrice = g_addExtremePrice - InpAddTrailPoints * point;  // 挂单线在极端价下方
            DrawAddTriggerLine();
            Print("【追踪加仓激活】空单 上次加仓价:", DoubleToString(lastAddPrice, _Digits),
                  " 触发价:", DoubleToString(triggerThreshold, _Digits),
                  " 挂单线:", DoubleToString(g_addTriggerPrice, _Digits));
            return;  // [FIX2] 激活后立即返回，防止同tick价格快速反弹触发两次加仓
         }
         else
         {
            // 更新极端价(只升不降,记录更高的高点)
            if(ask > g_addExtremePrice)
            {
               g_addExtremePrice = ask;
               g_addTriggerPrice = g_addExtremePrice - InpAddTrailPoints * point;  // 挂单线跟着往上移
               DrawAddTriggerLine();
            }
         }
      }
   }

   // 触碰挂单线判断独立检查(不受门槛条件限制)
   if(g_addTrackingActive)
   {
      if(g_direction == 1 && bid >= g_addTriggerPrice)  // 多单:价格反弹触碰挂单线
      {
         Print("【追踪加仓触发】多单 触碰挂单线:", DoubleToString(g_addTriggerPrice, _Digits));
         DoAddOrder();
         ResetAddTracking();
      }
      else if(g_direction == -1 && ask <= g_addTriggerPrice)  // 空单:价格回落触碰挂单线
      {
         Print("【追踪加仓触发】空单 触碰挂单线:", DoubleToString(g_addTriggerPrice, _Digits));
         DoAddOrder();
         ResetAddTracking();
      }
   }
}

//+------------------------------------------------------------------+
//| 重置追踪加仓状态                                                   |
//+------------------------------------------------------------------+
void ResetAddTracking()
{
   g_addTrackingActive = false;
   g_addExtremePrice = 0;
   g_addTriggerPrice = 0;
   ObjectDelete(0, g_lineAddName);
}

//+------------------------------------------------------------------+
//| 检测突破                                                          |
//+------------------------------------------------------------------+
void CheckBreakout()
{
   if(g_state != STATE_WAIT_SIGNAL) return;
   if(g_kLineTraded) return;
   // 任意组开仓后同K线禁止另一组开仓
   if(g_signalUsedBarTime > 0 && g_signalUsedBarTime == g_candleTime) return;
   // 防止同组在同一根K线平仓后立即开仓
   if(g_closeBarTime > 0 && g_closeBarTime == g_candleTime) return;
   if(!g_isAuthorized) return;


   // ===== 禁止时段:禁止开仓 =====
   if(g_inNoTradeWindow)
   {
      Print("【开仓拦截】禁止时段中,不开仓");
   return;
   }


   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   double upper = 0, lower = 0;

   if(InpLineMode == LINE_BODY)
   {
      if(g_kOpen <= 0 || g_kClose <= 0) return;
      upper = MathMax(g_kOpen, g_kClose);
      lower = MathMin(g_kOpen, g_kClose);
   }
   else
   {
      if(g_kHigh <= 0 || g_kLow <= 0) return;
      upper = g_kHigh;
      lower = g_kLow;
   }

   // ===== EMA方向过滤:价格在均线下方只做空,价格在均线上方只做多 =====
   // 多单方向:只在均线之上开多
   if(ask > upper && g_bias == -1)
   {
      Print("【开仓拦截】价格在均线下方,不允许多单 g_bias:", g_bias);
      return;
   }
   // 空单方向:只在均线之下开空
   if(bid < lower && g_bias == 1)
   {
      Print("【开仓拦截】价格在均线上方,不允许空单 g_bias:", g_bias);
      return;
   }

   // 多单:突破区间高价
   if(ask > upper)
   {
      Print("【开仓诊断】检测到向上突破 ask:", ask, " upper:", upper,
            " ATR模式:", InpATRMode, " atrOk:", g_atrOk);

      if(InpATRMode != ATR_NONE && !g_atrOk)
      {
         // ATR不满足,不标记g_kLineTraded,让空单仍有机会
         Print("【开仓诊断】多单被ATR过滤 atrOk:", g_atrOk);
      }
      else
      {
         Print("【开仓诊断】多单全部通过,执行开仓");
         bool ok = DoOpenMartingale(1);
         if(ok) { g_kLineTraded = true; g_signalUsedBarTime = g_candleTime; }
      }
   return;
   }

   // 空单:跌破区间低价
   if(bid < lower)
   {
      Print("【开仓诊断】检测到向下突破 bid:", bid, " lower:", lower,
            " ATR模式:", InpATRMode, " atrOk:", g_atrOk);

      if(InpATRMode != ATR_NONE && !g_atrOk)
      {
         // ATR不满足,不标记g_kLineTraded,让多单仍有机会
         Print("【开仓诊断】空单被ATR过滤 atrOk:", g_atrOk);
      }
      else
      {
         Print("【开仓诊断】空单全部通过,执行开仓");
         bool ok = DoOpenMartingale(-1);
         if(ok) { g_kLineTraded = true; g_signalUsedBarTime = g_candleTime; }
      }
   return;
   }
}
//+------------------------------------------------------------------+
//| 计算总浮盈(加仓模式用)                                           |
//+------------------------------------------------------------------+
double CalcTotalProfit()
{
   double profit = 0;

   // 计算所有持仓的浮盈
   for(int i = 0; i < g_orderCount; i++)
   {
      if(g_orderTickets[i] <= 0) continue;
      if(!PositionSelectByTicket(g_orderTickets[i]))
      {
         g_orderTickets[i] = 0;
         continue;
      }
      profit += PositionGetDouble(POSITION_PROFIT);
      profit += PositionGetDouble(POSITION_SWAP);
   }

   // 更新今日最大浮盈浮亏
   if(profit > g_todayMaxProfit) g_todayMaxProfit = profit;
   if(profit < g_todayMaxLoss) g_todayMaxLoss = profit;

   return profit;
}

void MonitorTradeMartingale()
{
   bool hasPos = false;
   for(int i = 0; i < g_orderCount; i++)
   {
      if(g_orderTickets[i] <= 0) continue;
      if(PositionSelectByTicket(g_orderTickets[i]))
      {
         hasPos = true;
         break;
      }
   }

   if(!hasPos)
   {
      // 先用HasMyPosition扫描市场，确认是否真的无持仓
      // （防止g_orderTickets不同步导致误判）
      if(HasMyPosition())
      {
         Print("【持仓恢复】", CurrentGroupTag(), " g_orderTickets丢失，从市场恢复持仓跟踪");
         RestoreGroupPositions(g_ctxGroup);
         // 恢复后继续正常监控（不return，让后续逻辑执行）
      }
      else
      {
         DoClose("持仓消失");
         return;
      }
   }

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double cur = (g_direction == 1) ? bid : ask;
   double totalProfit = CalcTotalProfit();

   // ===== 分型保护平仓(优先级1) =====
   if(g_fractalPending[g_ctxGroup])
   {
      // 浮亏绝对值达到保护金额 -> 平仓
      if(totalProfit <= -InpFractalProtectionAmount)
      {
         Print("【分型保护触发】", CurrentGroupTag(), "组 浮亏:", DoubleToString(totalProfit, 2), " <= -", InpFractalProtectionAmount);
         DoClose("分型保护平仓");
         g_fractalPending[g_ctxGroup] = false;
         return;
      }
   }

   // ===== 马丁强制止损(优先级2,与分型保护并行) =====
   if(totalProfit <= -InpLossAmount)
   {
      DoClose("统一止损");
      g_fractalPending[g_ctxGroup] = false;  // 清除分型标记
   }

   double basePrice = g_isFirstOrder ? g_orderPrices[0] : g_avgPrice;
   double pts = (g_direction == 1) ?
                (cur - basePrice) / _Point : (basePrice - cur) / _Point;

   // 移动止盈模式(仅保留移动止盈)
   // 马丁模式:首单用150点激活,加仓后用80点激活
   int trailActivePts = g_isFirstOrder ? InpFirstTrailActive : InpAddTrailActive;
   double trailCheckPts = pts;
   bool trailJustActivated = false;

   if(!g_trailActive && trailCheckPts >= trailActivePts)
   {
      g_trailActive = true;
      g_trailLine = trailCheckPts - InpTrailStep;
      trailJustActivated = true;
      Print("【移动止盈激活】", (g_isFirstOrder ? "首单" : "加仓单"),
            " 浮盈", DoubleToString(trailCheckPts, 0), "点,止盈线", DoubleToString(g_trailLine, 0), "点");
   }

   if(g_trailActive)
   {
      if(!trailJustActivated && trailCheckPts - InpTrailStep > g_trailLine)
      {
         g_trailLine = trailCheckPts - InpTrailStep;
      }
      if(!trailJustActivated && trailCheckPts <= g_trailLine)
      {
         DoClose("追踪止盈");
         g_fractalPending[g_ctxGroup] = false;  // 移动止盈平仓后清除分型标记
      return;
      }
   }

   CheckAddOrder();
}

void DoClose(string reason)
{
   // 先收集所有需要平仓的ticket（必须在CalcTotalProfit之前，因为CalcTotalProfit会清零选不上的ticket）
   ArrayInitialize(g_closeTickets, 0);
   g_closeTicketCount = 0;
   for(int i = 0; i < g_orderCount; i++)
   {
      if(g_orderTickets[i] <= 0) continue;
      g_closeTickets[g_closeTicketCount] = (ulong)g_orderTickets[i];
      g_closeTicketCount++;
   }
   
   // 如果从 g_orderTickets 收集为空，说明 g_orderCount 可能已不同步
   // 从全局持仓列表中恢复属于当前组的真实持仓
   if(g_closeTicketCount == 0 && g_orderCount > 0)
   {
      Print("[Close] g_orderCount=", g_orderCount, " but tickets empty, recovering from market...");
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong tk = PositionGetTicket(i);
         if(!PositionSelectByTicket(tk)) continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetInteger(POSITION_MAGIC) != CurrentGroupMagic()) continue;
         g_closeTickets[g_closeTicketCount] = tk;
         g_closeTicketCount++;
         if(g_closeTicketCount >= 50) break;
      }
      if(g_closeTicketCount > 0)
         Print("[Close] Recovered ", g_closeTicketCount, " positions from market");
   }
   
   if(g_closeTicketCount == 0)
   {
      Print("[Close] No positions to close, clear group state directly");
      // 没有持仓需要平，直接调用 AfterClose 清理状态
      AfterClose();
      return;
   }
   
   // 收集完ticket后再计算盈亏
   double profit = CalcTotalProfit();
   g_closeReason = reason;
   g_closeProfit = profit;
   g_closeRetries = 0;
   g_closeRequestTime = TimeCurrent();
   g_groupClosing[g_ctxGroup] = true;
   for(int i = 0; i < g_closeTicketCount; i++)
      trade.PositionClose(g_closeTickets[i]);
   Print("[Async Close]", reason, " Profit:$", DoubleToString(profit,2), " Sent:", g_closeTicketCount);
   SaveState();
}
//+------------------------------------------------------------------+
//| 异步平仓(批量发送,平仓更快)                                     |
//+------------------------------------------------------------------+
void CheckCloseCompleted()
{
   if(!g_groupClosing[g_ctxGroup]) return;
   
   // 直接查 g_closeTickets 是否还有持仓在市，不用 g_orderTickets
   // 因为 CalcTotalProfit 可能已经清零了 g_orderTickets 中的无效票
   int remaining = 0;
   for(int i = 0; i < g_closeTicketCount; i++)
   {
      if(g_closeTickets[i] <= 0) continue;
      if(PositionSelectByTicket(g_closeTickets[i]))
         remaining++;
   }
   
   if(remaining == 0)
   {
      Print("[Async Close Done]", g_closeReason, " Profit:$", DoubleToString(g_closeProfit, 2));
      if(g_closeProfit > 0)
      {
         g_todayWins++;
         g_consecutiveLosses = 0;
      }
      else if(g_closeProfit < 0)
      {
         g_todayLosses++;
         g_consecutiveLosses++;
         if(g_consecutiveLosses >= InpMaxLosses)
         {
            g_pauseUntilTime = TimeCurrent() + InpPauseMinutes * 60;
            g_consecutiveLosses = 0;
            Print("[Consecutive Loss] Paused for", InpPauseMinutes, "min");
         }
      }
      g_todayProfit += g_closeProfit;
      AfterClose();
      return;
   }
   
   uint elapsed = (uint)(TimeCurrent() - g_closeRequestTime) * 1000;
   uint retryInterval = 200;
   if(elapsed >= retryInterval)
   {
      g_closeRetries++;
      if(g_closeRetries >= 10)
      {
         Print("[Force Close] Retrying with larger slippage, remaining:", remaining);
         trade.SetDeviationInPoints(1000);
         for(int i = 0; i < g_closeTicketCount; i++)
         {
            if(g_closeTickets[i] <= 0) continue;
            trade.PositionClose(g_closeTickets[i]);
         }
         trade.SetDeviationInPoints(InpMaxSlippage);
      }
      else
      {
         Print("[Async Retry]", g_closeRetries, " remaining:", remaining);
         for(int i = 0; i < g_closeTicketCount; i++)
         {
            if(g_closeTickets[i] <= 0) continue;
            trade.PositionClose(g_closeTickets[i]);
         }
      }
      g_closeRequestTime = TimeCurrent();
      SaveState();
   }
}

//+------------------------------------------------------------------+
//| 结余保护检查(保护值随最大结余提升)                              |
//+------------------------------------------------------------------+
void CheckNetProtection()
{
   if(!InpUseNetProtection) return;

   double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);

   // 初始化:首次运行或重启后无记录
   if(g_maxBalance == 0)
   {
      g_maxBalance = currentBalance;
      Print("【结余保护初始化】初始结余$", DoubleToString(g_maxBalance, 2),
            " 保护值$", DoubleToString(g_maxBalance - InpNetProtectionDistance, 2));
      SaveState();
   return;
   }

   // 更新最大结余(只升不降)
   if(currentBalance > g_maxBalance)
   {
      g_maxBalance = currentBalance;
      Print("【结余保护提升】最大结余$", DoubleToString(g_maxBalance, 2),
            " → 保护值$", DoubleToString(g_maxBalance - InpNetProtectionDistance, 2));
      SaveState();
   }

   // 计算当前保护值 = 最大结余 - 保护距离
   double protectionValue = g_maxBalance - InpNetProtectionDistance;

   // 检查是否触发保护(只在无持仓时检查,不影响持仓中的EA)
   if(!HasAnyGroupPosition() && currentBalance < protectionValue)
   {
      g_permanentlyStopped = true;
      Print("【结余保护触发】当前结余$", DoubleToString(currentBalance, 2),
            " < 保护值$", DoubleToString(protectionValue, 2),
            "(最大结余$", DoubleToString(g_maxBalance, 2),
            " - 距离$", DoubleToString(InpNetProtectionDistance, 2), ")",
            ",EA永久停止");
      SaveState();
   }
}

//+------------------------------------------------------------------+
//| 计算当前保护值                                                    |
//| 公式: 最大结余 - 保护距离                                         |
//+------------------------------------------------------------------+
double CalcProtectionValue()
{
   if(g_maxBalance == 0) return 0;
   return g_maxBalance - InpNetProtectionDistance;
}

//+------------------------------------------------------------------+
//| 检查暂停状态                                                       |
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| 获取当前北京时间(UTC+8)                                        |
//+------------------------------------------------------------------+
datetime GetBeijingTime()
{
   return TimeCurrent() + 8 * 3600;  // UTC+8
}

//+------------------------------------------------------------------+
//| 禁止时段检测                                                      |
//| 参数 InpNoTradeWindow = "HH:MM-HH:MM" 北京时间                   |
//| 例:InpNoTradeWindow="05:00-06:30"                               |
//|     05:00起禁止开仓,06:30后恢复正常                              |
//+------------------------------------------------------------------+
bool CheckNoTradeWindow()
{
   // 如果参数为空或"-",则不禁用
   if(InpNoTradeWindow == "" || InpNoTradeWindow == "-")
      return false;

   // 解析参数格式:start-end,如"05:30-06:30"
   int sepPos = StringFind(InpNoTradeWindow, "-");
   if(sepPos < 0) return false;

   // 提取并清理起始时间字符串(去除空格)
   string rawStart = StringSubstr(InpNoTradeWindow, 0, sepPos);
   StringTrimLeft(rawStart);
   StringTrimRight(rawStart);

   // 提取结束时间字符串
   string rawEnd = StringSubstr(InpNoTradeWindow, sepPos + 1);
   StringTrimLeft(rawEnd);
   StringTrimRight(rawEnd);

   // 解析起始时间 HH:MM
   int colonPos1 = StringFind(rawStart, ":");
   if(colonPos1 < 0) return false;
   int startH = (int)StringToInteger(StringSubstr(rawStart, 0, colonPos1));
   int startM = (int)StringToInteger(StringSubstr(rawStart, colonPos1 + 1));

   // 解析结束时间 HH:MM
   int colonPos2 = StringFind(rawEnd, ":");
   if(colonPos2 < 0) return false;
   int endH = (int)StringToInteger(StringSubstr(rawEnd, 0, colonPos2));
   int endM = (int)StringToInteger(StringSubstr(rawEnd, colonPos2 + 1));

   // 获取当前北京时间的时分
   datetime beijingNow = GetBeijingTime();
   MqlDateTime mdt;
   TimeToStruct(beijingNow, mdt);
   int nowH = mdt.hour;
   int nowM = mdt.min;

   // 转为分钟数便于比较
   int nowMin   = nowH * 60 + nowM;
   int startMin = startH * 60 + startM;
   int endMin   = endH * 60 + endM;

   if(startMin < endMin)
   {
      // 普通区间:05:30-06:30
      return (nowMin >= startMin && nowMin < endMin);
   }
   else
   {
      // 跨天区间:21:30-04:00
      return (nowMin >= startMin || nowMin < endMin);
   }
}

bool IsPaused()
{
   if(g_pauseUntilTime > 0 && TimeCurrent() < g_pauseUntilTime)
   {
      // 不每个Tick打印,避免日志刷屏
      return true;
   }
   // 暂停结束,清除标志
   if(g_pauseUntilTime > 0 && TimeCurrent() >= g_pauseUntilTime)
   {
      g_pauseUntilTime = 0;
      Print("【暂停结束】恢复交易");
      SaveState();
   }
   return false;
}

//+------------------------------------------------------------------+
//| 检查永久停止状态                                                   |
//+------------------------------------------------------------------+
bool IsPermanentlyStopped()
{
   if(g_permanentlyStopped)
   {
      Print("【永久停止】结余保护已触发,不再交易");
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| 平仓后处理                                                        |
//+------------------------------------------------------------------+
void AfterClose()
{
   DeleteTradeLines();
   g_direction = 0;
   g_entryPrice = 0; g_SL = 0; g_trailLine = 0;
   g_trailActive = false; g_isFirstOrder = true;
   g_orderCount = 0; g_totalLots = 0; g_avgPrice = 0;
   ArrayInitialize(g_orderTickets, 0);
   ArrayInitialize(g_orderLots, 0);
   ArrayInitialize(g_orderPrices, 0);

   // 清除分型保护标记
   g_fractalPending[g_ctxGroup] = false;

   // 重置追踪加仓变量
   ResetAddTracking();

   // 清理异步平仓状态
   ArrayInitialize(g_closeTickets, 0);
   g_closeTicketCount = 0;
   g_closeRetries = 0;
   g_closeReason = "";
   g_autoTradingWarned = false;  // 平仓后重置10027警告标志

   // 记录平仓时的已收盘K线时间(防止同K线重开)
   // 注意:g_candleTime是已收盘K线时间,barTime是当前K线时间
   // 用g_candleTime才能正确匹配CheckBreakout中的判断
   g_closeBarTime = g_candleTime;

   // 更新结余保护(平仓后检查)
   CheckNetProtection();

   // 更新累计统计
   g_stat_totalTrades++;
   if(g_closeProfit > 0)
   {
      g_stat_wins++;
      g_stat_totalProfit += g_closeProfit;
      if(g_closeProfit > g_stat_maxProfit) g_stat_maxProfit = g_closeProfit;
   }
   else if(g_closeProfit < 0)
   {
      g_stat_losses++;
      g_stat_totalLoss -= g_closeProfit;  // g_closeProfit是负数,减去变加
      if(g_closeProfit < g_stat_maxLoss) g_stat_maxLoss = g_closeProfit;
   }
   SaveStatistics();
   Print("【统计更新】总交易:", g_stat_totalTrades,
         " 盈:", g_stat_wins, " 亏:", g_stat_losses,
         " 胜率:", (g_stat_totalTrades > 0 ? DoubleToString(100.0 * g_stat_wins / g_stat_totalTrades, 1) : "0"), "%",
         " 净盈亏:$", DoubleToString(g_stat_totalProfit - g_stat_totalLoss, 2));

   g_groupClosing[g_ctxGroup] = false;
   // 不在这里重置g_kLineTraded,让g_closeBarTime检查来防止同K线重开
   SaveState();
   Print("【组平仓完成】", CurrentGroupTag(), "组 平仓K线时间:", g_closeBarTime);
}

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| UI                                                                |
//+------------------------------------------------------------------+
void CreateUIBackground(int height)
{
   string bgName = g_uiPrefix + "Background";

   ObjectDelete(0, bgName);

   ObjectCreate(0, bgName, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, bgName, OBJPROP_XDISTANCE, InpUIX);
   ObjectSetInteger(0, bgName, OBJPROP_YDISTANCE, InpUIY);
   ObjectSetInteger(0, bgName, OBJPROP_XSIZE, InpUIWidth);
   ObjectSetInteger(0, bgName, OBJPROP_YSIZE, height);
   ObjectSetInteger(0, bgName, OBJPROP_BGCOLOR, InpUIBgColor);
   ObjectSetInteger(0, bgName, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, bgName, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, bgName, OBJPROP_COLOR, clrGray);
   ObjectSetInteger(0, bgName, OBJPROP_SELECTABLE, false);
}

void CreateUILabel(string name, string text, int line, color textColor = clrNONE)
{
   string labelName = g_uiPrefix + name;

   ObjectDelete(0, labelName);

   ObjectCreate(0, labelName, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, labelName, OBJPROP_XDISTANCE, InpUIX + 10);
   ObjectSetInteger(0, labelName, OBJPROP_YDISTANCE, InpUIY + 12 + line * (InpUIFontSize + 4));
   ObjectSetInteger(0, labelName, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, labelName, OBJPROP_COLOR, (textColor == clrNONE) ? InpUITextColor : textColor);
   ObjectSetInteger(0, labelName, OBJPROP_FONTSIZE, InpUIFontSize);
   ObjectSetString(0, labelName, OBJPROP_FONT, "Consolas");
   ObjectSetString(0, labelName, OBJPROP_TEXT, text);
   ObjectSetInteger(0, labelName, OBJPROP_SELECTABLE, false);
}


void CreateManualUILabel(string name, string text, int x, int y, color textColor)
{
   ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, name, OBJPROP_COLOR, textColor);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, InpUIFontSize);
   ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
}

void UpdateUILabel(string name, string text)
{
   string labelName = g_uiPrefix + name;
   if(ObjectFind(0, labelName) >= 0)
      ObjectSetString(0, labelName, OBJPROP_TEXT, text);
}

void DeleteUIObjects()
{
   ObjectsDeleteAll(0, g_uiPrefix);
   ObjectDelete(0, g_closeBtnName);
   ObjectDelete(0, g_closeBtnAName);
   ObjectDelete(0, g_closeBtnBName);
}

//+------------------------------------------------------------------+
//| 创建一键平仓按钮(面板下方,橙色背景红色文字)                      |
//+------------------------------------------------------------------+
void CreateActionButton(string btnName, string btnText, int btnX, int btnY, int btnWidth, int btnHeight)
{
   ObjectDelete(0, btnName);
   ObjectCreate(0, btnName, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, btnName, OBJPROP_XDISTANCE, btnX);
   ObjectSetInteger(0, btnName, OBJPROP_YDISTANCE, btnY);
   ObjectSetInteger(0, btnName, OBJPROP_XSIZE, btnWidth);
   ObjectSetInteger(0, btnName, OBJPROP_YSIZE, btnHeight);
   ObjectSetString(0, btnName, OBJPROP_TEXT, btnText);
   ObjectSetInteger(0, btnName, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, btnName, OBJPROP_BGCOLOR, clrOrange);
   ObjectSetInteger(0, btnName, OBJPROP_COLOR, clrRed);
   ObjectSetInteger(0, btnName, OBJPROP_FONTSIZE, 16);
   ObjectSetString(0, btnName, OBJPROP_FONT, "微软雅黑");
   ObjectSetInteger(0, btnName, OBJPROP_SELECTABLE, true);
   ObjectSetInteger(0, btnName, OBJPROP_HIDDEN, true);
}

void CreateCloseButton()
{
   ObjectDelete(0, g_closeBtnName);
   ObjectDelete(0, g_closeBtnAName);
   ObjectDelete(0, g_closeBtnBName);

   // 按钮尺寸:三按钮上下排列(全部 -> A -> B)
   int btnWidth = 140;
   int btnHeight = 30;
   int btnGap = 6;
   // 位置:紧贴在面板下方,水平居中
   int btnX = InpUIX + (InpUIWidth - btnWidth) / 2;
   int btnY = InpUIY + 20 + 0 * (InpUIFontSize + 4);  // 动态位置,后面更新
   // 背景板高度 + 10px 间距
   int lineHeight = InpUIFontSize + 4;
   int totalLines = CountUITotalLines();
   int bgHeight = 20 + totalLines * lineHeight;
   btnY = InpUIY + bgHeight + 2 * lineHeight;

   CreateActionButton(g_closeBtnName, "🛑 全部平仓", btnX, btnY, btnWidth, btnHeight);
   CreateActionButton(g_closeBtnAName, "🛑 A组平仓", btnX, btnY + btnHeight + btnGap, btnWidth, btnHeight);
   CreateActionButton(g_closeBtnBName, "🛑 B组平仓", btnX, btnY + 2 * (btnHeight + btnGap), btnWidth, btnHeight);
}

//+------------------------------------------------------------------+
//| 统计UI面板总行数(供按钮定位用)                                 |
//+------------------------------------------------------------------+
int CountUITotalLines()
{
   int totalLines = 0;
   totalLines++;  // 标题
   totalLines++;  // 授权
   totalLines++;  // 状态+K线倒计时(同行)
   totalLines++;  // 今日统计
   if(g_consecutiveLosses > 0) totalLines++;     // 连续止损
   if(g_pauseUntilTime > 0 && TimeCurrent() < g_pauseUntilTime) totalLines++;  // 暂停剩余
   if(InpUseNetProtection)
   {
      double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      double protectionValue = CalcProtectionValue();
      if(currentBalance < protectionValue) totalLines++;
   }
   if(g_permanentlyStopped) totalLines++;  // 永久停止
   if(g_inNoTradeWindow) totalLines++;     // 禁止时段
   if(g_kHigh > 0 && g_kLow > 0)
   {
      totalLines += 2;  // 区间信息 Range1 + Range2
   }
   totalLines += 2;  // 一键平仓按钮(3个按钮高度)
   return totalLines;
}

//+------------------------------------------------------------------+
//| 创建图表背景图片(K线下层,图片编译进ex5)                        |
//+------------------------------------------------------------------+
void CreateBgImage()
{
   string imgName = "EMA2_BG_IMAGE";
   ObjectDelete(0, imgName);

   if(!InpShowBgImage)
   return;

   // 获取图表尺寸
   int chartWidth  = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
   int chartHeight = (int)ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS);

   // 创建位图标签
   ObjectCreate(0, imgName, OBJ_BITMAP_LABEL, 0, 0, 0);

   // 使用编译进ex5的资源图片(::前缀表示内嵌资源)
   ObjectSetString(0, imgName, OBJPROP_BMPFILE, "::bg.bmp");

   // 获取图片尺寸
   int imgWidth  = (int)ObjectGetInteger(0, imgName, OBJPROP_XSIZE);
   int imgHeight = (int)ObjectGetInteger(0, imgName, OBJPROP_YSIZE);

   // 居中定位
   int posX = (chartWidth - imgWidth) / 2;
   int posY = (chartHeight - imgHeight) / 2;

   ObjectSetInteger(0, imgName, OBJPROP_XDISTANCE, posX);
   ObjectSetInteger(0, imgName, OBJPROP_YDISTANCE, posY);
   ObjectSetInteger(0, imgName, OBJPROP_CORNER, CORNER_LEFT_UPPER);

   // 关键:放背景层,K线在上层
   ObjectSetInteger(0, imgName, OBJPROP_BACK, true);

   ObjectSetInteger(0, imgName, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, imgName, OBJPROP_HIDDEN, true);

   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 删除背景图片                                                      |
//+------------------------------------------------------------------+
void DeleteBgImage()
{
   ObjectDelete(0, "EMA2_BG_IMAGE");
}

void UpdateComment()
{
   int lineNum = 0;
   int lineHeight = InpUIFontSize + 4;

   // ========== 第一遍:计算总行数 ==========
   int totalLines = 0;
   totalLines++;  // 标题
   totalLines++;  // 授权
   totalLines++;  // 状态+K线倒计时(同行)
   totalLines++;  // 今日统计
   if(g_consecutiveLosses > 0) totalLines++;     // 连续止损
   if(g_pauseUntilTime > 0 && TimeCurrent() < g_pauseUntilTime) totalLines++;  // 暂停剩余
   {
      double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      double protectionValue = CalcProtectionValue();
      if(currentBalance < protectionValue) totalLines++;  // 结余保护触发
   }
   if(g_permanentlyStopped) totalLines++;  // 永久停止
   if(g_inNoTradeWindow) totalLines++;     // 禁止时段
   if(g_kHigh > 0 && g_kLow > 0)
   {
      totalLines += 2;  // 区间信息 Range1 + Range2
   }
   totalLines += 2;  // 一键平仓按钮(3个按钮高度)

   // 创建背景板(刚好包住内容,上下各留padding)
   int bgHeight = 20 + totalLines * lineHeight;
   CreateUIBackground(bgHeight);

   // ========== 第二遍:绘制内容 ==========

   // 标题居中(中文≈字号宽,英文≈0.6字号宽)
   string titleText = "恒鑫EA-微信num7000";
   int cnCount = 4;  // 中文4字:单/均/线/突/破
   int enCount = 17;  // 英文2字符:空格/突/破
   int textWidth = cnCount * InpUIFontSize + enCount * (int)(InpUIFontSize * 0.6);
   int titleX = InpUIX + (InpUIWidth - textWidth) / 2;
   string titleLabel = g_uiPrefix + "Title";
   ObjectDelete(0, titleLabel);
   ObjectCreate(0, titleLabel, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, titleLabel, OBJPROP_XDISTANCE, titleX);
   ObjectSetInteger(0, titleLabel, OBJPROP_YDISTANCE, InpUIY + 12);
   ObjectSetInteger(0, titleLabel, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, titleLabel, OBJPROP_COLOR, InpUITextColor);
   ObjectSetInteger(0, titleLabel, OBJPROP_FONTSIZE, InpUIFontSize);
   ObjectSetString(0, titleLabel, OBJPROP_FONT, "Consolas");
   ObjectSetString(0, titleLabel, OBJPROP_TEXT, titleText);
   ObjectSetInteger(0, titleLabel, OBJPROP_SELECTABLE, false);
   lineNum++;

   // 授权状态
   if(g_permanentlyStopped)
   {
      CreateUILabel("Auth", "授权:已到期(请更新)", lineNum++);
   }
   else if(g_isAuthorized)
   {
   datetime serverTime = TimeTradeServer();
   datetime localTime = TimeLocal();
   int offsetHours = (int)((serverTime - localTime) / 3600);
   datetime expiryUTC = g_expiryDate - offsetHours * 3600;
   int daysLeft = (int)((expiryUTC - serverTime) / 86400);
   if(daysLeft < 0) daysLeft = 0;
   // 获取当前账户号
   long currentAccount = AccountInfoInteger(ACCOUNT_LOGIN);
   string accountStr = IntegerToString(currentAccount);
   CreateUILabel("Auth", "授权:已授权" +
                 " 账户:" + accountStr +
                 " 剩余:" + IntegerToString(daysLeft) + "天", lineNum++);
   }
   else
   {
      CreateUILabel("Auth", "授权:未授权", lineNum++);
   }


   // 状态+K线倒计时(同行)
   string stateStr = "---";
   if(g_state == STATE_WAIT_FIRST_CANDLE) stateStr = "等K线收盘";
   else if(g_state == STATE_WAIT_SIGNAL)   stateStr = "等信号";
   else if(g_state == STATE_IN_TRADE)     stateStr = "持仓中";
   else if(g_state == STATE_CLOSING)      stateStr = "异步平仓中";
   else if(g_state == STATE_WAIT_AFTER_CLOSE) stateStr = "等K线收盘";

   // 计算倒计时
   int periodSec = PeriodSeconds(InpPeriod);
   datetime barOpenTime = 0;
   MqlRates barRatesCD[];
   ArraySetAsSeries(barRatesCD, true);
   if(CopyRates(_Symbol, InpPeriod, 0, 1, barRatesCD) >= 1)
      barOpenTime = barRatesCD[0].time;
   string countdownStr = "K线倒计时:--:--";
   if(barOpenTime > 0 && periodSec > 0)
   {
      int elapsedSec = (int)(TimeCurrent() - barOpenTime);
      int remainSec = periodSec - elapsedSec;
      if(remainSec < 0) remainSec = 0;
      int remainMin = remainSec / 60;
      int remainSec2 = remainSec % 60;
      countdownStr = "K线倒计时:" +
                     (remainMin < 10 ? "0" : "") + IntegerToString(remainMin) + ":" +
                     (remainSec2 < 10 ? "0" : "") + IntegerToString(remainSec2);
   }

   // Y坐标(同行,lineNum不变)
   int stateY = InpUIY + 12 + lineNum * lineHeight;
   int stateX = InpUIX + 10;

   // 状态标签
   CreateManualUILabel(g_uiPrefix + "StateAndCountdown",
                      "状态:" + stateStr + "  " + countdownStr,
                      stateX, stateY, InpUITextColor);

   // 同行不换行
   lineNum++;  // 今日统计从新行开始

   // 今日统计(4个label同行,各自独立颜色)
   int todayTotal = g_todayWins + g_todayLosses;
   int rateVal = (todayTotal > 0) ? (g_todayWins * 100) / todayTotal : 0;
   color rateColor = (rateVal >= 50) ? clrRed : clrGreen;  // 胜率>=50红,<50绿
   color profitColor = (g_todayProfit >= 0) ? clrRed : clrGreen;  // 盈利红,亏损绿

   // Y坐标计算
   int statY = InpUIY + 12 + lineNum * lineHeight;
    int statX = InpUIX + 10;

    // 盈:
    string winsText = "盈:" + IntegerToString(g_todayWins);
    CreateManualUILabel(g_uiPrefix + "TodayWins", winsText, statX, statY, rateColor);
    statX += 5 * InpUIFontSize;  // "盈:XX" 约5字符宽度

    // 亏:
    string lossesText = " 亏:" + IntegerToString(g_todayLosses);
    CreateManualUILabel(g_uiPrefix + "TodayLosses", lossesText, statX, statY, rateColor);
    statX += 5 * InpUIFontSize;

    // 胜率:
    string rateText = " 胜率:" + IntegerToString(rateVal);
    CreateManualUILabel(g_uiPrefix + "TodayRate", rateText, statX, statY, rateColor);
    statX += 6 * InpUIFontSize;

    // 盈亏:
    string profitText = " 盈亏:" + (g_todayProfit >= 0 ? "+" : "") + "$" + DoubleToString(MathAbs(g_todayProfit), 2);
    CreateManualUILabel(g_uiPrefix + "TodayProfit", profitText, statX, statY, profitColor);

    lineNum++;  // 今日统计同行结束后换行


    // 脉冲模式等待状态
    // 脉冲模式显示已移除

    if(g_consecutiveLosses > 0)
      CreateUILabel("Consec", "连续止损:" + IntegerToString(g_consecutiveLosses) + "次", lineNum++);

    // 暂停剩余
    if(g_pauseUntilTime > 0 && TimeCurrent() < g_pauseUntilTime)
    {
      int remainingMin = (int)((g_pauseUntilTime - TimeCurrent()) / 60);
      CreateUILabel("Pause", "暂停剩余:" + IntegerToString(remainingMin) + "分钟", lineNum++);
    }

    // 结余保护触发
    if(InpUseNetProtection)
    {
      double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      double protectionValue = CalcProtectionValue();
      if(currentBalance < protectionValue)
         CreateUILabel("NetProtect", "⚠️结余保护已触发,EA已停止⚠️", lineNum++);
    }

    // 永久停止
    if(g_permanentlyStopped)
      CreateUILabel("Stopped", "⚠️ 永久停止 ⚠️", lineNum++);
    // 禁止时段状态
    if(g_inNoTradeWindow)
      CreateUILabel("NoTrade", "⛔禁止时段⛔ " + InpNoTradeWindow, lineNum++, clrYellow);

    // 区间信息
    if(g_kHigh > 0 && g_kLow > 0)
    {
      string biasStr = (g_bias == 1) ? "做多" : (g_bias == -1) ? "做空" : "双向";
      string lineModeStr = (InpLineMode == LINE_BODY) ? "实体" : "整体";
      string atrModeStr = "";
      if(InpATRMode == ATR_NONE) atrModeStr = "关闭";
      else if(InpATRMode == ATR_BODY) atrModeStr = g_atrOk ? "实体满足" : "实体不满足";
      else if(InpATRMode == ATR_WHOLE) atrModeStr = g_atrOk ? "整体满足" : "整体不满足";

      double upper = (InpLineMode == LINE_BODY) ? MathMax(g_kOpen, g_kClose) : g_kHigh;
      double lower = (InpLineMode == LINE_BODY) ? MathMin(g_kOpen, g_kClose) : g_kLow;

      CreateUILabel("Range1", "区间-" + lineModeStr + " 高:" + DoubleToString(upper, _Digits) +
                    " 低:" + DoubleToString(lower, _Digits), lineNum++);
      CreateUILabel("Range2", "方向:" + biasStr + " ATR:" + atrModeStr, lineNum++);
    }

    // 创建一键平仓按钮
    CreateCloseButton();
    ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 主循环                                                           |
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| 顶底分型识别(单均线4.0版)                                        |
//| 顶分型: K1.High在K2区间内, K3.High在K2区间内, K3.Low < K2.Low    |
//| 底分型: K1.Low在K2区间内, K3.Low在K2区间内, K3.High > K2.High    |
//| 触发条件: 需趋势确认(顶分型平多需bias!=-1, 底分型平空需bias!=-1) |
//+------------------------------------------------------------------+
bool IsTopFractal(double &k1H, double &k1L, double &k2H, double &k2L, double &k3H, double &k3L, double &k3C)
{
    // 新定义: K1.High在K2区间内, K3.High在K2区间内, K3.Low < K2.Low
    if(k1H < k2L || k1H > k2H) return false;
    if(k3H < k2L || k3H > k2H) return false;
    if(k3L >= k2L) return false;
    return true;
}

bool IsBottomFractal(double &k1H, double &k1L, double &k2H, double &k2L, double &k3H, double &k3L, double &k3C)
{
    // 新定义: K1.Low在K2区间内, K3.Low在K2区间内, K3.High > K2.High
    if(k1L < k2L || k1L > k2H) return false;
    if(k3L < k2L || k3L > k2H) return false;
    if(k3H <= k2H) return false;
    return true;
}
void OnTick()
{
    // === 全局保护检查(任何状态都要检查)===
    if(IsPermanentlyStopped()) return;

    // ===== 禁止时段检测(北京时间)=====
    bool inNoTrade = CheckNoTradeWindow();
    // 进入禁止时段:立即平仓所有组
    if(inNoTrade && !g_inNoTradeWindow)
    {
      g_inNoTradeWindow = true;
      datetime nowBeijing = GetBeijingTime();
      MqlDateTime mdt;
      TimeToStruct(nowBeijing, mdt);
      string timeStr = StringFormat("%02d:%02d", mdt.hour, mdt.min);
      Print("【禁止时段开始】北京时间:", timeStr, " 禁止开仓,已平仓所有组");
      Alert("【禁止时段开始】北京时间:", timeStr, " 禁止时段:", InpNoTradeWindow, " 已平仓所有持仓!");
      for(int ntg = 0; ntg < GROUP_COUNT; ntg++)
      {
         LoadGroupRuntime(ntg);
         if(HasGroupPosition(ntg) || g_groupClosing[ntg])
         {
            DoClose("禁止时段强制平仓");
            SaveGroupRuntime(ntg);
         }
      }
    }
    // 退出禁止时段:解除封锁
    else if(!inNoTrade && g_inNoTradeWindow)
    {
      g_inNoTradeWindow = false;
      Print("【禁止时段结束】恢复正常交易");
    }

    if(IsPaused()) return;

    // 授权到期检测(服务器时间,无法绕过)
    StopIfExpired();

    // 实时更新结余保护(最大结余追踪)
    CheckNetProtection();

    // 自动交易恢复后,重置警告标志,下一个Tick自动继续运行
    g_autoTradingWarned = false;

    datetime barTime = GetCurrentBarTime();
    if(barTime == 0) return;


    if(g_prevBarTime == 0)
    {
      g_prevBarTime = barTime;
      UpdateComment();
   return;
    }

    bool newBar = (barTime != g_prevBarTime);
    if(newBar)
    {
      double open, high, low, close, atrVal, emaVal;
      datetime time;
      if(GetLastClosedCandle(open, high, low, close, atrVal, emaVal, time))
      {
         MarkCandle(open, high, low, close, atrVal, emaVal, time);

          
          // ===== 分型检测(按持仓状态) =====
          MqlRates rates3[];
          ArraySetAsSeries(rates3, true);
          if(CopyRates(_Symbol, InpPeriod, 1, 3, rates3) >= 3)
          {
             double k1H = rates3[2].high, k1L = rates3[2].low;
             double k2H = rates3[1].high, k2L = rates3[1].low;
             double k3H = rates3[0].high, k3L = rates3[0].low, k3C = rates3[0].close;
             
             for(int fg = 0; fg < GROUP_COUNT; fg++)
             {
                LoadGroupRuntime(fg);
                if(HasGroupPosition(fg) && !g_fractalPending[fg])  // 持仓且未触发分型
                {
                   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
                   if(posType == POSITION_TYPE_BUY)
                   {
                      // 顶分型触发标记
                      if(IsTopFractal(k1H, k1L, k2H, k2L, k3H, k3L, k3C))
                      {
                         g_fractalPending[fg] = true;
                         Print("【顶分型触发】", CurrentGroupTag(), "组 K2高:", DoubleToString(k2H,_Digits), " 标记待观察");
                       //Alert("【顶分型触发】", CurrentGroupTag(), "组多单待观察!");
                      }
                   }
                   else if(posType == POSITION_TYPE_SELL)
                   {
                      // 底分型触发标记
                      if(IsBottomFractal(k1H, k1L, k2H, k2L, k3H, k3L, k3C))
                      {
                         g_fractalPending[fg] = true;
                         Print("【底分型触发】", CurrentGroupTag(), "组 K2低:", DoubleToString(k2L,_Digits), " 标记待观察");
                       //Alert("【底分型触发】", CurrentGroupTag(), "组空单待观察!");
                      }
                   }
                }
                SaveGroupRuntime(fg);
             }
          }
       }
      g_prevBarTime = barTime;

      // 脉冲模式已移除

      SaveState();
    }

    // 脉冲模式已移除

    // 逐组处理:先异步平仓,再持仓监控
    for(int g = 0; g < GROUP_COUNT; g++)
    {
      LoadGroupRuntime(g);
      if(g_groupClosing[g])
      {
         CheckCloseCompleted();
      }
      else if(HasMyPosition())
      {
         MonitorTradeMartingale();
      }
      SaveGroupRuntime(g);
    }

    // 仅在信号状态下给空闲组开仓:同一信号最多开1组
    if(g_state == STATE_WAIT_SIGNAL)
    {
      int freeGroup = FindFreeGroup();
      if(freeGroup >= 0 && PassABOpenGapForGroup(freeGroup))
      {
         LoadGroupRuntime(freeGroup);
         CheckBreakout();
         SaveGroupRuntime(freeGroup);
      }
    }

    SetGroupContext(0);

    UpdateComment();
}
//+------------------------------------------------------------------+
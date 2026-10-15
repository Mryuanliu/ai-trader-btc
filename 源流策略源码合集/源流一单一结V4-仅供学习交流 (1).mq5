//+------------------------------------------------------------------+
//|                                           GoldSmartSingle V6       |
//|                                    源流一单一结V6 - XAUUSD M5      |
//|               趋势强度过滤 | H1+M15双周期 | 弱趋势限频 | 震荡跳过    |
//|               V6: 强趋势(斜率>0.02%)正常交易, 弱趋势限3笔/天       |
//|                   震荡(H1+M15双弱)跳过, 解决弱趋势慢性失血          |
//|               目标：胜率55-65%，减少震荡/弱趋势亏损                   |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, GoldSmartSingleV6"
#property link      ""
#property version   "6.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\DealInfo.mqh>
#include <Trade\HistoryOrderInfo.mqh>

//+------------------------------------------------------------------+
//| RingBuffer 环形缓冲区模板类                                       |
//+------------------------------------------------------------------+
template<typename T>
class RingBuffer {
private:
   T buffer[];
   int size;
   int head;
   int tail;
   bool full;

public:
   void Init(int bufferSize) {
      size = bufferSize;
      ArrayResize(buffer, size);
      head = 0;
      tail = 0;
      full = false;
   }

   ~RingBuffer() {
      ArrayFree(buffer);
   }

   void Put(T item) {
      buffer[head] = item;
      if(full) tail = (tail + 1) % size;
      head = (head + 1) % size;
      full = (head == tail);
   }

   T Peek(int index) {
      if(index >= Size() || IsEmpty()) return (T)0;
      return buffer[(tail + index) % size];
   }

   bool IsEmpty() { return (!full && (head == tail)); }
   bool IsFull()  { return full; }
   int  Size()    { return full ? size : (head >= tail ? head - tail : size + head - tail); }
};

//+------------------------------------------------------------------+
//| 全局交易对象                                                     |
//+------------------------------------------------------------------+
CTrade trade;

//+------------------------------------------------------------------+
//| 市场状态枚举                                                     |
//+------------------------------------------------------------------+
enum ENUM_MARKET_STATE {
   STATE_MOMENTUM,    // 动量充足 → 模式A
   STATE_RETRACEMENT  // 回调模式 → 模式B
};

//+------------------------------------------------------------------+
//| V6: 市场环境枚举                                                  |
//+------------------------------------------------------------------+
enum ENUM_MARKET_REGIME {
   REGIME_TRENDING,   // 趋势市场 → 趋势跟踪策略
   REGIME_RANGING     // 震荡市场 → 均值回归策略
};

//+------------------------------------------------------------------+
//| 输入参数 - 信号参数                                              |
//+------------------------------------------------------------------+
input int      H1_TrendEMA       = 50;        // H1趋势EMA周期
input ENUM_TIMEFRAMES SignalTF     = PERIOD_M5; // 信号时间周期
input int      Signal_RetestEMA     = 13;        // 信号周期回调EMA
input double   TrendThreshold    = 0.3;       // 趋势判定阈值(%)
input int      RSI_Period        = 14;        // RSI周期
input double   MinH1Slope        = 0.02;      // V6: H1最小斜率(%,低于此值=弱趋势,降频交易)
input double   MinM15Slope       = 0.01;      // V6: M15最小斜率(%,H1+M15都弱=震荡,不交易)
input int      MaxWeakTrendTrades = 3;        // V6: 弱趋势日最大交易笔数

//+------------------------------------------------------------------+
//| 输入参数 - V6新增: 震荡模式(均值回归)                             |
//+------------------------------------------------------------------+
input int      ADX_Period         = 14;       // ADX周期(H1)
input double   ADX_TrendMin       = 22.0;     // ADX>此值=趋势市场
input double   ADX_RangeMax       = 18.0;     // ADX<此值=震荡市场
input int      Range_Lookback     = 20;       // 震荡区间回溯K线数(M15)
input double   Range_MinWidthATR  = 1.5;      // 区间最小宽度(ATR倍数)
input double   Range_EntryZoneATR = 1.0;      // 区间边界入场区域(ATR倍数)
input int      Range_MaxTrades    = 2;        // 震荡模式下日最大交易笔数
input double   Range_RiskMult     = 0.5;      // 震荡模式风险倍数(相比趋势)

//+------------------------------------------------------------------+
//| 输入参数 - 手数参数                                              |
//+------------------------------------------------------------------+
input double   BaseLot_Min         = 0.01;     // 最小手数
input double   BaseLot_Max         = 0.05;     // 最大手数
input double   RiskUSD_Low         = 4.0;      // 低质量信号风险金额(评分<60)
input double   RiskUSD_Medium      = 6.0;      // 中等质量信号风险金额(60-79)
input double   RiskUSD_High        = 8.0;      // 高质量信号风险金额(>=80)

//+------------------------------------------------------------------+
//| 输入参数 - 止损止盈                                              |
//+------------------------------------------------------------------+
input bool     ManualCentAccount   = false;    // 强制美分
input int      PointMultiplier     = 0;        // 点数倍率（0=自动）
input int      ATR_Period          = 14;       // ATR周期
input double   ATR_SL_Multiplier_A = 1.2;      // 模式A止损=ATR×N
input double   ATR_SL_Multiplier_B = 1.5;      // 模式B止损=ATR×N
input double   RiskRewardRatio_A   = 2.5;      // 模式A止盈比
input double   RiskRewardRatio_B   = 1.5;      // 模式B止盈比
input int      MinSL_Points        = 15;       // 最小止损点数
input double   BreakEvenPercent_A  = 65.0;     // 模式A保本触发%
input double   BreakEvenPercent_B  = 60.0;     // 模式B保本触发%
input double   MaxLossPerTrade     = 0;        // 单笔最大亏损(0=禁用，用ATR动态止损)
input int      MinBarsBetweenSignals = 3;      // 信号间隔(M5 K线，跨模式)

//+------------------------------------------------------------------+
//| 输入参数 - V6: 资金风控(防崩溃)                                   |
//+------------------------------------------------------------------+
input double   DailyMaxLossV6      = 120.0;    // V6: 日亏损上限$(达到即停,给黄金留波动空间)
input double   DailyProfitTarget   = 0.0;      // V6: 日盈利目标$(0=禁用,赚钱日不要限制)
input int      MaxConsecutiveLossesV6 = 3;     // V6: 连续亏损上限(达到即停)
input bool     UseEquityRisk       = true;     // V6: 启用净值百分比风险模型
input double   RiskPercentPerTrade = 2.0;      // V6: 每笔风险%(净值百分比,UseEquityRisk=true时)

//+------------------------------------------------------------------+
//| 输入参数 - 追踪止损(模式A)                                       |
//+------------------------------------------------------------------+
input double   TrailingATR_Multiple = 1.5;     // 追踪启动(ATR倍数)
input double   TrailingPullback     = 0.7;     // 回撤幅度(ATR倍数)

//+------------------------------------------------------------------+
//| 输入参数 - 风控参数                                              |
//+------------------------------------------------------------------+
input double   DailyMaxLoss        = 0;        // 每日最大亏损(0=不限)
input int      DailyMaxTrades      = 0;        // 每日最大交易次数(0=不限)
input int      MaxSpread           = 30;       // 最大允许点差
input int      Deviation           = 10;       // 滑点
input int      MaxSlippageRetries  = 3;        // 滑点重试次数

//+------------------------------------------------------------------+
//| 输入参数 - 交易时间过滤                                          |
//+------------------------------------------------------------------+
input bool     EnableTradingHours  = false;    // 启用交易时间限制
input int      TradingStartHour    = 8;        // 交易开始小时
input int      TradingEndHour      = 22;       // 交易结束小时

//+------------------------------------------------------------------+
//| 输入参数 - 新闻过滤                                              |
//+------------------------------------------------------------------+
input bool     NewsFilterOn        = false;    // 启用新闻过滤(默认关闭)
input string   NewsCurrencies      = "USD";    // 关注货币
input string   KeyNews             = "NFP,Nonfarm,PMI,Interest Rate,FOMC,CPI,PPI,GDP";
input int      StopBeforeMin       = 30;       // 新闻前停止交易(分钟)
input int      StartTradingMin     = 60;       // 新闻后恢复交易(分钟)
input int      DayNewsLookup       = 3;        // 查询未来几天新闻

//+------------------------------------------------------------------+
//| 输入参数 - 星期过滤                                              |
//+------------------------------------------------------------------+
input bool     EnableDayFilter     = false;    // 启用星期过滤
input bool     TradeMonday         = true;
input bool     TradeTuesday        = true;
input bool     TradeWednesday      = true;
input bool     TradeThursday       = true;
input bool     TradeFriday         = true;
input bool     TradeSaturday       = false;
input bool     TradeSunday         = false;

//+------------------------------------------------------------------+
//| 输入参数 - K线形态参数                                           |
//+------------------------------------------------------------------+
input double   Hammer_ShadowRatio   = 2.0;    // 锤子线影线/实体倍数
input double   Hammer_UpperRatio    = 0.3;    // 锤子线上影线/实体上限
input double   LargeBodyRatio       = 1.5;    // 大实体=均值×N
input double   SmallBodyRatio       = 0.3;    // 小实体=均值×N

//+------------------------------------------------------------------+
//| 输入参数 - 市场状态判定参数                                      |
//+------------------------------------------------------------------+
input double   Momentum_ROC_Threshold = 0.35; // ROC阈值(%) — 黄金M5需0.3+才有区分度
input double   Momentum_EMADeviation  = 0.2;  // H1 EMA偏离阈值(%)

//+------------------------------------------------------------------+
//| 输入参数 - 通用参数                                              |
//+------------------------------------------------------------------+
input long     MagicNumber         = 20260526; // 魔术号
input string   PanelPrefix         = "GSSV4_"; // 面板对象名前缀

//+------------------------------------------------------------------+
//| 全局状态变量 - 每日统计                                          |
//+------------------------------------------------------------------+
int    m_todayTrades       = 0;
double m_todayProfit       = 0.0;
double m_todayMaxFloating  = 0.0;
string m_currentDate       = "";
int    m_todayWeakTrendTrades = 0;  // V6: 弱趋势日交易计数
int    m_todayRangeTrades    = 0;   // V6: 震荡日交易计数
ENUM_MARKET_REGIME m_lastRegime = REGIME_TRENDING; // V6: 市场环境(防抖)
int    m_consecutiveLossesV6 = 0;   // V6: 当日连续亏损计数
bool   m_dailyStopTriggered  = false; // V6: 日停止标志

//+------------------------------------------------------------------+
//| 全局状态变量 - 信号记录                                          |
//+------------------------------------------------------------------+
int    m_lastSignalScore   = 0;
string m_lastSignalDir     = "";
ulong  m_lastTicket        = 0;
ulong  m_lastPositionID    = 0;
string m_trendDesc         = "";
int    m_lastOpenBarIndex  = -1;    // 上次开仓的K线索引(用于MinBarsBetweenSignals)
ENUM_MARKET_STATE m_currentState = STATE_RETRACEMENT; // 当前市场状态
bool   m_entryIsMomentum   = false; // 当前持仓是否为动量模式

//+------------------------------------------------------------------+
//| 全局变量 - 平仓检测                                              |
//+------------------------------------------------------------------+
ulong  m_lastDealTicket    = 0;
double m_lastClosedPL      = 0.0;
double m_lastClosedLots    = 0.0;

//+------------------------------------------------------------------+
//| 全局变量 - 追踪止损状态(模式A)                                   |
//+------------------------------------------------------------------+
double m_trailLevel        = 0.0;   // 当前追踪线价格
double m_maxProfitPoints   = 0.0;   // 开仓以来最高浮动盈利(点数)
double m_highestPrice      = 0.0;   // 开仓以来最高价(做多)
double m_lowestPrice       = 0.0;   // 开仓以来最低价(做空)
double m_openATRValue      = 0.0;   // 开仓时的ATR值(用于追踪止损)
double m_openATRPoints     = 0.0;   // 开仓时的ATR(点数)
double m_trailActivated    = false; // 追踪止损是否已激活

//+------------------------------------------------------------------+
//| 指标句柄                                                        |
//+------------------------------------------------------------------+
int handle_H1_TrendEMA      = INVALID_HANDLE;
int handle_Signal_RetestEMA = INVALID_HANDLE;
int handle_iRSI             = INVALID_HANDLE;
int handle_ATR              = INVALID_HANDLE;
int handle_M15_TrendEMA     = INVALID_HANDLE;
int handle_PSAR             = INVALID_HANDLE;
int handle_ADX              = INVALID_HANDLE;  // V6: ADX(H1) for regime detection

//+------------------------------------------------------------------+
//| 自动检测的全局内部参数                                           |
//+------------------------------------------------------------------+
int    g_pointMultiplier = 1;
bool   m_isCent          = false;
const double CONTRACT_SIZE = 100.0;

//+------------------------------------------------------------------+
//| 全局变量 - 环形缓冲区与行情追踪                                  |
//+------------------------------------------------------------------+
RingBuffer<double> SpreadHistoryBuffer;
RingBuffer<double> PriceHistoryBuffer;
RingBuffer<long>   TimeHistoryBuffer;
double   Global_Spread_Sum  = 0.0;
double   Average_Spread     = 0.0;
double   Current_Spread     = 0.0;
double   Price_Movement     = 0.0;
#define  BUFFER_SIZE        100

//+------------------------------------------------------------------+
//| 全局变量 - 交易限制状态                                           |
//+------------------------------------------------------------------+
bool     EnableTradingTime      = false;
enum ENUM_RESTRICTION_REASON {
   NO_RESTRICTION,
   TIME_RESTRICTION,
   DAY_RESTRICTION,
   NEWS_RESTRICTION,
   TIME_DAY_RESTRICTION,
   TIME_NEWS_RESTRICTION,
   DAY_NEWS_RESTRICTION,
   ALL_RESTRICTIONS
};
ENUM_RESTRICTION_REASON LastRestrictionReason = NO_RESTRICTION;
bool     TrDisabledNews      = false;
datetime LastNewsAvoided     = 0;
string   TradingEnabledComm  = "";

// 新K线检测
int m_prevBars = 0;

//+------------------------------------------------------------------+
//| 函数前置声明                                                     |
//+------------------------------------------------------------------+
int  GetH1Trend();
bool CheckMarketState();
int  GetEntryMomentum(double &outScore);
int  GetEntryRetracement(double &outScore);
double GetATRValue();
double GetATRPercentile();
double GetAvgBody(int nBars);
bool IsBullishReversalV3(int shift);
bool IsBearishReversalV3(int shift);
bool IsHammer(int shift);
bool IsHangingMan(int shift);
bool IsBullishEngulfing(int shift);
bool IsBearishEngulfing(int shift);
bool IsMorningStar(int shift);
bool IsEveningStar(int shift);
bool IsPiercingLine(int shift);
bool IsDarkCloudCover(int shift);
double GetH1Slope();
double GetM15Slope();
int    GetTrendQuality();
ENUM_MARKET_REGIME GetMarketRegime();
bool   FindSwingLevels(double &rangeHigh, double &rangeLow, double &rangeMid);
int    CheckRangeTrade(double &outScore);
double GetLotSize(double signalScore, double slDist, double atrPercentile);
bool OpenOrderWithRetry(int signal, double lot, double sl, double tp, string comment);
void CheckBreakEven(ulong ticket, double breakEvenPercent, double spreadBuffer);
void CheckMaxLoss(ulong ticket);
void CheckTrailingStop(ulong ticket);
void ResetTrailingState();
void OnTick();
void CreatePanel();
void UpdatePanel();
void DeletePanel();
void ReleaseIndicators();
bool IsWithinTradingHours();
bool IsTradingDayAllowed();
bool IsUpcomingNews();
void UpdateDataWithRingBuffer(double Ask, double Bid);
void ShowTradingHourAlert(string message);
string GetRestrictionMessage(ENUM_RESTRICTION_REASON reason);

//+------------------------------------------------------------------+
//| 专家初始化函数                                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(Deviation);

   // 验证输入参数
   if(H1_TrendEMA < 1 || Signal_RetestEMA < 1 || RSI_Period < 1)
   {
      Print("错误：周期参数必须大于0");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(BaseLot_Min <= 0 || BaseLot_Max < BaseLot_Min)
   {
      Print("错误：手数参数无效");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(MinSL_Points <= 0)
   {
      Print("错误：最小止损点数必须大于0");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(ATR_Period < 1 || ATR_SL_Multiplier_A <= 0.0 || ATR_SL_Multiplier_B <= 0.0)
   {
      Print("错误：ATR参数无效");
      return INIT_PARAMETERS_INCORRECT;
   }

   // 回测检查：美分后缀符号
   if(MQLInfoInteger(MQL_TESTER))
   {
      string symName = _Symbol;
      int symLen = StringLen(symName);
      if(symLen > 0)
      {
         ushort lastCh = StringGetCharacter(symName, symLen - 1);
         if(lastCh == 'c' || lastCh == 'C')
         {
            Print("回测不兼容美分后缀品种：", _Symbol);
            return INIT_PARAMETERS_INCORRECT;
         }
      }
   }

   // === 版本标识（用于确认回测使用了修改后的代码）===
   Print("==========================================================");
   Print(">>>> 源流一单一结V6-趋势强度过滤版 <<<<");
   Print(">>>> 编译日期: ", __DATE__);
   Print(">>>> ATR_SL: A=", ATR_SL_Multiplier_A, " B=", ATR_SL_Multiplier_B);
   Print(">>>> R:R: A=1:", RiskRewardRatio_A, " B=1:", RiskRewardRatio_B);
   Print(">>>> 保本触发: A=", BreakEvenPercent_A, "% B=", BreakEvenPercent_B, "%");
   Print(">>>> 追踪: 启动=", TrailingATR_Multiple, "ATR 回撤=", TrailingPullback, "ATR");
   Print(">>>> 风险优先手数: Low=", RiskUSD_Low, " Med=", RiskUSD_Medium, " High=", RiskUSD_High);
   Print(">>>> V6: 最小H1斜率=", MinH1Slope, "% M15斜率=", MinM15Slope, "% 弱趋势上限=", MaxWeakTrendTrades, "笔/天");
   Print(">>>> 品种: ", _Symbol, " 周期: ", EnumToString(SignalTF));
   Print("==========================================================");

   // 自动检测点数倍率
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   if(PointMultiplier > 0)
      g_pointMultiplier = PointMultiplier;
   else
   {
      if(digits >= 4)       g_pointMultiplier = 10;
      else if(digits == 3)  g_pointMultiplier = 100;
      else if(digits == 2)  g_pointMultiplier = 10;
      else                  g_pointMultiplier = 1;
   }

   // 自动检测美分账户
   if(ManualCentAccount)
      m_isCent = true;
   else
   {
      string sym = _Symbol;
      StringToUpper(sym);
      m_isCent = (StringFind(sym, "C") >= 0 && StringFind(sym, "USD") >= 0
                  && StringLen(sym) > 6 && StringGetCharacter(sym, StringLen(sym)-1) == 'C');
      if(!m_isCent)
      {
         double tickVal = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
         m_isCent = (tickVal > 0.0 && tickVal < 0.1);
      }
   }

   // 创建指标句柄
   handle_H1_TrendEMA = iMA(_Symbol, PERIOD_H1, H1_TrendEMA, 0, MODE_EMA, PRICE_CLOSE);
   if(handle_H1_TrendEMA == INVALID_HANDLE)
   {
      int m15Period = MathMax(H1_TrendEMA * 4, 200);
      handle_H1_TrendEMA = iMA(_Symbol, SignalTF, m15Period, 0, MODE_EMA, PRICE_CLOSE);
      if(handle_H1_TrendEMA != INVALID_HANDLE)
         Print("H1数据不可用，回退至M" + IntegerToString(PeriodSeconds(SignalTF)/60) + " EMA", m15Period);
   }

   handle_Signal_RetestEMA = iMA(_Symbol, SignalTF, Signal_RetestEMA, 0, MODE_EMA, PRICE_CLOSE);
   handle_iRSI     = iRSI(_Symbol, SignalTF, RSI_Period, PRICE_CLOSE);
   handle_ATR      = iATR(_Symbol, SignalTF, ATR_Period);
   handle_M15_TrendEMA = iMA(_Symbol, PERIOD_M15, 50, 0, MODE_EMA, PRICE_CLOSE);
   handle_PSAR = iSAR(_Symbol, SignalTF, 0.02, 0.2);
   handle_ADX  = iADX(_Symbol, PERIOD_H1, ADX_Period);  // V6: ADX市场环境判定

   if(handle_H1_TrendEMA == INVALID_HANDLE || handle_Signal_RetestEMA == INVALID_HANDLE
      || handle_iRSI == INVALID_HANDLE || handle_ATR == INVALID_HANDLE
      || handle_M15_TrendEMA == INVALID_HANDLE || handle_PSAR == INVALID_HANDLE
      || handle_ADX == INVALID_HANDLE)
   {
      Print("错误：指标句柄创建失败，错误码：", GetLastError());
      return INIT_FAILED;
   }

   // 初始化环形缓冲区
   SpreadHistoryBuffer.Init(BUFFER_SIZE);
   PriceHistoryBuffer.Init(BUFFER_SIZE);
   TimeHistoryBuffer.Init(BUFFER_SIZE);

   // 设置交易时间
   EnableTradingTime = EnableTradingHours;

   // 初始化K线计数
   m_prevBars = Bars(_Symbol, SignalTF);

   // 创建信息面板
   CreatePanel();

   Print("V4 品种：", _Symbol, " 小数位数：", digits,
         " _Point：", _Point, " 倍率：", g_pointMultiplier, " 美分：", m_isCent);

   if(!EventSetTimer(1))
      Print("警告：定时器创建失败，错误码：", GetLastError());

   Print("GoldSmartSingle V4 初始化完成，品种：", _Symbol, " 魔术号：", MagicNumber);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| 专家反初始化函数                                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   ReleaseIndicators();
   DeletePanel();
   EventKillTimer();
   Print("V4 EA已卸载，原因码：", reason);
}

//+------------------------------------------------------------------+
//| 定时器事件                                                       |
//+------------------------------------------------------------------+
void OnTimer()
{
   UpdatePanel();
}

//+------------------------------------------------------------------+
//| H1趋势判定(5点线性回归斜率)                                       |
//| 返回值: 1=上升, -1=下降, 0=震荡                                   |
//+------------------------------------------------------------------+
int GetH1Trend()
{
   double h1Ema[5];
   ArraySetAsSeries(h1Ema, true);
   if(CopyBuffer(handle_H1_TrendEMA, 0, 0, 5, h1Ema) < 5) return 0;

   double h1Ema0 = h1Ema[0];
   if(h1Ema0 <= 0.0) return 0;

   // 线性回归斜率
   double sumX = 0.0, sumY = 0.0, sumXY = 0.0, sumX2 = 0.0;
   int n = 5;
   for(int i = 0; i < n; i++)
   {
      double x = (double)i;
      double y = h1Ema[i];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
   }
   double denominator = n * sumX2 - sumX * sumX;
   double h1Slope = 0.0;
   if(denominator != 0.0)
      h1Slope = (n * sumXY - sumX * sumY) / denominator;
   h1Slope = h1Slope / h1Ema0 * 100.0;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return 0;
   double midPrice = (tick.bid + tick.ask) / 2.0;
   double h1Deviation = MathAbs(midPrice - h1Ema0) / h1Ema0 * 100.0;

   bool emaRising  = (h1Slope > 0.008);
   bool emaFalling = (h1Slope < -0.008);

   // 价格紧贴EMA且无斜率 → 震荡
   if(h1Deviation < TrendThreshold && !emaRising && !emaFalling)
      return 0;

   int trendDir = 0;
   // 价格在EMA上方
   if(midPrice >= h1Ema0)
   {
      if(emaFalling && h1Deviation < TrendThreshold * 2)
         trendDir = 0;   // EMA下降但价格接近EMA → 过渡区
      else
         trendDir = 1;   // 上升趋势
   }
   // 价格在EMA下方
   else
   {
      if(emaRising && h1Deviation < TrendThreshold * 2)
         trendDir = 0;   // EMA上升但价格接近EMA → 过渡区
      else
         trendDir = -1;  // 下降趋势
   }

   return trendDir;
}

//+------------------------------------------------------------------+
//| V6新增: 获取H1斜率原始值(%)，用于趋势强度判断                       |
//+------------------------------------------------------------------+
double GetH1Slope()
{
   double h1Ema[5];
   ArraySetAsSeries(h1Ema, true);
   if(CopyBuffer(handle_H1_TrendEMA, 0, 0, 5, h1Ema) < 5) return 0.0;

   double h1Ema0 = h1Ema[0];
   if(h1Ema0 <= 0.0) return 0.0;

   double sumX = 0.0, sumY = 0.0, sumXY = 0.0, sumX2 = 0.0;
   for(int i = 0; i < 5; i++)
   {
      double x = (double)i;
      double y = h1Ema[i];
      sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
   }
   double denominator = 5 * sumX2 - sumX * sumX;
   if(denominator == 0.0) return 0.0;
   return (5 * sumXY - sumX * sumY) / denominator / h1Ema0 * 100.0;
}

//+------------------------------------------------------------------+
//| V6新增: 获取M15斜率(%)，用于多周期趋势确认                         |
//+------------------------------------------------------------------+
double GetM15Slope()
{
   double m15Ema[3];
   ArraySetAsSeries(m15Ema, true);
   if(CopyBuffer(handle_M15_TrendEMA, 0, 0, 3, m15Ema) < 3) return 0.0;
   double m15Ema0 = m15Ema[0];
   if(m15Ema0 <= 0.0) return 0.0;
   return (m15Ema[0] - m15Ema[2]) / m15Ema0 * 100.0;
}

//+------------------------------------------------------------------+
//| V6新增: 趋势质量评估                                              |
//| 返回: 2=强趋势, 1=弱趋势, 0=震荡                                  |
//+------------------------------------------------------------------+
int GetTrendQuality()
{
   int h1 = GetH1Trend();
   double h1Slope = GetH1Slope();
   double m15Slope = GetM15Slope();

   // H1震荡 → 震荡
   if(h1 == 0) return 0;

   // H1+M15都弱 → 震荡(即使H1=±1也按震荡处理)
   if(MathAbs(h1Slope) < MinH1Slope && MathAbs(m15Slope) < MinM15Slope)
      return 0;

   // H1斜率足够 → 强趋势
   if(MathAbs(h1Slope) >= MinH1Slope)
      return 2;

   // H1弱但M15配合 → 弱趋势
   return 1;
}

//+------------------------------------------------------------------+
//| 市场环境判定(ADX + H1趋势)                                    |
//| 返回: REGIME_TRENDING=趋势, REGIME_RANGING=震荡                    |
//+------------------------------------------------------------------+
ENUM_MARKET_REGIME GetMarketRegime()
{
   // 读取H1 ADX值
   double adxBuf[1];
   ArraySetAsSeries(adxBuf, true);
   if(CopyBuffer(handle_ADX, 0, 0, 1, adxBuf) <= 0)
      return REGIME_TRENDING; // 数据不足默认趋势

   double adx = adxBuf[0];
   int h1Trend = GetH1Trend();
   double h1Slope = GetH1Slope();

   // H1=震荡 → 直接判为震荡市场
   if(h1Trend == 0)
      return REGIME_RANGING;

   // ADX>阈值 + 趋势明确 → 趋势市场
   if(adx > ADX_TrendMin && MathAbs(h1Slope) >= MinH1Slope * 0.5)
      return REGIME_TRENDING;

   // ADX<阈值 → 震荡市场
   if(adx < ADX_RangeMax)
      return REGIME_RANGING;

   // 中间值: 维持上一状态(防抖动)
   return m_lastRegime;
}

//+------------------------------------------------------------------+
//| V6: 查找M15震荡区间上下沿                                          |
//| 返回: true=找到有效区间, false=区间太窄或无明确边界                  |
//+------------------------------------------------------------------+
bool FindSwingLevels(double &rangeHigh, double &rangeLow, double &rangeMid)
{
   MqlRates m15Rates[];
   ArraySetAsSeries(m15Rates, true);
   int copied = CopyRates(_Symbol, PERIOD_M15, 0, Range_Lookback, m15Rates);
   if(copied < Range_Lookback) return false;

   // 找最近20根M15 K线的最高价和最低价
   rangeHigh = m15Rates[1].high;  // 从已完成K线开始
   rangeLow  = m15Rates[1].low;
   for(int i = 1; i < copied; i++)
   {
      if(m15Rates[i].high > rangeHigh) rangeHigh = m15Rates[i].high;
      if(m15Rates[i].low  < rangeLow)  rangeLow  = m15Rates[i].low;
   }

   // 区间中间价
   rangeMid = (rangeHigh + rangeLow) / 2.0;

   // 检查区间宽度是否足够(用M5 ATR衡量)
   double atrVal = GetATRValue();
   if(atrVal <= 0.0) return false;
   double rangeWidth = (rangeHigh - rangeLow) / _Point / g_pointMultiplier; // 点数
   double minWidth = atrVal / _Point / g_pointMultiplier * Range_MinWidthATR;

   return (rangeWidth >= minWidth);
}

//+------------------------------------------------------------------+
//| V6: 震荡模式入场检测(均值回归)                                     |
//| 做多: 价格在区间下沿 + 看涨K线                                     |
//| 做空: 价格在区间上沿 + 看跌K线                                     |
//+------------------------------------------------------------------+
int CheckRangeTrade(double &outScore)
{
   outScore = 0.0;

   double rangeHigh, rangeLow, rangeMid;
   if(!FindSwingLevels(rangeHigh, rangeLow, rangeMid))
      return 0;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return 0;

   double atrVal = GetATRValue();
   if(atrVal <= 0.0) return 0;

   double entryZone = atrVal * Range_EntryZoneATR;
   double midPrice = (tick.bid + tick.ask) / 2.0;

   // M5 K线数据(用已完成K线判断形态)
   MqlRates rates[11];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, 0, 11, rates) < 11) return 0;

   double rsiData[2];
   ArraySetAsSeries(rsiData, true);
   if(CopyBuffer(handle_iRSI, 0, 0, 2, rsiData) < 2) return 0;
   double rsi1 = rsiData[1]; // 已完成K线RSI

   int shift = 1; // 前一根已完成K线

   // --- 做多: 价格在区间下沿附近 ---
   double distToLow = midPrice - rangeLow;
   if(distToLow > 0 && distToLow < entryZone && rsi1 < 45.0)
   {
      // 需要看涨K线形态确认
      if(IsBullishReversalV3(shift))
      {
         outScore = 65.0;
         if(rsi1 < 35.0) outScore += 10;     // 超卖加分
         if(distToLow < entryZone * 0.5) outScore += 10; // 非常接近下沿
         if(IsBullishEngulfing(shift) || IsMorningStar(shift)) outScore += 10;
         outScore = MathMin(outScore, 95.0);

         double slDist = atrVal * 1.2; // 震荡模式用更紧止损
         if(slDist < MinSL_Points * g_pointMultiplier * _Point)
            slDist = MinSL_Points * g_pointMultiplier * _Point;

         Print("[震荡模式] 做多信号! 评分=", outScore,
               " 区间下沿=", rangeLow, " 当前价格=", midPrice,
               " 距下沿=", DoubleToString(distToLow/_Point/g_pointMultiplier, 0), "pt",
               " RSI=", DoubleToString(rsi1, 1));
         return 1;
      }
   }

   // --- 做空: 价格在区间上沿附近 ---
   double distToHigh = rangeHigh - midPrice;
   if(distToHigh > 0 && distToHigh < entryZone && rsi1 > 55.0)
   {
      if(IsBearishReversalV3(shift))
      {
         outScore = 65.0;
         if(rsi1 > 65.0) outScore += 10;     // 超买加分
         if(distToHigh < entryZone * 0.5) outScore += 10;
         if(IsBearishEngulfing(shift) || IsEveningStar(shift)) outScore += 10;
         outScore = MathMin(outScore, 95.0);

         double slDist = atrVal * 1.2;
         if(slDist < MinSL_Points * g_pointMultiplier * _Point)
            slDist = MinSL_Points * g_pointMultiplier * _Point;

         Print("[震荡模式] 做空信号! 评分=", outScore,
               " 区间上沿=", rangeHigh, " 当前价格=", midPrice,
               " 距上沿=", DoubleToString(distToHigh/_Point/g_pointMultiplier, 0), "pt",
               " RSI=", DoubleToString(rsi1, 1));
         return -1;
      }
   }

   return 0;
}

//+------------------------------------------------------------------+
//| 市场状态判断(4维度, 带方向一致性校验)                               |
//| 返回值: true=动量模式, false=回调模式                              |
//+------------------------------------------------------------------+
bool CheckMarketState()
{
   int momentumCount = 0;
   int h1Trend = GetH1Trend();

   // 维度1: M5单K线变化率 — 连续5根中至少3根 > 阈值(用ATR归一化, 适配XAUUSD)
   MqlRates rates[5];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, 0, 5, rates) >= 5)
   {
      double atrVal = GetATRValue();
      if(atrVal > 0.0)
      {
         int strongBars = 0;
         int directionSum = 0; // 方向计数: 阳线+1, 阴线-1
         for(int i = 0; i < 5; i++)
         {
            double bodySize = MathAbs(rates[i].close - rates[i].open);
            // 用ATR归一化: 实体>0.5ATR算强K线
            if(bodySize > atrVal * 0.5)
               strongBars++;
            directionSum += (rates[i].close > rates[i].open) ? 1 : -1;
         }
         // 至少3根强K线, 且方向一致(与H1趋势同向)
         if(strongBars >= 3)
         {
            if((h1Trend == 1 && directionSum > 0) || (h1Trend == -1 && directionSum < 0))
               momentumCount++;
            else if(h1Trend == 0 && MathAbs(directionSum) >= 3) // 震荡时要求更强方向性
               momentumCount++;
         }
      }
   }
   else return false; // 数据不足

   // 维度2: PSAR连续方向 — 最近3根已完成K线全部同侧
   double psarBuf[5];
   ArraySetAsSeries(psarBuf, true);
   if(CopyBuffer(handle_PSAR, 0, 0, 5, psarBuf) >= 5)
   {
      if(CopyRates(_Symbol, SignalTF, 0, 5, rates) >= 5)
      {
         bool allBullish = true;
         bool allBearish = true;
         for(int i = 1; i <= 3; i++)  // 只用已完成K线(1-3)
         {
            if(rates[i].close <= psarBuf[i]) allBullish = false;
            if(rates[i].close >= psarBuf[i]) allBearish = false;
         }
         // PSAR方向必须与H1趋势一致, H1震荡时PSAR不投票
         if((h1Trend == 1 && allBullish) || (h1Trend == -1 && allBearish))
            momentumCount++;
      }
   }

   // 维度3: H1 EMA偏离
   MqlTick tick;
   if(SymbolInfoTick(_Symbol, tick))
   {
      double h1Ema0[1];
      ArraySetAsSeries(h1Ema0, true);
      if(CopyBuffer(handle_H1_TrendEMA, 0, 0, 1, h1Ema0) > 0 && h1Ema0[0] > 0.0)
      {
         double midPrice = (tick.bid + tick.ask) / 2.0;
         double deviation = MathAbs(midPrice - h1Ema0[0]) / h1Ema0[0] * 100.0;
         // 偏离方向必须与H1趋势一致
         bool deviationAligned = (h1Trend == 1 && midPrice > h1Ema0[0])
                              || (h1Trend == -1 && midPrice < h1Ema0[0]);
         if(deviation > Momentum_EMADeviation && deviationAligned)
            momentumCount++;
      }
   }

   // 维度4: RSI趋势 — RSI[1] > RSI[3] 且连续上升/下降(用&&)
   double rsiData[4];
   ArraySetAsSeries(rsiData, true);
   if(CopyBuffer(handle_iRSI, 0, 0, 4, rsiData) >= 4)
   {
      bool rsiTrendUp   = (rsiData[1] > rsiData[3]);   // 整体上升(用已完成K线)
      bool rsiTrendDown = (rsiData[1] < rsiData[3]);   // 整体下降
      // 至少2根连续上升/下降(用&&, 非||)
      bool atLeast2Up   = (rsiData[1] > rsiData[2] && rsiData[2] > rsiData[3]);
      bool atLeast2Down = (rsiData[1] < rsiData[2] && rsiData[2] < rsiData[3]);

      if((h1Trend == 1 && rsiTrendUp && atLeast2Up) || (h1Trend == -1 && rsiTrendDown && atLeast2Down))
         momentumCount++;
   }

   bool result = (momentumCount >= 2);
   Print("[市场状态] 动量维度得分: ", momentumCount, "/4 → ", (result ? "动量模式A" : "回调模式B"));
   return result;
}

//+------------------------------------------------------------------+
//| 模式A: 动量突破入场(做多)                                        |
//| 条件: 趋势确认+EMA+RSI+ATR (PSAR/低点抬高改为加分)               |
//+------------------------------------------------------------------+
bool CheckMomentumLong(MqlRates &rates[], double sigEma0, double &psarBuf[],
                       double rsi0, double atrPercentile, double &score)
{
   int shift = 1; // 从已完成K线开始

   // A1: 最近2根已完成K线中至少1根收涨(放宽: 不要求连续2根阳线)
   bool anyBullish = (rates[shift].close > rates[shift].open ||
                      rates[shift+1].close > rates[shift+1].open);
   if(!anyBullish)
      return false;

   // A2: 前一根已完成K线收盘在EMA之上(趋势确认)
   if(!(rates[shift].close > sigEma0))
      return false;

   // A3: RSI强势 > 50 (放宽: 动量初期RSI可能刚从50附近上升)
   if(!(rsi0 > 50.0))
      return false;

   // A4: ATR波动率非极端(15%-90%)
   if(atrPercentile < 0.15 || atrPercentile > 0.90)
      return false;

   // 所有强制条件满足 → 评分
   score = 55.0; // 基础分(强制条件放宽, 基础分降低)

   // 加分: 连续2根阳线(强动量)
   if(rates[shift].close > rates[shift].open && rates[shift+1].close > rates[shift+1].open)
      score += 10;

   // 加分: 低点依次抬高(趋势健康)
   if(rates[shift+1].low < rates[shift].low)
      score += 8;

   // 加分: PSAR持续看涨 — 最近3根已完成K线收盘 > PSAR
   bool psarBullish = true;
   for(int i = 1; i <= 3; i++)
   {
      if(rates[i].close <= psarBuf[i])
      { psarBullish = false; break; }
   }
   if(psarBullish) score += 10;

   // 加分: RSI极强 > 60
   if(rsi0 > 60.0) score += 8;
   if(rsi0 > 70.0) score += 5; // 额外加分

   // 加分: 最近3根已完成K线平均成交量 > 过去20根均值×1.2
   long vol3 = rates[1].tick_volume + rates[2].tick_volume + rates[3].tick_volume;
   long vol20Avg = 0;
   MqlRates rates20[20];
   ArraySetAsSeries(rates20, true);
   if(CopyRates(_Symbol, SignalTF, 0, 20, rates20) >= 20)
   {
      for(int i = 0; i < 20; i++) vol20Avg += rates20[i].tick_volume;
      vol20Avg /= 20;
      if(vol3 / 3.0 > vol20Avg * 1.2) score += 8;
   }

   // 加分: 趋势强度(已完成K线低点抬高幅度 > 均值)
   double lowRise = rates[1].low - rates[2].low;
   if(lowRise > 0)
   {
      double avgLowRise = 0;
      int count = 0;
      for(int i = 1; i < 20; i++)
      {
         if(i+1 < 20 && rates[i+1].low > 0)
         {
            avgLowRise += MathAbs(rates[i].low - rates[i+1].low);
            count++;
         }
      }
      if(count > 0) avgLowRise /= count;
      if(lowRise > avgLowRise * 1.5) score += 5;
   }

   score = MathMin(score, 95.0);
   return true;
}

//+------------------------------------------------------------------+
//| 模式A: 动量突破入场(做空)                                        |
//| 条件: 趋势确认+EMA+RSI+ATR (PSAR/高点降低改为加分)               |
//+------------------------------------------------------------------+
bool CheckMomentumShort(MqlRates &rates[], double sigEma0, double &psarBuf[],
                        double rsi0, double atrPercentile, double &score)
{
   int shift = 1;

   // B1: 最近2根已完成K线中至少1根收跌(放宽)
   bool anyBearish = (rates[shift].close < rates[shift].open ||
                      rates[shift+1].close < rates[shift+1].open);
   if(!anyBearish)
      return false;

   // B2: 前一根已完成K线收盘在EMA之下(趋势确认)
   if(!(rates[shift].close < sigEma0))
      return false;

   // B3: RSI弱势 < 50 (放宽)
   if(!(rsi0 < 50.0))
      return false;

   // B4: ATR波动率非极端(15%-90%)
   if(atrPercentile < 0.15 || atrPercentile > 0.90)
      return false;

   score = 55.0;

   // 加分: 连续2根阴线(强动量)
   if(rates[shift].close < rates[shift].open && rates[shift+1].close < rates[shift+1].open)
      score += 10;

   // 加分: 高点依次降低(趋势健康)
   if(rates[shift+1].high > rates[shift].high)
      score += 8;

   // 加分: PSAR持续看跌 — 最近3根已完成K线收盘 < PSAR
   bool psarBearish = true;
   for(int i = 1; i <= 3; i++)
   {
      if(rates[i].close >= psarBuf[i])
      { psarBearish = false; break; }
   }
   if(psarBearish) score += 10;

   // 加分: RSI极弱 < 40
   if(rsi0 < 40.0) score += 8;
   if(rsi0 < 30.0) score += 5;

   // 加分: 最近3根已完成K线平均成交量 > 过去20根均值×1.2
   long vol3 = rates[1].tick_volume + rates[2].tick_volume + rates[3].tick_volume;
   long vol20Avg = 0;
   MqlRates rates20[20];
   ArraySetAsSeries(rates20, true);
   if(CopyRates(_Symbol, SignalTF, 0, 20, rates20) >= 20)
   {
      for(int i = 0; i < 20; i++) vol20Avg += rates20[i].tick_volume;
      vol20Avg /= 20;
      if(vol3 / 3.0 > vol20Avg * 1.2) score += 8;
   }

   // 加分: 趋势强度
   double highDrop = rates[shift+1].high - rates[shift].high;
   if(highDrop > 0)
   {
      double avgDrop = 0;
      int count = 0;
      for(int i = 1; i < 20; i++)
      {
         if(i+1 < 20 && rates[i+1].high > 0)
         {
            avgDrop += MathAbs(rates[i].high - rates[i+1].high);
            count++;
         }
      }
      if(count > 0) avgDrop /= count;
      if(highDrop > avgDrop * 1.5) score += 5;
   }

   score = MathMin(score, 95.0);
   return true;
}

//+------------------------------------------------------------------+
//| 模式A入口函数                                                     |
//+------------------------------------------------------------------+
int GetEntryMomentum(double &outScore)
{
   outScore = 0.0;

   MqlRates rates[20];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, 0, 20, rates) < 20) return 0;

   double sigEma[2];
   ArraySetAsSeries(sigEma, true);
   if(CopyBuffer(handle_Signal_RetestEMA, 0, 0, 2, sigEma) < 2) return 0;
   double sigEma0 = sigEma[1]; // 使用已完成K线对应的EMA(时序一致)
   if(sigEma0 <= 0.0) return 0;

   double psarBuf[5];
   ArraySetAsSeries(psarBuf, true);
   if(CopyBuffer(handle_PSAR, 0, 0, 5, psarBuf) < 5) return 0;

   double rsiData[1];
   ArraySetAsSeries(rsiData, true);
   if(CopyBuffer(handle_iRSI, 0, 0, 1, rsiData) < 1) return 0;
   double rsi0 = rsiData[0];

   double atrPercentile = GetATRPercentile();
   double testScore = 0.0;

   // 先检查H1趋势决定优先方向
   int h1Trend = GetH1Trend();
   // H1震荡时不做动量
   if(h1Trend == 0)
   {
      Print("[模式A] H1震荡，跳过动量入场");
      return 0;
   }

   // V6: 弱趋势时模式A不交易(弱趋势没有真正的动量)
   int trendQuality = GetTrendQuality();
   if(trendQuality < 2)
   {
      Print("[模式A] 趋势质量=", trendQuality, " (需=2强趋势), 跳过动量入场 斜率=", DoubleToString(GetH1Slope(), 4), "%");
      return 0;
   }

   if(h1Trend == 1)
   {
      if(CheckMomentumLong(rates, sigEma0, psarBuf, rsi0, atrPercentile, testScore))
      {
         outScore = testScore;
         m_trendDesc = "上升趋势(动量)";
         Print("[模式A] 做多信号! 评分=", testScore, " RSI=", StringFormat("%.1f", rsi0), " ATR%=", StringFormat("%.2f", atrPercentile), " EMA=", sigEma0);
         return 1;
      }
      else
      {
         Print("[模式A] 做多条件未满足: RSI=", StringFormat("%.1f", rsi0), " ATR%=", StringFormat("%.2f", atrPercentile), " close=", rates[1].close, " EMA=", sigEma0);
      }
   }
   else if(h1Trend == -1)
   {
      if(CheckMomentumShort(rates, sigEma0, psarBuf, rsi0, atrPercentile, testScore))
      {
         outScore = testScore;
         m_trendDesc = "下降趋势(动量)";
         Print("[模式A] 做空信号! 评分=", testScore, " RSI=", StringFormat("%.1f", rsi0), " ATR%=", StringFormat("%.2f", atrPercentile), " EMA=", sigEma0);
         return -1;
      }
      else
      {
         Print("[模式A] 做空条件未满足: RSI=", StringFormat("%.1f", rsi0), " ATR%=", StringFormat("%.2f", atrPercentile), " close=", rates[1].close, " EMA=", sigEma0);
      }
   }

   return 0;
}

//+------------------------------------------------------------------+
//| 模式B: EMA回调入场(做多检测)                                      |
//+------------------------------------------------------------------+
bool CheckRetracementLong(MqlRates &rates[], double sigEma0, double rsi1,
                          double atrVal, double &psarBuf[], double &score)
{
   int shift = 1; // 前一根已完成K线

   // C1: 前K线回踩EMA13附近 — 双向约束(低点在EMA±0.5ATR范围内)
   // 上限: low <= EMA + 0.5ATR (不能离EMA太远上方)
   // 下限: low >= EMA - 0.5ATR (不能跌破EMA太多, 否则不是回踩而是破位)
   if(!(rates[shift].low <= sigEma0 + atrVal * 0.5))
      return false;
   if(!(rates[shift].low >= sigEma0 - atrVal * 0.5))
      return false;

   // C2: 前K线弹回EMA上方(收盘>EMA, 确认支撑有效)
   if(!(rates[shift].close > sigEma0))
      return false;

   // C3: 前K线收涨(反弹确认)
   if(!(rates[shift].close > rates[shift].open))
      return false;

   // C4: PSAR在回调前支持做多(检查shift+1的PSAR方向, 非当前K线)
   // 回调前PSAR看涨 → 趋势仍在, 只是短暂回踩
   // 如果PSAR在回调K线上方(看跌), 反而说明是真正的回调买入机会
   // 所以只要求: 回调前1根(shift+2)的收盘>PSAR, 确认大趋势看涨
   if(!(rates[shift+2].close > psarBuf[shift+2]))
      return false;

   // RSI过滤: 40-65之间(回调中RSI不应太高, 也不应太低)
   if(!(rsi1 > 40.0 && rsi1 < 65.0))
      return false;

   // 所有强制条件满足 → 评分
   score = 60.0; // 基础分

   // 加分: K线反转形态(从强制改为加分, 大幅提升信号触发率)
   if(IsBullishReversalV3(shift))
      score += 15;

   // 加分: RSI在中性区(45-55) — 最佳回调位置
   if(rsi1 > 45.0 && rsi1 < 55.0) score += 10;

   // 加分: 低点非常接近EMA(在EMA±0.2ATR内) — 精准回踩
   if(rates[shift].low >= sigEma0 - atrVal * 0.2 && rates[shift].low <= sigEma0 + atrVal * 0.2)
      score += 10;

   // 加分: Tick成交量放大 > 近10根均值×1.1
   MqlRates rates10[11];
   ArraySetAsSeries(rates10, true);
   if(CopyRates(_Symbol, SignalTF, 0, 11, rates10) >= 11)
   {
      long avgVol = 0;
      for(int i = 1; i <= 10; i++) avgVol += rates10[i].tick_volume;
      avgVol /= 10;
      if(rates10[1].tick_volume > avgVol * 1.1) score += 10; // 使用已完成K线
   }

   // 加分: 影线拒绝(下影线 >= 实体 × 0.5)
   double prevBody  = MathAbs(rates[shift].close - rates[shift].open);
   double lowerShadow = MathMin(rates[shift].open, rates[shift].close) - rates[shift].low;
   if(prevBody > 0 && lowerShadow >= prevBody * 0.5) score += 5;

   // 加分: 复合形态(非简单锤子线)
   if(IsBullishEngulfing(shift) || IsMorningStar(shift) || IsPiercingLine(shift))
      score += 5;

   score = MathMin(score, 100.0);
   return true;
}

//+------------------------------------------------------------------+
//| 模式B: EMA回调入场(做空检测)                                      |
//+------------------------------------------------------------------+
bool CheckRetracementShort(MqlRates &rates[], double sigEma0, double rsi1,
                           double atrVal, double &psarBuf[], double &score)
{
   int shift = 1;

   // C1: 前K线反弹EMA13附近 — 双向约束(高点在EMA±0.5ATR范围内)
   if(!(rates[shift].high >= sigEma0 - atrVal * 0.5))
      return false;
   if(!(rates[shift].high <= sigEma0 + atrVal * 0.5))
      return false;

   // C2: 前K线受阻回落
   if(!(rates[shift].close < sigEma0))
      return false;

   // C3: 前K线收跌
   if(!(rates[shift].close < rates[shift].open))
      return false;

   // C4: PSAR在回调前支持做空(回调前1根收盘<PSAR)
   if(!(rates[shift+2].close < psarBuf[shift+2]))
      return false;

   // RSI过滤: 35-60之间
   if(!(rsi1 < 60.0 && rsi1 > 35.0))
      return false;

   score = 60.0;

   // 加分: K线反转形态(从强制改为加分)
   if(IsBearishReversalV3(shift))
      score += 15;

   // 加分: RSI在中性区(45-55)
   if(rsi1 < 55.0 && rsi1 > 45.0) score += 10;

   // 加分: 高点非常接近EMA(在EMA±0.2ATR内) — 精准受阻
   if(rates[shift].high >= sigEma0 - atrVal * 0.2 && rates[shift].high <= sigEma0 + atrVal * 0.2)
      score += 10;

   // 加分: Tick成交量放大
   MqlRates rates10[11];
   ArraySetAsSeries(rates10, true);
   if(CopyRates(_Symbol, SignalTF, 0, 11, rates10) >= 11)
   {
      long avgVol = 0;
      for(int i = 1; i <= 10; i++) avgVol += rates10[i].tick_volume;
      avgVol /= 10;
      if(rates10[1].tick_volume > avgVol * 1.1) score += 10; // 使用已完成K线
   }

   // 加分: 影线拒绝
   double prevBody  = MathAbs(rates[shift].close - rates[shift].open);
   double upperShadow = rates[shift].high - MathMax(rates[shift].open, rates[shift].close);
   if(prevBody > 0 && upperShadow >= prevBody * 0.5) score += 5;

   // 加分: 复合形态
   if(IsBearishEngulfing(shift) || IsEveningStar(shift) || IsDarkCloudCover(shift))
      score += 5;

   score = MathMin(score, 100.0);
   return true;
}

//+------------------------------------------------------------------+
//| 模式B入口函数                                                     |
//+------------------------------------------------------------------+
int GetEntryRetracement(double &outScore)
{
   outScore = 0.0;

   int h1Trend = GetH1Trend();
   if(h1Trend == 0)
   {
      Print("[模式B] H1震荡，跳过回调入场");
      return 0;
   }

   // V6: 弱趋势时限制模式B交易频率
   int trendQuality = GetTrendQuality();
   if(trendQuality <= 1 && MaxWeakTrendTrades > 0)
   {
      if(m_todayWeakTrendTrades >= MaxWeakTrendTrades)
      {
         Print("[模式B] 弱趋势(质量=", trendQuality, "), 今日已交易", m_todayWeakTrendTrades, "笔(上限", MaxWeakTrendTrades, "), 跳过");
         return 0;
      }
   }

   MqlRates rates[11];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, 0, 11, rates) < 11) return 0;

   double sigEma[4];
   ArraySetAsSeries(sigEma, true);
   if(CopyBuffer(handle_Signal_RetestEMA, 0, 0, 4, sigEma) < 4) return 0;
   double sigEma0 = sigEma[1]; // 使用已完成K线对应的EMA值(时序一致)
   if(sigEma0 <= 0.0) return 0;

   // 取前一根已完成K线的RSI (rates[1]对应RSI[1])
   double rsiData[2];
   ArraySetAsSeries(rsiData, true);
   if(CopyBuffer(handle_iRSI, 0, 0, 2, rsiData) < 2) return 0;

   // 获取ATR值(用于EMA近距检测)
   double atrVal = GetATRValue();
   if(atrVal <= 0.0) return 0;

   // 获取PSAR数据(用于回调前方向确认, 需要4根以访问shift+2=3)
   double psarBuf[4];
   ArraySetAsSeries(psarBuf, true);
   if(CopyBuffer(handle_PSAR, 0, 0, 4, psarBuf) < 4) return 0;

   double score = 0.0;

   if(h1Trend == 1)
   {
      if(CheckRetracementLong(rates, sigEma0, rsiData[1], atrVal, psarBuf, score))
      {
         outScore = score;
         m_trendDesc = "上升趋势(回调)";
         Print("[模式B] 做多回调信号! 评分=", score, " RSI=", StringFormat("%.1f", rsiData[1]), " ATR=", StringFormat("%.2f", atrVal), " EMA=", sigEma0, " low=", rates[1].low);
         return 1;
      }
      else
      {
         Print("[模式B] 做多回调条件未满足: RSI=", StringFormat("%.1f", rsiData[1]), " low=", rates[1].low, " EMA=", sigEma0, " ATR=", StringFormat("%.2f", atrVal));
      }
   }
   else if(h1Trend == -1)
   {
      if(CheckRetracementShort(rates, sigEma0, rsiData[1], atrVal, psarBuf, score))
      {
         outScore = score;
         m_trendDesc = "下降趋势(回调)";
         Print("[模式B] 做空回调信号! 评分=", score, " RSI=", StringFormat("%.1f", rsiData[1]), " ATR=", StringFormat("%.2f", atrVal), " EMA=", sigEma0, " high=", rates[1].high);
         return -1;
      }
      else
      {
         Print("[模式B] 做空回调条件未满足: RSI=", StringFormat("%.1f", rsiData[1]), " high=", rates[1].high, " EMA=", sigEma0, " ATR=", StringFormat("%.2f", atrVal));
      }
   }

   return 0;
}

//+------------------------------------------------------------------+
//| 获取ATR值                                                         |
//+------------------------------------------------------------------+
double GetATRValue()
{
   if(handle_ATR == INVALID_HANDLE) return 0.0;
   double atrBuf[];
   ArraySetAsSeries(atrBuf, true);
   if(CopyBuffer(handle_ATR, 0, 0, 1, atrBuf) <= 0) return 0.0;
   return atrBuf[0];
}

//+------------------------------------------------------------------+
//| 获取ATR百分位(近50根的30%-90%范围)                               |
//+------------------------------------------------------------------+
double GetATRPercentile()
{
   double atrVal = GetATRValue();
   if(atrVal <= 0.0) return 0.5; // 数据不足默认中间值

   double atrHistory[50];
   ArraySetAsSeries(atrHistory, true);
   int copied = CopyBuffer(handle_ATR, 0, 0, 50, atrHistory);
   if(copied < 20) return 0.5;

   double atrMin = atrHistory[0], atrMax = atrHistory[0];
   for(int i = 0; i < copied; i++)
   {
      if(atrHistory[i] < atrMin) atrMin = atrHistory[i];
      if(atrHistory[i] > atrMax) atrMax = atrHistory[i];
   }

   if(atrMax - atrMin <= 0.0) return 0.5;
   return (atrVal - atrMin) / (atrMax - atrMin);
}

//+------------------------------------------------------------------+
//| 计算平均实体大小                                                  |
//+------------------------------------------------------------------+
double GetAvgBody(int nBars)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(_Symbol, SignalTF, 0, nBars, rates);
   if(copied < nBars) return 0.0;

   double sum = 0.0;
   for(int i = 0; i < nBars; i++)
      sum += MathAbs(rates[i].close - rates[i].open);
   return sum / nBars;
}

//+------------------------------------------------------------------+
//| 仓位计算: 风险优先模型                                            |
//+------------------------------------------------------------------+
double GetLotSize(double signalScore, double slDist, double atrPercentile)
{
   // === 风险优先仓位模型 ===
   // 根据信号评分确定风险金额
   double riskUSD = RiskUSD_Medium; // 默认中等
   if(signalScore < 60.0)
      riskUSD = RiskUSD_Low;
   else if(signalScore >= 80.0)
      riskUSD = RiskUSD_High;

   // 美分账户放大
   if(m_isCent) riskUSD *= 100.0;

   // 根据SL距离计算手数
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);

   double lot = 0.0;
   if(tickValue > 0.0 && tickSize > 0.0 && slDist > 0.0)
   {
      // 每手风险 = tickValue × (SL距离 / tickSize)
      double riskPerLot = tickValue * (slDist / tickSize);
      if(riskPerLot > 0.0)
         lot = riskUSD / riskPerLot;
   }

   // 回退: 如果计算失败, 使用BaseLot_Max
   if(lot <= 0.0)
      lot = BaseLot_Max;

   // 限制在配置范围
   lot = MathMax(BaseLot_Min, MathMin(BaseLot_Max, lot));

   // 规范化
   double step  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double vmin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);

   lot = MathFloor(lot / step) * step;
   lot = MathMax(vmin, MathMin(vmax, lot));
   lot = MathMax(lot, BaseLot_Min);

   // 保证金安全校验
   MqlTick marginTick;
   double marginRequired = 0.0;
   if(SymbolInfoTick(_Symbol, marginTick))
   {
      double askPrice = marginTick.ask;
      double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      if(OrderCalcMargin(ORDER_TYPE_BUY, _Symbol, lot, askPrice, marginRequired) && marginRequired > 0.0)
      {
         double maxLotByMargin = lot * (freeMargin / marginRequired) * 0.9;
         if(maxLotByMargin < lot)
         {
            lot = MathFloor(maxLotByMargin / step) * step;
            lot = MathMax(lot, vmin);
         }
      }
   }

   lot = NormalizeDouble(lot, 2);
   return lot;
}

//+------------------------------------------------------------------+
//| 滑点重试开仓                                                     |
//+------------------------------------------------------------------+
bool OpenOrderWithRetry(int signal, double lot, double sl, double tp, string comment)
{
   for(int retry = 0; retry < MaxSlippageRetries; retry++)
   {
      bool result = false;
      if(signal == 1)
         result = trade.Buy(lot, _Symbol, 0, sl, tp, comment);
      else if(signal == -1)
         result = trade.Sell(lot, _Symbol, 0, sl, tp, comment);

      if(result && trade.ResultRetcode() == TRADE_RETCODE_DONE)
         return true;

      int retcode = trade.ResultRetcode();
      if(retcode == TRADE_RETCODE_REJECT || retcode == TRADE_RETCODE_TIMEOUT)
      {
         if(retry < MaxSlippageRetries - 1)
         {
            Sleep(100);
            continue;
         }
      }
      break;
   }
   return false;
}

//+------------------------------------------------------------------+
//| 保本损检查(含点差缓冲)                                            |
//+------------------------------------------------------------------+
void CheckBreakEven(ulong ticket, double breakEvenPercent, double spreadBuffer)
{
   CPositionInfo pos;
   if(!pos.SelectByTicket(ticket)) return;

   int type = (int)pos.Type();
   double openPrice = pos.PriceOpen();
   double currentSL = pos.StopLoss();
   double tp = pos.TakeProfit();
   if(tp <= 0.0) return;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   double progress = 0.0;
   double distanceTotal = 0.0;
   double breakEvenPrice = openPrice;

   if(type == POSITION_TYPE_BUY)
   {
      distanceTotal = tp - openPrice;
      if(distanceTotal <= 0.0) return;
      progress = (tick.bid - openPrice) / distanceTotal;
      // 保本价 = 开仓价 + 点差缓冲(因为平仓用Bid)
      breakEvenPrice = openPrice + spreadBuffer * _Point;
   }
   else if(type == POSITION_TYPE_SELL)
   {
      distanceTotal = openPrice - tp;
      if(distanceTotal <= 0.0) return;
      progress = (openPrice - tick.ask) / distanceTotal;
      // 保本价 = 开仓价 - 点差缓冲(因为平仓用Ask)
      breakEvenPrice = openPrice - spreadBuffer * _Point;
   }
   else return;

   if(progress >= breakEvenPercent / 100.0)
   {
      if((type == POSITION_TYPE_BUY && currentSL < breakEvenPrice) ||
         (type == POSITION_TYPE_SELL && (currentSL > breakEvenPrice || currentSL == 0.0)))
      {
         if(trade.PositionModify(ticket, breakEvenPrice, tp))
            Print("[保本] 已触发，进度：", StringFormat("%.0f%%", progress * 100.0),
                  " 保本价：", breakEvenPrice,
                  " 模式：", m_entryIsMomentum ? "A" : "B");
         else
         {
            int err = GetLastError();
            if(err == TRADE_RETCODE_REQUOTE || err == TRADE_RETCODE_TIMEOUT)
            {
               Sleep(50);
               trade.PositionModify(ticket, breakEvenPrice, tp);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 单笔最大亏损检查                                                  |
//+------------------------------------------------------------------+
void CheckMaxLoss(ulong ticket)
{
   CPositionInfo pos;
   if(!pos.SelectByTicket(ticket)) return;

   if(MaxLossPerTrade <= 0.0) return;
   double profit = pos.Profit();
   double maxLoss = MaxLossPerTrade * (m_isCent ? 100.0 : 1.0);

   if(profit <= -maxLoss)
   {
      if(trade.PositionClose(ticket))
         Print("单笔最大亏损触发：", profit, " (上限：", -maxLoss, ")");
      else
         Print("单笔止损平仓失败，错误码：", GetLastError());
   }
}

//+------------------------------------------------------------------+
//| 追踪止损检查(模式A)                                               |
//+------------------------------------------------------------------+
void CheckTrailingStop(ulong ticket)
{
   CPositionInfo pos;
   if(!pos.SelectByTicket(ticket)) return;

   int type = (int)pos.Type();
   double profit = pos.Profit();

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   // 更新最高浮动盈利(点数)
   double points = 0.0;
   if(type == POSITION_TYPE_BUY)
   {
      points = (tick.bid - pos.PriceOpen()) / (_Point * g_pointMultiplier);
      if(tick.bid > m_highestPrice) m_highestPrice = tick.bid;
   }
   else
   {
      points = (pos.PriceOpen() - tick.ask) / (_Point * g_pointMultiplier);
      if(m_lowestPrice == 0.0 || tick.ask < m_lowestPrice) m_lowestPrice = tick.ask;
   }

   if(points > m_maxProfitPoints) m_maxProfitPoints = points;

   // 检查是否达到追踪启动条件
   if(!m_trailActivated && m_maxProfitPoints >= m_openATRPoints * TrailingATR_Multiple)
   {
      m_trailActivated = true;
      // 启动时设置初始追踪线
      if(type == POSITION_TYPE_BUY)
         m_trailLevel = m_highestPrice - TrailingPullback * m_openATRValue;
      else
         m_trailLevel = m_lowestPrice + TrailingPullback * m_openATRValue;
      Print("[追踪] 止损已激活，ATR倍数：", TrailingATR_Multiple,
            " 回撤：", TrailingPullback, " 追踪线：", m_trailLevel,
            " 模式：", m_entryIsMomentum ? "A" : "B");
   }

   // 追踪线持续更新(只向有利方向移动)
   if(m_trailActivated)
   {
      if(type == POSITION_TYPE_BUY)
      {
         double newLevel = m_highestPrice - TrailingPullback * m_openATRValue;
         if(newLevel > m_trailLevel)
            m_trailLevel = newLevel;

         if(tick.bid <= m_trailLevel)
         {
            if(trade.PositionClose(ticket))
               Print("[追踪平仓] 做多 最高盈利：", m_maxProfitPoints, "pt 追踪线：", m_trailLevel,
                     " 盈亏：", StringFormat("%+.2f", profit));
         }
      }
      else
      {
         double newLevel = m_lowestPrice + TrailingPullback * m_openATRValue;
         if(newLevel < m_trailLevel || m_trailLevel == 0.0)
            m_trailLevel = newLevel;

         if(tick.ask >= m_trailLevel)
         {
            if(trade.PositionClose(ticket))
               Print("[追踪平仓] 做空 最高盈利：", m_maxProfitPoints, "pt 追踪线：", m_trailLevel,
                     " 盈亏：", StringFormat("%+.2f", profit));
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 重置追踪止损状态                                                  |
//+------------------------------------------------------------------+
void ResetTrailingState()
{
   m_trailLevel = 0.0;
   m_maxProfitPoints = 0.0;
   m_highestPrice = 0.0;
   m_lowestPrice = 0.0;
   m_openATRValue = 0.0;
   m_openATRPoints = 0.0;
   m_trailActivated = false;
}

//+------------------------------------------------------------------+
//| 主交易逻辑                                                       |
//+------------------------------------------------------------------+
void OnTick()
{
   // 获取市场数据(用于整个函数)
   MqlTick tick;
   SymbolInfoTick(_Symbol, tick);

   //--- 交易限制检查
   bool timeOK = !EnableTradingTime || IsWithinTradingHours();
   bool dayOK  = !EnableDayFilter || IsTradingDayAllowed();
   bool newsOK = !NewsFilterOn || !IsUpcomingNews();

   ENUM_RESTRICTION_REASON currentReason = NO_RESTRICTION;
   if(!timeOK && !dayOK && !newsOK)       currentReason = ALL_RESTRICTIONS;
   else if(!timeOK && !dayOK)              currentReason = TIME_DAY_RESTRICTION;
   else if(!timeOK && !newsOK)             currentReason = TIME_NEWS_RESTRICTION;
   else if(!dayOK && !newsOK)              currentReason = DAY_NEWS_RESTRICTION;
   else if(!timeOK)                        currentReason = TIME_RESTRICTION;
   else if(!dayOK)                         currentReason = DAY_RESTRICTION;
   else if(!newsOK)                        currentReason = NEWS_RESTRICTION;

   if(currentReason != NO_RESTRICTION)
   {
      if(currentReason != LastRestrictionReason)
      {
         ShowTradingHourAlert(GetRestrictionMessage(currentReason));
         LastRestrictionReason = currentReason;
      }
      return;
   }
   else if(LastRestrictionReason != NO_RESTRICTION)
   {
      ShowTradingHourAlert("");
      LastRestrictionReason = NO_RESTRICTION;
   }

   //--- 日期检查与每日重置
   datetime serverTime = TimeCurrent();
   string todayStr = TimeToString(serverTime, TIME_DATE);
   if(m_currentDate != todayStr)
   {
      if(m_currentDate != "")
         Print("[每日重置] 昨日: ", m_todayTrades, "笔 盈亏=", StringFormat("%.2f", m_todayProfit), " 最大浮亏=", StringFormat("%.2f", m_todayMaxFloating));
      m_currentDate = todayStr;
      m_todayTrades = 0;
      m_todayProfit = 0.0;
      m_todayMaxFloating = 0.0;
      m_todayWeakTrendTrades = 0;  // V6: 重置弱趋势计数
      m_todayRangeTrades    = 0;  // V6: 重置震荡计数
      m_consecutiveLossesV6 = 0;  // V6: 重置连败
      m_dailyStopTriggered  = false; // V6: 重置日停止标志
      Print("[每日重置] 新的一天：", todayStr);
   }

   //--- 持仓管理
   bool hasPos = false;
   CPositionInfo posInfo;

   if(m_lastTicket > 0)
   {
      hasPos = PositionSelectByTicket(m_lastTicket);
      if(hasPos)
      {
         if(posInfo.SelectByTicket(m_lastTicket))
         {
            if(posInfo.Symbol() != _Symbol || posInfo.Magic() != MagicNumber)
               hasPos = false;
         }
      }
   }

   // 平仓检测
   if(m_lastTicket > 0 && !hasPos)
   {
      if(HistorySelect(0, TimeCurrent() + 3600))
      {
         int total = HistoryDealsTotal();
         if(total > 0)
         {
            ulong dealTicket = HistoryDealGetTicket(total - 1);
            if(dealTicket > 0 && dealTicket != m_lastDealTicket)
            {
               ulong dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
               string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
               long dealEntry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);

               if(dealMagic == MagicNumber && dealSymbol == _Symbol
                  && (int)dealEntry == DEAL_ENTRY_OUT)
               {
                  double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
                  double lots = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);

                  m_lastDealTicket = dealTicket;
                  m_lastClosedPL = profit;
                  m_lastClosedLots = lots;

                  m_todayTrades++;
                  m_todayProfit += profit;

                  // V6: 追踪连续亏损
                  if(profit < 0) m_consecutiveLossesV6++;
                  else m_consecutiveLossesV6 = 0;

                  string closeMode = m_entryIsMomentum ? "动量A" : "回调B";
                  Print("[平仓] 盈亏：", StringFormat("%+.2f", profit), " 手数：", lots,
                        " 模式：", closeMode, " 连败:", m_consecutiveLossesV6,
                        " | 今日统计：", m_todayTrades, "笔/累计盈亏：", StringFormat("%.2f", m_todayProfit));
               }
            }
         }
      }

      m_lastTicket = 0;
      m_lastPositionID = 0;
      m_entryIsMomentum = false;
      ResetTrailingState();
   }

   // 有持仓 → 管理止损
   if(hasPos)
   {
      if(posInfo.SelectByTicket(m_lastTicket > 0 ? m_lastTicket : 0))
      {
         double fl = posInfo.Profit();
         if(fl < m_todayMaxFloating)
            m_todayMaxFloating = fl;

         m_lastTicket = posInfo.Ticket();
         m_lastPositionID = (ulong)PositionGetInteger(POSITION_IDENTIFIER);

         // 日内总亏损(V6: 使用DailyMaxLossV6)
         double totalDayLoss = m_todayProfit + posInfo.Profit();
         double lossLimit = (DailyMaxLossV6 > 0) ? DailyMaxLossV6 : DailyMaxLoss;
         if(lossLimit > 0 && totalDayLoss <= -lossLimit)
         {
            Print("[风控V6] 日内亏损已达上限$", lossLimit, " 当前", DoubleToString(totalDayLoss, 2), " 强制全平");
            m_dailyStopTriggered = true;
            trade.PositionClose(m_lastTicket);
            return;
         }

         // V6: 日内盈利目标
         if(DailyProfitTarget > 0 && totalDayLoss >= DailyProfitTarget)
         {
            Print("[风控V6] 日内盈利已达目标$", DailyProfitTarget, " 当前", DoubleToString(totalDayLoss, 2), " 锁利平仓");
            m_dailyStopTriggered = true;
            trade.PositionClose(m_lastTicket);
            return;
         }

         // 判断持仓属于哪个模式(通过开仓ATR追踪状态判断)
         bool isMomentumMode = m_entryIsMomentum;

         // 保本损
         double bePercent = BreakEvenPercent_A; // 默认模式A
         if(!isMomentumMode) bePercent = BreakEvenPercent_B;

         if(bePercent > 0.0)
         {
            // 点差缓冲 = 2倍当前点差
            double sp = (tick.ask - tick.bid) / _Point;
            if(sp <= 0) sp = 2.0;
            CheckBreakEven(m_lastTicket, bePercent, MathMax(sp, 1.0) * 2.0);
         }

         // 单笔最大亏损
         if(MaxLossPerTrade > 0.0)
            CheckMaxLoss(m_lastTicket);

         // 模式A追踪止损
         if(m_entryIsMomentum)
            CheckTrailingStop(m_lastTicket);
      }

      return; // 一单一结
   }

   //--- 新K线检测(防闪烁: 仅在新K线开盘时检查信号)
   int currentBars = Bars(_Symbol, SignalTF);
   if(currentBars == m_prevBars)
      return; // 同一根K线内, 不检查信号
   m_prevBars = currentBars;

   //--- 新K线日志(每根新K线只打印一次)
   Print("[新K线] Bar#", currentBars, " 时间=", TimeToString(TimeCurrent()), " H1趋势=", GetH1Trend());

   //--- 更新环形缓冲区
   MqlTick ringTick;
   if(SymbolInfoTick(_Symbol, ringTick))
      UpdateDataWithRingBuffer(ringTick.ask, ringTick.bid);

   //--- 点差检查
   if(!SymbolInfoTick(_Symbol, tick))
   {
      Print("获取Tick失败，错误码：", GetLastError());
      return;
   }
   double spread = (tick.ask - tick.bid) / _Point;
   if(spread > MaxSpread)
   {
      Print("[过滤] 点差过大: ", StringFormat("%.0f", spread), " > 阈值 ", MaxSpread);
      return;
   }

   //--- V6: 日停止标志(亏损上限/盈利目标触发后当天不再交易)
   if(m_dailyStopTriggered)
   {
      // 只在每天第一根K线打印一次
      static int lastStopBar = -1;
      if(currentBars != lastStopBar)
      {
         Print("[风控V6] 今日已触发停止, 暂停交易");
         lastStopBar = currentBars;
      }
      return;
   }

   //--- 每日风控
   if(DailyMaxTrades > 0 && m_todayTrades >= DailyMaxTrades)
   {
      Print("[风控] 今日交易次数已达上限: ", m_todayTrades, "/", DailyMaxTrades);
      return;
   }
   double lossLimit = (DailyMaxLossV6 > 0) ? DailyMaxLossV6 : DailyMaxLoss;
   if(lossLimit > 0 && m_todayProfit <= -lossLimit)
   {
      Print("[风控V6] 今日亏损已达上限$", lossLimit, " 累计:", StringFormat("%.2f", m_todayProfit));
      m_dailyStopTriggered = true;
      return;
   }
   if(DailyProfitTarget > 0 && m_todayProfit >= DailyProfitTarget)
   {
      Print("[风控V6] 今日盈利已达目标$", DailyProfitTarget, " 累计:", StringFormat("%.2f", m_todayProfit));
      m_dailyStopTriggered = true;
      return;
   }

   //--- V6: 连续亏损检查
   if(MaxConsecutiveLossesV6 > 0 && m_consecutiveLossesV6 >= MaxConsecutiveLossesV6)
   {
      Print("[风控V6] 连续亏损", m_consecutiveLossesV6, "笔(上限", MaxConsecutiveLossesV6, "), 今日暂停");
      m_dailyStopTriggered = true;
      return;
   }

   //--- 信号频率控制(跨模式, 从开仓K线索引)
   if(MinBarsBetweenSignals > 0 && m_lastOpenBarIndex >= 0)
   {
      if(currentBars - m_lastOpenBarIndex < MinBarsBetweenSignals)
      {
         Print("[过滤] 信号间隔不足: 距上次开仓仅 ", currentBars - m_lastOpenBarIndex, " 根K线(需>=", MinBarsBetweenSignals, ")");
         return;
      }
   }

   //--- V6: 检测市场环境(趋势 vs 震荡)
   ENUM_MARKET_REGIME regime = GetMarketRegime();
   m_lastRegime = regime;

   double adxBuf[1];
   ArraySetAsSeries(adxBuf, true);
   double adxVal = (CopyBuffer(handle_ADX, 0, 0, 1, adxBuf) > 0) ? adxBuf[0] : 0.0;

   Print("[信号] 市场环境: ", (regime == REGIME_TRENDING ? "趋势" : "震荡"),
         " ADX=", DoubleToString(adxVal, 1),
         " H1趋势=", GetH1Trend(), " 趋势质量=", GetTrendQuality(),
         " H1斜率=", DoubleToString(GetH1Slope(), 4), "%");

   //--- 信号检测
   double score = 0.0;
   int signal = 0;
   bool isRangeTrade = false; // 标记是否为震荡交易

   if(regime == REGIME_TRENDING)
   {
      // ===== 趋势市场: 沿用模式A/模式B =====
      m_currentState = CheckMarketState() ? STATE_MOMENTUM : STATE_RETRACEMENT;
      ENUM_MARKET_STATE originalState = m_currentState;

      if(m_currentState == STATE_MOMENTUM)
      {
         signal = GetEntryMomentum(score);
         if(signal != 0)
            Print("[信号] 趋势-模式A触发: 方向=", (signal==1?"做多":"做空"), " 评分=", score);
      }

      if(signal == 0)
      {
         m_currentState = STATE_RETRACEMENT;
         signal = GetEntryRetracement(score);
         if(signal != 0)
            Print("[信号] 趋势-模式B触发: 方向=", (signal==1?"做多":"做空"), " 评分=", score);
      }
   }
   else
   {
      // ===== 震荡市场: 均值回归模式 =====
      // 震荡日交易上限
      if(Range_MaxTrades > 0 && m_todayRangeTrades >= Range_MaxTrades)
      {
         Print("[震荡] 今日震荡交易已达上限: ", m_todayRangeTrades, "/", Range_MaxTrades);
      }
      else
      {
         signal = CheckRangeTrade(score);
         if(signal != 0)
         {
            isRangeTrade = true;
            Print("[信号] 震荡-均值回归触发: 方向=", (signal==1?"做多":"做空"), " 评分=", score);
         }
      }
   }

   if(signal == 0)
   {
      Print("[信号] 本K线无有效信号");
      return;
   }

   //--- 开仓执行
   double atrVal = GetATRValue();
   if(atrVal <= 0.0)
   {
      Print("ATR值为0，跳过开仓");
      return;
   }

   double atrPercentile = GetATRPercentile();

   // SL/TP: 趋势模式沿用原逻辑, 震荡模式用区间参数
   double slMultiplier, rrRatio, slDist, tpDist;
   string modeStr;

   if(isRangeTrade)
   {
      // 震荡模式: 紧止损 + 区间中点止盈
      slMultiplier = 1.2;
      slDist = MathMax(atrVal * slMultiplier, MinSL_Points * g_pointMultiplier * _Point);

      double rangeHigh, rangeLow, rangeMid;
      FindSwingLevels(rangeHigh, rangeLow, rangeMid);
      MqlTick tt;
      SymbolInfoTick(_Symbol, tt);
      double midPx = (tt.bid + tt.ask) / 2.0;

      if(signal == 1)
         tpDist = MathMax(rangeMid - midPx, slDist * 0.8); // 至少0.8R
      else
         tpDist = MathMax(midPx - rangeMid, slDist * 0.8);

      rrRatio = (slDist > 0) ? tpDist / slDist : 1.0;
      modeStr = "震荡回归";
   }
   else
   {
      // 趋势模式: 原逻辑
      ENUM_MARKET_STATE originalState = (m_currentState == STATE_MOMENTUM) ? STATE_MOMENTUM : STATE_RETRACEMENT;
      slMultiplier = (originalState == STATE_MOMENTUM) ? ATR_SL_Multiplier_A : ATR_SL_Multiplier_B;
      rrRatio = (originalState == STATE_MOMENTUM) ? RiskRewardRatio_A : RiskRewardRatio_B;
      slDist = MathMax(atrVal * slMultiplier, MinSL_Points * g_pointMultiplier * _Point);
      tpDist = slDist * rrRatio;
      modeStr = (originalState == STATE_MOMENTUM) ? "动量A" : "回调B";
   }

   long stopsLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = stopsLevel * _Point;
   slDist = MathMax(slDist, minDist);
   tpDist = MathMax(tpDist, minDist);

   double entryPrice = 0.0, sl = 0.0, tp = 0.0;
   if(signal == 1)
   {
      entryPrice = tick.ask;
      sl = entryPrice - slDist;
      tp = entryPrice + tpDist;
   }
   else if(signal == -1)
   {
      entryPrice = tick.bid;
      sl = entryPrice + slDist;
      tp = entryPrice - tpDist;
   }

   if(MathAbs(entryPrice - sl) < minDist || MathAbs(tp - entryPrice) < minDist)
   {
      Print("止损止盈距离小于平台最小要求(", stopsLevel, "点)，跳过开仓");
      return;
   }

   // V6: 净值百分比风险模型
   double lot;
   if(UseEquityRisk)
   {
      double equity = AccountInfoDouble(ACCOUNT_EQUITY);
      if(equity <= 0) equity = AccountInfoDouble(ACCOUNT_BALANCE);
      double riskAmount = equity * RiskPercentPerTrade / 100.0;
      if(m_isCent) riskAmount *= 100.0;

      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tickValue > 0 && tickSize > 0 && slDist > 0)
      {
         double riskPerLot = tickValue * (slDist / tickSize);
         if(riskPerLot > 0) lot = riskAmount / riskPerLot;
         else lot = BaseLot_Min;
      }
      else lot = BaseLot_Min;

      lot = MathMax(BaseLot_Min, MathMin(BaseLot_Max, lot));
      double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
      lot = MathFloor(lot / step) * step;
      lot = MathMax(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), lot);
      lot = NormalizeDouble(lot, 2);
   }
   else
   {
      // 传统风险优先手数
      lot = GetLotSize(score, slDist, atrPercentile);
   }

   // 震荡模式用更低风险
   if(isRangeTrade)
   {
      lot *= Range_RiskMult;
      lot = MathMax(BaseLot_Min, lot);
   }

   bool opened = OpenOrderWithRetry(signal, lot, sl, tp, "GSSV6_" + modeStr);

   if(opened)
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         CPositionInfo pi;
         if(pi.SelectByIndex(i))
         {
            if(pi.Symbol() == _Symbol && pi.Magic() == MagicNumber)
            {
               m_lastTicket = pi.Ticket();
               m_lastPositionID = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
               break;
            }
         }
      }

      m_lastOpenBarIndex = currentBars;
      ResetTrailingState();
      m_entryIsMomentum = (!isRangeTrade && m_currentState == STATE_MOMENTUM);
      m_openATRValue = atrVal;
      m_openATRPoints = atrVal / (_Point * g_pointMultiplier);
      if(signal == 1) m_highestPrice = entryPrice;
      else m_lowestPrice = entryPrice;

      m_lastSignalScore = (int)score;
      m_lastSignalDir = (signal == 1) ? "做多" : "做空";

      // V6: 计数
      if(isRangeTrade) m_todayRangeTrades++;
      int tq = GetTrendQuality();
      if(!isRangeTrade && tq <= 1) m_todayWeakTrendTrades++;

      string dirStr = (signal == 1) ? "BUY" : "SELL";
      Print("[开仓成功] ", dirStr, " [", modeStr, "] 环境=", (regime==REGIME_TRENDING?"趋势":"震荡"),
            " ADX=", DoubleToString(adxVal, 1), " 手数：", lot,
            " 入场：", entryPrice, " 止损：", sl, " 止盈：", tp,
            " R:R 1:", StringFormat("%.1f", rrRatio),
            " 评分：", score, " | ", m_trendDesc);
   }
   else
   {
      Print("[开仓失败] 重试", MaxSlippageRetries, "次, 返回码：", trade.ResultRetcode(),
            " 描述：", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| 辅助函数: 获取当前评分的风险金额                                  |
//+------------------------------------------------------------------+


//+------------------------------------------------------------------+
//| V3反转形态检测函数 — 完全复用                                    |
//+------------------------------------------------------------------+
bool IsBullishReversalV3(int shift)
{
   if(IsHammer(shift))      return true;
   if(IsBullishEngulfing(shift)) return true;
   if(IsMorningStar(shift)) return true;
   if(IsPiercingLine(shift)) return true;
   return false;
}

bool IsBearishReversalV3(int shift)
{
   if(IsHangingMan(shift))   return true;
   if(IsBearishEngulfing(shift)) return true;
   if(IsEveningStar(shift))  return true;
   if(IsDarkCloudCover(shift)) return true;
   return false;
}

bool IsHammer(int shift)
{
   MqlRates rates[2];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 2, rates) < 2) return false;

   double body0  = MathAbs(rates[0].close - rates[0].open);
   double upper0 = rates[0].high - MathMax(rates[0].open, rates[0].close);
   double lower0 = MathMin(rates[0].open, rates[0].close) - rates[0].low;

   return (body0 > 0 && lower0 >= body0 * Hammer_ShadowRatio && upper0 < body0 * Hammer_UpperRatio);
}

bool IsHangingMan(int shift)
{
   MqlRates rates[2];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 2, rates) < 2) return false;

   double body0  = MathAbs(rates[0].close - rates[0].open);
   double upper0 = rates[0].high - MathMax(rates[0].open, rates[0].close);
   double lower0 = MathMin(rates[0].open, rates[0].close) - rates[0].low;

   return (body0 > 0 && upper0 >= body0 * Hammer_ShadowRatio && lower0 < body0 * Hammer_UpperRatio);
}

bool IsBullishEngulfing(int shift)
{
   MqlRates rates[2];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 2, rates) < 2) return false;

   return (rates[1].close < rates[1].open && rates[0].close > rates[0].open
           && rates[0].close > rates[1].open && rates[0].open < rates[1].close);
}

bool IsBearishEngulfing(int shift)
{
   MqlRates rates[2];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 2, rates) < 2) return false;

   return (rates[1].close > rates[1].open && rates[0].close < rates[0].open
           && rates[0].close < rates[1].open && rates[0].open > rates[1].close);
}

bool IsMorningStar(int shift)
{
   MqlRates rates[3];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 3, rates) < 3) return false;

   double body0 = MathAbs(rates[0].close - rates[0].open);
   double body1 = MathAbs(rates[1].close - rates[1].open);
   double body2 = MathAbs(rates[2].close - rates[2].open);

   double avgBody = GetAvgBody(20);
   if(avgBody <= 0.0) return false;
   bool largeCandle2 = (body2 > avgBody * LargeBodyRatio);
   bool smallCandle1 = (body1 < avgBody * SmallBodyRatio);

   if(rates[2].close < rates[2].open && largeCandle2)
   {
      double mid2 = (rates[2].open + rates[2].close) / 2.0;
      if(smallCandle1)
      {
         if(rates[0].close > rates[0].open && rates[0].close > mid2)
            return true;
      }
   }
   return false;
}

bool IsEveningStar(int shift)
{
   MqlRates rates[3];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 3, rates) < 3) return false;

   double body0 = MathAbs(rates[0].close - rates[0].open);
   double body1 = MathAbs(rates[1].close - rates[1].open);
   double body2 = MathAbs(rates[2].close - rates[2].open);

   double avgBody = GetAvgBody(20);
   if(avgBody <= 0.0) return false;
   bool largeCandle2 = (body2 > avgBody * LargeBodyRatio);
   bool smallCandle1 = (body1 < avgBody * SmallBodyRatio);

   if(rates[2].close > rates[2].open && largeCandle2)
   {
      double mid2 = (rates[2].open + rates[2].close) / 2.0;
      if(smallCandle1)
      {
         if(rates[0].close < rates[0].open && rates[0].close < mid2)
            return true;
      }
   }
   return false;
}

bool IsPiercingLine(int shift)
{
   MqlRates rates[2];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 2, rates) < 2) return false;

   double mid1 = (rates[1].open + rates[1].close) / 2.0;
   return (rates[1].close < rates[1].open && rates[0].close > rates[0].open
           && rates[0].close > mid1 && rates[0].open <= rates[1].close);
}

bool IsDarkCloudCover(int shift)
{
   MqlRates rates[2];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, SignalTF, shift, 2, rates) < 2) return false;

   double mid1 = (rates[1].open + rates[1].close) / 2.0;
   return (rates[1].close > rates[1].open && rates[0].close < rates[0].open
           && rates[0].close < mid1 && rates[0].open >= rates[1].close);
}

//+------------------------------------------------------------------+
//| 面板函数(缩放适配)                                               |
//+------------------------------------------------------------------+
void CreatePanel()
{
   long chartWidth = ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
   long chartHeight = ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS);
   if(chartWidth <= 0) chartWidth = 800;
   if(chartHeight <= 0) chartHeight = 600;

   int panelWidth = (int)(chartWidth * 0.13);
   panelWidth = MathMax(160, MathMin(220, panelWidth));
   int panelHeight = 260;

   int xPos = 12;
   int yPos = 22;
   int labelX = xPos + 5;
   int fontSize = 9;

   string bgName = PanelPrefix + "bg";
   ObjectCreate(0, bgName, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, bgName, OBJPROP_XDISTANCE, xPos);
   ObjectSetInteger(0, bgName, OBJPROP_YDISTANCE, yPos);
   ObjectSetInteger(0, bgName, OBJPROP_XSIZE, panelWidth);
   ObjectSetInteger(0, bgName, OBJPROP_YSIZE, panelHeight);
   ObjectSetInteger(0, bgName, OBJPROP_BGCOLOR, C'20,20,20');
   ObjectSetInteger(0, bgName, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, bgName, OBJPROP_COLOR, C'60,60,60');
   ObjectSetInteger(0, bgName, OBJPROP_BACK, false);
   ObjectSetInteger(0, bgName, OBJPROP_FILL, true);
   ObjectSetInteger(0, bgName, OBJPROP_WIDTH, 1);

   int yOffset = yPos + 8;
   int lineHeight = 14;

   ObjectCreate(0, PanelPrefix + "title", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, PanelPrefix + "title", OBJPROP_XDISTANCE, labelX);
   ObjectSetInteger(0, PanelPrefix + "title", OBJPROP_YDISTANCE, yOffset);
   ObjectSetString(0, PanelPrefix + "title", OBJPROP_TEXT, "源流一单一结 V4");
   ObjectSetString(0, PanelPrefix + "title", OBJPROP_FONT, "Arial");
   ObjectSetInteger(0, PanelPrefix + "title", OBJPROP_FONTSIZE, 10);
   ObjectSetInteger(0, PanelPrefix + "title", OBJPROP_COLOR, clrLightGreen);
   ObjectSetInteger(0, PanelPrefix + "title", OBJPROP_BACK, false);

   string labels[] = {"time", "trades", "profit", "trend", "mode", "rsi", "spread", "signal", "maxloss", "lotinfo"};
   int labelCount = ArraySize(labels);

   for(int i = 0; i < labelCount; i++)
   {
      string objName = PanelPrefix + labels[i];
      ObjectCreate(0, objName, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, objName, OBJPROP_XDISTANCE, labelX);
      ObjectSetInteger(0, objName, OBJPROP_YDISTANCE, yOffset + (i + 1) * lineHeight);
      ObjectSetString(0, objName, OBJPROP_FONT, "Arial");
      ObjectSetInteger(0, objName, OBJPROP_FONTSIZE, fontSize);
      ObjectSetInteger(0, objName, OBJPROP_COLOR, clrWhite);
      ObjectSetInteger(0, objName, OBJPROP_BACK, false);
   }

   ObjectCreate(0, PanelPrefix + "footer", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, PanelPrefix + "footer", OBJPROP_XDISTANCE, labelX);
   ObjectSetInteger(0, PanelPrefix + "footer", OBJPROP_YDISTANCE, yOffset + (labelCount + 1) * lineHeight);
   ObjectSetString(0, PanelPrefix + "footer", OBJPROP_FONT, "Arial");
   ObjectSetInteger(0, PanelPrefix + "footer", OBJPROP_FONTSIZE, 7);
   ObjectSetInteger(0, PanelPrefix + "footer", OBJPROP_COLOR, clrGray);
   ObjectSetString(0, PanelPrefix + "footer", OBJPROP_TEXT, "动量A+回调B双模式 | 风险优先仓位");
   ObjectSetInteger(0, PanelPrefix + "footer", OBJPROP_BACK, false);
}

void UpdatePanel()
{
   long chartWidth = ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
   if(chartWidth > 0)
   {
      int newWidth = (int)(chartWidth * 0.13);
      newWidth = MathMax(160, MathMin(220, newWidth));
      ObjectSetInteger(0, PanelPrefix + "bg", OBJPROP_XSIZE, newWidth);
   }

   string timeStr = TimeToString(TimeCurrent(), TIME_SECONDS);
   ObjectSetString(0, PanelPrefix + "time", OBJPROP_TEXT, "时间：" + timeStr);

   ObjectSetString(0, PanelPrefix + "trades", OBJPROP_TEXT,
                   "今日单数：" + IntegerToString(m_todayTrades) + (DailyMaxTrades > 0 ? "/" + IntegerToString(DailyMaxTrades) : ""));

   string profitText = StringFormat("今日盈亏：%+.2f", m_todayProfit);
   ObjectSetString(0, PanelPrefix + "profit", OBJPROP_TEXT, profitText);
   if(m_todayProfit > 0)
      ObjectSetInteger(0, PanelPrefix + "profit", OBJPROP_COLOR, clrLightGreen);
   else if(m_todayProfit < 0)
      ObjectSetInteger(0, PanelPrefix + "profit", OBJPROP_COLOR, clrRed);
   else
      ObjectSetInteger(0, PanelPrefix + "profit", OBJPROP_COLOR, clrWhite);

   ObjectSetString(0, PanelPrefix + "trend", OBJPROP_TEXT, "行情：" + m_trendDesc);

   string modeText = "模式：";
   if(m_currentState == STATE_MOMENTUM)
      modeText += "A(动量)";
   else
      modeText += "B(回调)";
   ObjectSetString(0, PanelPrefix + "mode", OBJPROP_TEXT, modeText);

   double rsiData[1];
   ArraySetAsSeries(rsiData, true);
   if(CopyBuffer(handle_iRSI, 0, 0, 1, rsiData) > 0)
      ObjectSetString(0, PanelPrefix + "rsi", OBJPROP_TEXT, StringFormat("RSI：%.1f", rsiData[0]));

   MqlTick tick;
   if(SymbolInfoTick(_Symbol, tick))
   {
      double sp = (tick.ask - tick.bid) / _Point;
      ObjectSetString(0, PanelPrefix + "spread", OBJPROP_TEXT,
                      "点差：" + StringFormat("%.0f", sp) + " / " + IntegerToString(MaxSpread));
   }

   ObjectSetString(0, PanelPrefix + "signal", OBJPROP_TEXT,
                   "信号：" + m_lastSignalDir +
                   (LastRestrictionReason != NO_RESTRICTION ? " (暂停)" : ""));

   ObjectSetString(0, PanelPrefix + "maxloss", OBJPROP_TEXT,
                   "最大浮亏：" + StringFormat("%+.2f", m_todayMaxFloating));
   if(m_todayMaxFloating < 0)
      ObjectSetInteger(0, PanelPrefix + "maxloss", OBJPROP_COLOR, clrOrange);
   else
      ObjectSetInteger(0, PanelPrefix + "maxloss", OBJPROP_COLOR, clrGray);

   string lotText = "ATR×" + StringFormat("%.1f", ATR_SL_Multiplier_A)
                  + "/" + StringFormat("%.1f", ATR_SL_Multiplier_B)
                  + " | R:R 1:" + StringFormat("%.0f", RiskRewardRatio_A)
                  + "/" + StringFormat("%.0f", RiskRewardRatio_B);
   ObjectSetString(0, PanelPrefix + "lotinfo", OBJPROP_TEXT, lotText);
}

void DeletePanel()
{
   ObjectsDeleteAll(0, PanelPrefix);
}

//+------------------------------------------------------------------+
//| 释放指标句柄                                                     |
//+------------------------------------------------------------------+
void ReleaseIndicators()
{
   if(handle_H1_TrendEMA != INVALID_HANDLE) { IndicatorRelease(handle_H1_TrendEMA); handle_H1_TrendEMA = INVALID_HANDLE; }
   if(handle_Signal_RetestEMA != INVALID_HANDLE) { IndicatorRelease(handle_Signal_RetestEMA); handle_Signal_RetestEMA = INVALID_HANDLE; }
   if(handle_ATR != INVALID_HANDLE) { IndicatorRelease(handle_ATR); handle_ATR = INVALID_HANDLE; }
   if(handle_iRSI != INVALID_HANDLE) { IndicatorRelease(handle_iRSI); handle_iRSI = INVALID_HANDLE; }
   if(handle_M15_TrendEMA != INVALID_HANDLE) { IndicatorRelease(handle_M15_TrendEMA); handle_M15_TrendEMA = INVALID_HANDLE; }
   if(handle_PSAR != INVALID_HANDLE) { IndicatorRelease(handle_PSAR); handle_PSAR = INVALID_HANDLE; }
   if(handle_ADX != INVALID_HANDLE)  { IndicatorRelease(handle_ADX);  handle_ADX  = INVALID_HANDLE; }
}

//+------------------------------------------------------------------+
//| 交易时间检查                                                     |
//+------------------------------------------------------------------+
bool IsWithinTradingHours()
{
   if(!EnableTradingTime) return true;
   datetime current = TimeCurrent();
   MqlDateTime dt;
   TimeToStruct(current, dt);
   if(TradingStartHour > TradingEndHour)
      return (dt.hour >= TradingStartHour || dt.hour < TradingEndHour);
   else
      return (dt.hour >= TradingStartHour && dt.hour < TradingEndHour);
}

bool IsTradingDayAllowed()
{
   if(!EnableDayFilter) return true;
   datetime current = TimeCurrent();
   MqlDateTime dt;
   TimeToStruct(current, dt);
   switch(dt.day_of_week)
   {
      case 0: return TradeSunday;
      case 1: return TradeMonday;
      case 2: return TradeTuesday;
      case 3: return TradeWednesday;
      case 4: return TradeThursday;
      case 5: return TradeFriday;
      case 6: return TradeSaturday;
   }
   return true;
}

//+------------------------------------------------------------------+
//| 新闻过滤                                                         |
//+------------------------------------------------------------------+
bool IsUpcomingNews()
{
   if(!NewsFilterOn) return false;

   if(TrDisabledNews && TimeCurrent() - LastNewsAvoided < StartTradingMin * 60)
   {
      TradingEnabledComm = "新闻静默期还有 " + IntegerToString(StartTradingMin) + " 分钟";
      return true;
   }
   TrDisabledNews = false;

   string sep = ",";
   string news_arr[];
   int k = StringSplit(KeyNews, StringGetCharacter(sep, 0), news_arr);
   if(k <= 0) return false;

   MqlCalendarValue values[];
   datetime start = TimeCurrent();
   datetime end = start + 86400 * DayNewsLookup;
   if(!CalendarValueHistory(values, start, end)) return false;

   for(int i = 0; i < ArraySize(values); i++)
   {
      MqlCalendarEvent event;
      CalendarEventById(values[i].event_id, event);
      MqlCalendarCountry country;
      CalendarCountryById(event.country_id, country);

      if(StringFind(NewsCurrencies, country.currency) < 0) continue;

      for(int j = 0; j < k; j++)
      {
         if(StringFind(event.name, news_arr[j]) >= 0)
         {
            if(values[i].time - TimeCurrent() < StopBeforeMin * 60)
            {
               LastNewsAvoided = values[i].time;
               TrDisabledNews = true;
               TradingEnabledComm = "即将新闻：" + event.name + " (" + country.currency + ")";
               return true;
            }
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| 环形缓冲区更新                                                   |
//+------------------------------------------------------------------+
void UpdateDataWithRingBuffer(double Ask, double Bid)
{
   Current_Spread = NormalizeDouble((Ask - Bid), _Digits);

   if(SpreadHistoryBuffer.IsEmpty())
   {
      Global_Spread_Sum = 0.0;
      for(int i = 0; i < BUFFER_SIZE; i++)
      {
         SpreadHistoryBuffer.Put(Current_Spread);
         PriceHistoryBuffer.Put(Bid);
         TimeHistoryBuffer.Put((long)TimeCurrent());
         Global_Spread_Sum += Current_Spread;
      }
      Average_Spread = Current_Spread;
      Price_Movement = 0;
      return;
   }

   if(SpreadHistoryBuffer.IsFull())
      Global_Spread_Sum -= SpreadHistoryBuffer.Peek(0);

   SpreadHistoryBuffer.Put(Current_Spread);
   Global_Spread_Sum += Current_Spread;
   Average_Spread = Global_Spread_Sum / SpreadHistoryBuffer.Size();

   PriceHistoryBuffer.Put(Bid);
   TimeHistoryBuffer.Put((long)TimeCurrent());

   double historicalBidPrice = Bid;
   long currentTimestamp = (long)TimeCurrent();
   int currentSize = TimeHistoryBuffer.Size();

   for(int i = currentSize - 1; i >= 0; i--)
   {
      long oldTime = TimeHistoryBuffer.Peek(i);
      if(currentTimestamp - oldTime > 9)
      {
         historicalBidPrice = PriceHistoryBuffer.Peek(i);
         break;
      }
   }

   Price_Movement = Bid - historicalBidPrice;
   if(MathAbs(Price_Movement) > 1000 * _Point)
      Price_Movement = 0;
}

//+------------------------------------------------------------------+
//| 图表提示显示                                                     |
//+------------------------------------------------------------------+
void ShowTradingHourAlert(string message)
{
   if(MQLInfoInteger(MQL_TESTER)) return;

   string bg_name = "Trading_Hour_Alert_BG";
   string txt_name = "Trading_Hour_Alert_TXT";

   if(message == "")
   {
      ObjectDelete(0, bg_name);
      ObjectDelete(0, txt_name);
      ChartRedraw(0);
      return;
   }

   long chart_width = ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
   long chart_height = ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS);
   int bg_size_x = 400;
   int bg_size_y = 40;
   int bg_x = (int)(chart_width - bg_size_x) / 2;
   int bg_y = (int)(chart_height - bg_size_y) / 2;

   if(ObjectFind(0, bg_name) < 0)
   {
      ObjectCreate(0, bg_name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, bg_name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, bg_name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, bg_name, OBJPROP_BACK, false);
      ObjectSetInteger(0, bg_name, OBJPROP_COLOR, clrDimGray);
   }
   ObjectSetInteger(0, bg_name, OBJPROP_XDISTANCE, bg_x);
   ObjectSetInteger(0, bg_name, OBJPROP_YDISTANCE, bg_y);
   ObjectSetInteger(0, bg_name, OBJPROP_XSIZE, bg_size_x);
   ObjectSetInteger(0, bg_name, OBJPROP_YSIZE, bg_size_y);
   ObjectSetInteger(0, bg_name, OBJPROP_BGCOLOR, clrFireBrick);

   if(ObjectFind(0, txt_name) < 0)
   {
      ObjectCreate(0, txt_name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, txt_name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, txt_name, OBJPROP_ANCHOR, ANCHOR_CENTER);
      ObjectSetInteger(0, txt_name, OBJPROP_FONTSIZE, 11);
      ObjectSetString(0, txt_name, OBJPROP_FONT, "Arial");
      ObjectSetInteger(0, txt_name, OBJPROP_COLOR, clrWhite);
      ObjectSetInteger(0, txt_name, OBJPROP_BACK, false);
   }
   ObjectSetInteger(0, txt_name, OBJPROP_XDISTANCE, bg_x + bg_size_x / 2);
   ObjectSetInteger(0, txt_name, OBJPROP_YDISTANCE, bg_y + bg_size_y / 2);
   ObjectSetString(0, txt_name, OBJPROP_TEXT, message);

   ChartRedraw(0);
}

string GetRestrictionMessage(ENUM_RESTRICTION_REASON reason)
{
   switch(reason)
   {
      case TIME_RESTRICTION:      return "非交易时间，EA已暂停";
      case DAY_RESTRICTION:       return "今日不交易，EA已暂停";
      case NEWS_RESTRICTION:      return TradingEnabledComm;
      case TIME_DAY_RESTRICTION:  return "非交易时间 + 今日不交易";
      case TIME_NEWS_RESTRICTION: return "非交易时间 + 新闻静默";
      case ALL_RESTRICTIONS:      return "所有限制条件触发，EA完全暂停";
   }
   return "";
}
//+------------------------------------------------------------------+

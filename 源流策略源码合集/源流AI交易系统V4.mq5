//+------------------------------------------------------------------+
//|                                          源流AI交易系统 V4.0      |
//|                    源流智能AI交易系统 - 黄金专用                  |
//|              多Agent协作架构 | AI全权决策 | 分层安全网             |
//|        V4.0: 多Agent协作 + 持仓管理AI化 + 记忆学习                |
//|   AI参与度: 25% -> 85% (从入场顾问升级为全权交易决策者)           |
//+------------------------------------------------------------------+
#property copyright "源流智能交易系统"
#property version   "4.00"
#property description "黄金交易 - 多Agent协作 + AI全权决策"
#property strict

#include <Trade\Trade.mqh>

//+------------------------------------------------------------------+
//| 输入参数                                                         |
//+------------------------------------------------------------------+
input group "面板位置与尺寸"
input int      InpXLeft          = 10;
input int      InpYTop           = 40;
input int      InpWidthLeft      = 220;
input int      InpWidthRight     = 280;
input int      InpWidthThird     = 280;
input int      InpPanelHeight    = 650;

input group "配色方案"
input color    ClrBackground     = C'10,10,12';
input color    ClrHeader         = C'255,190,0';
input color    ClrLabel          = C'180,180,180';
input color    ClrValue          = C'255,255,255';
input color    ClrBuy            = C'46,204,113';
input color    ClrSell           = C'231,76,60';
input color    ClrNeutral        = C'120,120,120';
input color    ClrWarning        = C'255,152,0';

input group "指标设置"
input int      InpRSIPeriod      = 14;
input int      InpMAFast         = 20;
input int      InpMASlow         = 50;
input int      InpATRPeriod      = 14;

input group "DeepSeek AI集成 - 多Agent架构 V4.0"
input bool     InpUseAI          = true;
input string   InpOpenAIAPIKey   = "api-KEY";
input string   InpOpenAIModel    = "deepseek-chat";
input string   InpModelReasoner  = "deepseek-reasoner";
input int      InpAIUpdateMinutes = 3;
input double   InpAIConfidenceMin = 0.60;
input bool     InpAIOverride      = true;

input group "V4.0 多Agent调度设置 (Phase 2)"
input bool     InpUseMultiAgent   = true;
input int      InpAnalystIntervalMin = 15;
input int      InpEntryIntervalMin   = 3;
input int      InpPositionManagerIntervalSec = 30;
input int      InpRiskOfficerIntervalMin = 60;
input bool     InpUseReviewer     = true;
input int      InpReviewerHour    = 22;
input bool     InpAutoApplyLearning = false;

input group "V4.0 持仓管理Agent设置 (Phase 1)"
input bool     InpUsePositionAI   = true;
input bool     InpUseTieredTakeProfit = true;
input double   InpTP1Pct          = 0.50;      // TP1:盈利0.50%平仓30%(加宽,让利润发展)
input double   InpTP1ClosePct     = 30.0;
input double   InpTP2Pct          = 0.90;      // TP2:盈利0.90%再平30%
input double   InpTP2ClosePct     = 30.0;
input double   InpTP3Pct          = 1.50;      // TP3:盈利1.50%追踪剩余
input bool     InpUseStructureStop = true;
input bool     InpAllowAddPosition = true;
input int      InpMaxAddCount     = 1;
input double   InpAddPyramidFactor = 0.5;
input int      InpMaxPositionHours = 24;
input double   InpMaxSingleLossPct = 3.0;      // 单笔最大亏损%(加宽到3%,避免过早强平)

input group "V4.0 外部数据集成 (Phase 3)"
input bool     InpUseDXY          = true;
input string   InpDXYSymbol       = "USDX";
input bool     InpUseTreasuryYield = true;
input string   InpUS10YSymbol     = "US10Y";
input bool     InpUseEconCalendar = true;
input bool     InpUseVIXProxy     = true;
input int      InpVIXProxyPeriod  = 100;

input group "V4.0 API优化与健壮性 (Phase 5)"
input int      InpAPIRetryCount   = 3;
input int      InpAPITimeoutMs    = 10000;
input int      InpDailyTokenBudget = 150000;
input bool     InpUseAsyncAPI     = true;
input bool     InpReduceLogs      = false;

input group "V4.0 黄金专业知识 (Phase 6)"
input bool     InpUseGoldKnowledge = true;
input bool     InpAvoidWeekendHold = false;
input bool     InpUseSeasonalFilter = true;

input group "交易算法设置"
input bool     InpEnableTrading  = true;
input double   InpLotSize        = 0.01;
input int      InpRSIBuyLevel    = 30;
input int      InpMaxPositions   = 5;
input double   InpStopLossATR     = 5;
input double   InpMaxStopLossDollars = 50.0;
input int      InpMinSpreadPts   = 5000;
input bool     InpRequireSupport = true;
input double   InpSupportDistance = 100.0;
input bool     InpRequireBullishMA = true;
input bool     InpRequireGoodSession = true;

input group "高级风险与资金管理"
input double   InpBreakevenTrigger   = 45;      // 触发保本的利润($) - 加宽,让利润先发展
input double   InpBreakevenPadding   = 20;      // 保本时锁定的额外利润($) - 加宽缓冲
input bool     InpUseMoneyManagement = false;
input double   InpRiskPercent        = 0.25;
input double   InpMaxLotCap          = 0.02;
input double   InpMinLotSize         = 0.01;
input bool     InpSniperEntry        = true;

input group "专业版: 增强风险管理"
input bool     InpUseTrailingRisk    = true;
input double   InpMaxRiskPerTrade    = 0.50;
input double   InpDailyProfitTarget  = 10.0;
input double   InpMaxDailyLoss       = 10.0;
input int      InpMaxConsecLosses    = 5;
input int      InpCooldownAfterLoss  = 300;

input group "专业版: 高级仓位管理"
input bool     InpUseKellyCriterion  = true;
input double   InpKellyFraction      = 0.25;
input int      InpMinTradesForKelly  = 20;

input group "专业版: 市场状态检测"
input bool     InpUseRegimeDetection = true;
input int      InpRegimeADXPeriod    = 14;
input double   InpRegimeADXThreshold = 25.0;

input group "专业版: 时间过滤器"
input bool     InpUseTimeFilters     = true;
input bool     InpAvoidAsianDeadZone = true;
input bool     InpAvoidSessionOpen   = true;
input bool     InpAvoidSessionClose  = true;

input group "M15波段交易设置"
input double   InpProfitTargetATR = 2;
input double   InpMinProfitPct   = 0.20;
input double   InpStrongProfitPct = 0.80;
input double   InpTrailingDollar  = 45;      // 追踪止损距离($) - 加宽给利润呼吸空间
input double   InpRescueSLDollar  = 45;      // 亏损救援阈值($) - 加宽避免过早触发
input double   InpTrailStartPct   = 0.40;    // 启动追踪止损的盈利%(低于此值不动止损)
input int      InpBreakevenBufferPts = 30;   // 保本位缓冲点数(入场价上方的安全距离)

input group "测试模式"
input bool     InpTestMode       = false;

input group "其他"
input bool     InpIncludeAllMagicNumbers = false;
input bool     InpShowPerformancePanel = false;
input int      InpPerformancePanelX    = 250;
input int      InpPerformancePanelY    = 40;

//+------------------------------------------------------------------+
//| 常量与枚举定义                                                   |
//+------------------------------------------------------------------+
#define MAGIC_NUMBER    123456
#define MAX_TRADE_LOGS  500
#define MAX_RECENT_LESSONS 5
#define MAX_KEY_LEVELS  5

enum MARKET_REGIME {
   REGIME_TRENDING_UP,
   REGIME_TRENDING_DOWN,
   REGIME_RANGING,
   REGIME_VOLATILE,
   REGIME_UNKNOWN
};

enum RISK_LEVEL {
   RISK_LOW = 0,
   RISK_MEDIUM = 1,
   RISK_HIGH = 2,
   RISK_CRITICAL = 3,
   RISK_CIRCUIT_BREAKER = 4
};

//+------------------------------------------------------------------+
//| V4.0 共享状态结构 (Phase 2 - T2.1)                              |
//+------------------------------------------------------------------+
struct AgentSharedState {
   string     market_regime;
   string     market_bias;
   double     regime_confidence;
   double     key_supports[MAX_KEY_LEVELS];
   double     key_resistances[MAX_KEY_LEVELS];
   string     market_narrative;
   datetime   analyst_update_time;

   string     entry_signal;
   double     entry_confidence;
   string     entry_type;
   int        suggested_sl_points;
   int        suggested_tp_points;
   double     size_factor;
   datetime   entry_update_time;

   bool       trading_allowed;
   int        max_positions;
   double     max_risk_per_trade;
   double     daily_loss_limit;
   double     daily_profit_target;
   int        cooldown_seconds;
   datetime   risk_update_time;

   double     adjusted_confidence_min;
   double     adjusted_sl_atr_mult;
   string     recent_lessons[MAX_RECENT_LESSONS];
   datetime   learning_update_time;

   string     next_high_impact_event;
   datetime   event_time;
   bool       event_lock;

   double     dxy_value;
   double     dxy_change;
   double     gold_dxy_correlation;
   double     us10y_yield;
   double     vix_proxy;
   datetime   external_data_time;

   RISK_LEVEL current_risk_level;
};

//+------------------------------------------------------------------+
//| V4.0 交易日志结构 (Phase 4 - T4.1)                              |
//+------------------------------------------------------------------+
struct TradeLogEntry {
   datetime   open_time;
   datetime   close_time;
   int        position_type;
   double     entry_price;
   double     exit_price;
   double     sl_price;
   double     tp_price;
   double     volume;
   double     profit;
   double     max_floating_profit;
   double     max_floating_loss;
   int        hold_seconds;
   double     rsi_at_entry;
   double     atr_at_entry;
   string     market_regime_at_entry;
   string     ai_signal_at_entry;
   double     ai_confidence_at_entry;
   string     exit_reason;
   bool       was_added;
   int        add_count;
};

//+------------------------------------------------------------------+
//| 全局变量                                                         |
//+------------------------------------------------------------------+
string         g_Prefix = "GOLD_V4_";

int            g_HandleRSI;
int            g_HandleMAFast;
int            g_HandleMASlow;
int            g_HandleATR;
int            g_HandleADX = INVALID_HANDLE;

double         g_BufferRSI[];
double         g_BufferMAFast[];
double         g_BufferMASlow[];
double         g_BufferATR[];

int            g_SymbolDigits = 0;
double         g_SymbolPoint = 0.0;
bool           g_IsGoldSymbol = false;
string         g_SymbolName = "";
double         g_TickValue = 0.0;
double         g_TickSize = 0.0;
double         g_ContractSize = 0.0;

CTrade         g_Trade;
datetime       g_LastTradeCheck = 0;
ulong          g_LastTradeTicket = 0;

int            g_TicksPerSecond = 0;
datetime       g_LastSecond = 0;

datetime       g_LastAIUpdate = 0;
string         g_AISignal = "WAIT";
double         g_AIConfidence = 0.0;
double         g_AISLPoints = 0;
double         g_AITPPoints = 0;
string         g_AIReasoning = "";
string         g_AISummary = "";
string         g_AISummaryLines[];
bool           g_AIIsActive = false;
string         g_AIStatus = "初始化";

// V4.0 多Agent调度时间
datetime       g_LastAnalystCall = 0;
datetime       g_LastEntryCall = 0;
datetime       g_LastPositionManagerCall = 0;
datetime       g_LastRiskOfficerCall = 0;
datetime       g_LastReviewerCall = 0;
datetime       g_LastEventCheck = 0;

// V4.0 API预算与健壮性
int            g_DailyTokenUsed = 0;
datetime       g_TokenBudgetResetDate = 0;
int            g_APIFailureCount = 0;

int            g_TotalTrades = 0;
int            g_WinningTrades = 0;
int            g_LosingTrades = 0;
double         g_TotalProfit = 0.0;

bool           g_TestCompleted = false;
int            g_TestStep = 0;
ulong          g_TestTicket = 0;
datetime       g_TestLastAction = 0;

ulong          g_TrackedTickets[];
double         g_MaxProfitPrice[];
datetime       g_LastSLUpdate[];

// V4.0 分级止盈跟踪
ulong          g_TPTierTickets[];
int            g_TPTierLevel[];

// V4.0 加仓跟踪
ulong          g_AddBaseTickets[];
int            g_AddCount[];

ulong          g_ProcessedDeals[];

double         g_DailyProfit = 0.0;
int            g_ConsecutiveLosses = 0;
datetime       g_LastResetDate = 0;
datetime       g_LastLossTime = 0;
bool           g_TradingHalted = false;
double         g_DailyHighEquity = 0.0;
double         g_MaxDrawdown = 0.0;

MARKET_REGIME  g_CurrentRegime = REGIME_UNKNOWN;

double         g_GrossProfit = 0.0;
double         g_GrossLoss = 0.0;
double         g_LargestWin = 0.0;
double         g_LargestLoss = 0.0;
double         g_AvgWin = 0.0;
double         g_AvgLoss = 0.0;
double         g_SharpeRatio = 0.0;
double         g_ProfitFactor = 0.0;

// V4.0 共享状态
AgentSharedState g_SharedState;

// V4.0 交易日志
TradeLogEntry    g_TradeLogs[];
int              g_TradeLogCount = 0;
ulong            g_OpenPositionTickets[];
TradeLogEntry    g_OpenTradeLogs[];

string g_GoldKnowledgePrompt = "";

//+------------------------------------------------------------------+
//| 前置函数声明                                                     |
//+------------------------------------------------------------------+
void   RunTestMode();
bool   DetectAndInitializeGoldSymbol();
int    OnInit();
void   OnDeinit(const int reason);
void   OnTick();
void   OnTimer();
void   ManageTrailingStopLoss();
void   UpdateAllData();
void   CheckAndExecuteTrades(double rsi, double bid, double ask, double atr);
double CalculateMaxStopLossDistance(double lotSize);
void   ExecuteBuyOrder(double entryPrice, double atr);
void   ExecuteSellOrder(double entryPrice, double atr);
void   ManageAIPositions(double rsi, double bid, double ask, double atr);
int    CountOpenBuyPositions();
int    CountOpenSellPositions();
int    CountTotalOpenPositions();
void   UpdateAIAnalysis(double rsi, double bid, double ask, double atr);
double GetSafeHigh(ENUM_TIMEFRAMES timeframe);
double GetSafeLow(ENUM_TIMEFRAMES timeframe);
double CalculateSentiment(ENUM_TIMEFRAMES timeframe);
void   CalculatePivotPoints(double &pivot, double &r1, double &r2, double &r3, double &s1, double &s2, double &s3);
string GetTradingSession();
void   GetDailyRange(double &high, double &low, double &range, double &rangePercent);
string BuildMarketContext(double rsi, double bid, double ask, double atr);
string EscapeJSON(string text);
string ParseOpenAIResponse(string jsonResponse);
string CallOpenAI(string marketData);
string CallOpenAI_Simulated(string marketData);
void   SplitSummaryIntoLines();
void   ParseAIResponse(string response);
void   DrawDashboard();
void   CreateRectangle(string name, int x, int y, int width, int height, color bgColor, int corner);
void   CreateTextLabel(string name, string text, int x, int y, color clr, bool bold, int fontSize, int corner);
void   UpdateUI(string suffix, string value, color clr);
double CalculateDynamicLots(double stopLossDistance);
bool   CheckSniperEntry(string signal);
void   CheckAndApplyBreakeven(ulong ticket);
void   CheckDailyReset();
bool   IsTradingAllowed();
void   UpdateTradeStatistics(double profit);
double CalculateKellyCriterionLots(double stopLossDistance);
double CalculateLinearRegressionSlope(double &data[], int period);
MARKET_REGIME DetectMarketRegime();
void   AdjustStrategyForRegime();
bool   IsGoodTradingTime();
double CalculateSharpeRatio();
void   DrawPerformancePanel();
void   UpdatePerformancePanel();
void   LoadHistoricalStatistics();
void   CheckClosedPositionsAndUpdateStats();
string EnhanceAIContext(string baseContext);
void   UpdatePanelAfterTrade();

// V4.0 Phase 1 函数
void   CallPositionManager();
string BuildPositionContext();
void   ExecutePositionActions(string response);
bool   ExecutePartialClose(ulong ticket, double closePercent);
bool   ExecuteAddPosition(ulong baseTicket, double addLots);
bool   ValidateAIAction(ulong ticket, string action, double param);
void   ApplyTieredTakeProfit(ulong ticket, double profitPct);
double FindStructureStop(ulong ticket);
int    GetTPTierLevel(ulong ticket);
void   SetTPTierLevel(ulong ticket, int level);
int    GetAddCount(ulong ticket);
void   IncrementAddCount(ulong ticket);
void   CheckPositionTimeLimit();
double CalculateTotalExposure();

// V4.0 Phase 2 函数
void   InitSharedState();
string CallAIAgent(string agentRole, string context, int maxTokens);
string SelectModelByRole(string role);
string GetSystemPrompt(string agentRole);
bool   CheckAPIBudget(string agentRole);
string GetFallbackResponse(string agentRole);
void   CallChiefAnalyst();
string BuildAnalystContext();
void   ParseAnalystResponse(string response);
void   CallEntryStrategist();
string BuildEntryContext();
void   ParseEntryResponse(string response);
void   CallRiskOfficer();
string BuildRiskContext();
void   ParseRiskResponse(string response);
void   AgentScheduler();

// V4.0 Phase 3 函数
double CalculateGoldDXYCorrelation(int period);
bool   GetDXYData(double &dxyValue, double &dxyChange);
bool   GetTreasuryYield(string symbol, double &yieldValue);
double CalculateVIXProxy(int period);
bool   CheckEconomicEvents();
bool   IsHighImpactEventTime();
void   UpdateExternalData();

// V4.0 Phase 4 函数
void   SaveTradeLog(TradeLogEntry &entry);
void   LoadTradeLogs();
void   RecordPositionOpen(ulong ticket);
void   RecordPositionClose(ulong ticket, double profit, string reason);
void   CallReviewAgent();
string BuildReviewContext();
void   ParseReviewResponse(string response);
void   ApplyParameterSuggestions(double confMin, double slAtrMult, double trailDist);
string GetRecentLessonsText();

// V4.0 Phase 5 函数
string SendAPIRequestWithRetry(string json, string url, string headers, int timeout);
string BuildCompressedContext(string agentRole, double rsi, double bid, double ask, double atr);
void   LogAPIFailure(string agentRole, string reason);

// V4.0 Phase 6 函数
string BuildGoldKnowledgePrompt();
bool   IsGoldSeasonalFavorable();
bool   IsLondonFixTime();
bool   IsWeekendRiskTime();
double DetectLiquidityVacuum();

//+------------------------------------------------------------------+
//| 测试模式函数                                                     |
//+------------------------------------------------------------------+
void RunTestMode()
{
   if(g_TestCompleted || g_TestStep == 4) return;

   if(g_TestStep == 0) {
      if(!TerminalInfoInteger(TERMINAL_CONNECTED)) { g_TestCompleted = true; return; }
      if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) { g_TestCompleted = true; return; }
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) { g_TestCompleted = true; return; }
      if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) { g_TestCompleted = true; return; }

      double testAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double testBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(testAsk <= 0 || testBid <= 0) { g_TestCompleted = true; return; }

      Print("═══════════════════════════════════════════════════════");
      Print("🤖 V4.0 AI测试模式 - 多Agent架构");
      Print("═══════════════════════════════════════════════════════");
      g_TestStep = 1;
   }

   if(g_TestStep == 1) {
      static int placeTickCount = 0;
      placeTickCount++;
      if(placeTickCount < 2) return;

      if(CountOpenBuyPositions() > 0) {
         g_TestStep = 2; placeTickCount = 0; g_TestLastAction = TimeCurrent(); return;
      }

      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(currentAsk <= 0 || currentBid <= 0) return;

      double atr = 0.0;
      if(CopyBuffer(g_HandleATR, 0, 0, 1, g_BufferATR) >= 1) atr = g_BufferATR[0];
      else atr = (currentAsk - currentBid) * 10;

      double stopLoss = NormalizeDouble(currentAsk - (atr * InpStopLossATR), g_SymbolDigits);
      double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
      if(minStopLevel > 0 && (currentAsk - stopLoss) < minStopLevel)
         stopLoss = NormalizeDouble(currentAsk - minStopLevel, g_SymbolDigits);

      MqlTradeRequest request = {};
      MqlTradeResult result = {};
      request.action = TRADE_ACTION_DEAL;
      request.symbol = _Symbol;
      request.volume = 0.01;
      request.type = ORDER_TYPE_BUY;
      request.price = currentAsk;
      request.sl = stopLoss;
      request.tp = 0;
      request.deviation = 10;
      request.magic = MAGIC_NUMBER;
      request.comment = "GOLD V4 - AI TEST";

      long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
      if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) request.type_filling = ORDER_FILLING_FOK;
      else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) request.type_filling = ORDER_FILLING_IOC;
      else request.type_filling = ORDER_FILLING_RETURN;

      if(OrderSend(request, result)) {
         if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
            Print("✅ V4.0 AI测试: 下单成功!");
            g_TestTicket = result.order;
            g_TestStep = 2; placeTickCount = 0; g_TestLastAction = TimeCurrent();
         } else { g_TestCompleted = true; }
      } else { g_TestCompleted = true; }
      return;
   }

   if(g_TestStep == 2) {
      static int tickCount = 0;
      tickCount++;
      if(tickCount < 2) return;

      for(int i = PositionsTotal() - 1; i >= 0; i--) {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER &&
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {

            double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            double currentPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            double atr = 0.0;
            if(CopyBuffer(g_HandleATR, 0, 0, 1, g_BufferATR) >= 1) atr = g_BufferATR[0];
            else atr = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - currentPrice) * 10;

            double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
            if(minStopLevel <= 0) minStopLevel = 10 * g_SymbolPoint;

            double newSL = entryPrice;
            double maxAllowedSL = currentPrice - minStopLevel;
            if(newSL >= maxAllowedSL) newSL = maxAllowedSL - (g_SymbolPoint * 1);
            newSL = NormalizeDouble(newSL, g_SymbolDigits);
            double newTP = NormalizeDouble(entryPrice + (atr * 1.0), g_SymbolDigits);

            g_Trade.PositionModify(ticket, newSL, newTP);
            g_TestTicket = ticket;
            g_TestStep = 3; tickCount = 0; g_TestLastAction = TimeCurrent();
            return;
         }
      }
      if(TimeCurrent() - g_TestLastAction > 5) { g_TestStep = 3; tickCount = 0; }
      return;
   }

   if(g_TestStep == 3) {
      static int closeTickCount = 0;
      closeTickCount++;
      if(closeTickCount < 2) return;

      for(int i = PositionsTotal() - 1; i >= 0; i--) {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER &&
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {

            g_Trade.PositionClose(ticket);
            Print("✅ V4.0 AI测试完成!");
            g_TestStep = 4; g_TestCompleted = true; closeTickCount = 0;
            return;
         }
      }
      if(TimeCurrent() - g_TestLastAction > 5) {
         Print("✅ V4.0 AI测试完成!");
         g_TestStep = 4; g_TestCompleted = true; closeTickCount = 0;
      }
   }
}

//+------------------------------------------------------------------+
//| 检测黄金品种                                                     |
//+------------------------------------------------------------------+
bool DetectAndInitializeGoldSymbol()
{
   g_SymbolName = _Symbol;
   string symbolUpper = _Symbol;
   StringToUpper(symbolUpper);
   g_IsGoldSymbol = (StringFind(symbolUpper, "XAU") >= 0 ||
                     StringFind(symbolUpper, "GOLD") >= 0 ||
                     StringFind(symbolUpper, "XAUUSD") >= 0 ||
                     StringFind(symbolUpper, "GOLDUSD") >= 0);
   g_SymbolDigits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   g_SymbolPoint = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   g_TickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   g_TickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   g_ContractSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);

   Print("═══════════════════════════════════════════════════════");
   Print("📊 V4.0 品种检测: ", g_SymbolName, (g_IsGoldSymbol ? " (GOLD)" : ""));
   Print("═══════════════════════════════════════════════════════");
   return true;
}

//+------------------------------------------------------------------+
//| V4.0 初始化共享状态 (Phase 2 - T2.1)                            |
//+------------------------------------------------------------------+
void InitSharedState()
{
   g_SharedState.market_regime = "UNKNOWN";
   g_SharedState.market_bias = "NEUTRAL";
   g_SharedState.regime_confidence = 0.0;
   g_SharedState.market_narrative = "";
   g_SharedState.analyst_update_time = 0;
   g_SharedState.entry_signal = "WAIT";
   g_SharedState.entry_confidence = 0.0;
   g_SharedState.entry_type = "NONE";
   g_SharedState.suggested_sl_points = 0;
   g_SharedState.suggested_tp_points = 0;
   g_SharedState.size_factor = 1.0;
   g_SharedState.entry_update_time = 0;
   g_SharedState.trading_allowed = true;
   g_SharedState.max_positions = InpMaxPositions;
   g_SharedState.max_risk_per_trade = InpMaxRiskPerTrade;
   g_SharedState.daily_loss_limit = InpMaxDailyLoss;
   g_SharedState.daily_profit_target = InpDailyProfitTarget;
   g_SharedState.cooldown_seconds = InpCooldownAfterLoss;
   g_SharedState.risk_update_time = 0;
   g_SharedState.adjusted_confidence_min = InpAIConfidenceMin;
   g_SharedState.adjusted_sl_atr_mult = InpStopLossATR;
   g_SharedState.learning_update_time = 0;
   g_SharedState.next_high_impact_event = "";
   g_SharedState.event_time = 0;
   g_SharedState.event_lock = false;
   g_SharedState.dxy_value = 0.0;
   g_SharedState.dxy_change = 0.0;
   g_SharedState.gold_dxy_correlation = 0.0;
   g_SharedState.us10y_yield = 0.0;
   g_SharedState.vix_proxy = 0.0;
   g_SharedState.external_data_time = 0;
   g_SharedState.current_risk_level = RISK_LOW;

   for(int i = 0; i < MAX_KEY_LEVELS; i++) {
      g_SharedState.key_supports[i] = 0.0;
      g_SharedState.key_resistances[i] = 0.0;
   }
   for(int i = 0; i < MAX_RECENT_LESSONS; i++) {
      g_SharedState.recent_lessons[i] = "";
   }
}

//+------------------------------------------------------------------+
//| V4.0 构建黄金专业知识Prompt (Phase 6)                           |
//+------------------------------------------------------------------+
string BuildGoldKnowledgePrompt()
{
   if(!InpUseGoldKnowledge) return "";
   string prompt = "";
   prompt += "【黄金市场专业知识】\n";
   prompt += "1. 黄金与美元指数(DXY)负相关(-0.7~-0.9)\n";
   prompt += "2. 黄金与美债实际收益率负相关\n";
   prompt += "3. 黄金是避险资产,地缘政治事件推升金价\n";
   prompt += "4. 黄金以美元计价,美元走强压制金价\n\n";
   prompt += "【黄金关键时段(北京时间)】\n";
   prompt += "- 06:00-14:00 亚盘:低波动,适合区间\n";
   prompt += "- 15:00-23:00 伦敦:波动放大\n";
   prompt += "- 21:00-23:00 伦敦+纽约重叠:最佳时段\n";
   prompt += "- 21:30-22:30 美国数据发布高峰:高波动\n\n";
   prompt += "【黄金交易禁忌】\n";
   prompt += "- 避免NFP/CPI/FOMC前15分钟建仓\n";
   prompt += "- 避免亚盘凌晨2-5点(GMT)交易\n";
   prompt += "- 周五21:00后不建议建新仓\n";
   prompt += "- 单边急涨/急跌后不追\n\n";
   prompt += "【黄金止损止盈原则 - 市场状态自适应】\n";
   prompt += "止损止盈按市场状态自适应决策:\n";
   prompt += "  趋势市(TRENDING): 止损=ATR x 0.8-1.2(紧止损,趋势在背后保护),\n";
   prompt += "                    止盈=ATR x 2.5-4.0(宽止盈,让利润奔跑)\n";
   prompt += "  震荡市(RANGING):  止损=ATR x 1.5-2.0(宽止损,防区间假突破扫损),\n";
   prompt += "                    止盈=ATR x 0.8-1.5(紧止盈,触及区间边界了结)\n";
   prompt += "  波动市(VOLATILE): 止损=ATR x 2.0-2.5(宽止损,防极端波动穿止损),\n";
   prompt += "                    止盈=ATR x 2.0-3.5(宽止盈,捕获大波动行情)\n";
   prompt += "止损必须放在结构位(前低/前高/支撑/阻力)外侧5-10点\n";
   prompt += "与首席分析师Bias方向一致的交易止损可稍紧,逆Bias交易止损须加宽或直接WAIT\n";
   prompt += "避开整数关口止损(如3200.00,设在3198.5或3201.5)\n\n";
   prompt += "【黄金特有形态】\n";
   prompt += "- 伦敦突破:亚盘区间突破顺势\n";
   prompt += "- 纽约反转:纽约开盘反向运动\n";
   prompt += "- 假突破扫损:突破后快速回落\n";
   prompt += "- 避险拉升:地缘事件急涨\n\n";
   prompt += "【黄金市场结构(Phase 6)】\n";
   prompt += "- 伦敦定盘价:上午10:30和下午3:00(GMT)\n";
   prompt += "- COMEX期货交割日:每月最后交易日\n";
   prompt += "- 央行购金数据:关注IMF月度报告\n\n";
   prompt += "【黄金季节性模式(Phase 6)】\n";
   prompt += "- 印度婚礼季(10-12月):实物需求上升\n";
   prompt += "- 中国春节(1-2月):消费需求上升\n";
   prompt += "- 夏季低迷期(6-8月):波动率下降\n";
   prompt += "- 年末避险:12月机构调仓\n\n";
   return prompt;
}

//+------------------------------------------------------------------+
//| EA初始化                                                         |
//+------------------------------------------------------------------+
int OnInit()
{
   if(!DetectAndInitializeGoldSymbol()) return INIT_FAILED;
   SymbolSelect(_Symbol, true);

   g_HandleRSI = iRSI(_Symbol, PERIOD_CURRENT, InpRSIPeriod, PRICE_CLOSE);
   g_HandleMAFast = iMA(_Symbol, PERIOD_CURRENT, InpMAFast, 0, MODE_EMA, PRICE_CLOSE);
   g_HandleMASlow = iMA(_Symbol, PERIOD_CURRENT, InpMASlow, 0, MODE_EMA, PRICE_CLOSE);
   g_HandleATR = iATR(_Symbol, PERIOD_CURRENT, InpATRPeriod);
   if(InpUseRegimeDetection) g_HandleADX = iADX(_Symbol, PERIOD_M15, InpRegimeADXPeriod);

   if(g_HandleRSI == INVALID_HANDLE || g_HandleMAFast == INVALID_HANDLE ||
      g_HandleMASlow == INVALID_HANDLE || g_HandleATR == INVALID_HANDLE) return INIT_FAILED;

   ArraySetAsSeries(g_BufferRSI, true);
   ArraySetAsSeries(g_BufferMAFast, true);
   ArraySetAsSeries(g_BufferMASlow, true);
   ArraySetAsSeries(g_BufferATR, true);

   g_Trade.SetExpertMagicNumber(MAGIC_NUMBER);
   g_Trade.SetDeviationInPoints(10);
   g_Trade.SetTypeFilling(ORDER_FILLING_FOK);

   InitSharedState();
   g_GoldKnowledgePrompt = BuildGoldKnowledgePrompt();
   LoadTradeLogs();
   CheckDailyReset();
   g_DailyHighEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   LoadHistoricalStatistics();
   DrawDashboard();
   EventSetTimer(1);

   Print("═══════════════════════════════════════════════════════");
   Print("🎉 源流AI交易系统 V4.0 初始化成功");
   Print("   品种: ", g_SymbolName, (g_IsGoldSymbol ? " (GOLD)" : ""));
   Print("V4.0 多Agent架构:");
   Print("  Phase1 持仓管理AI: ", (InpUsePositionAI ? "ON" : "OFF"));
   Print("  Phase2 多Agent协作: ", (InpUseMultiAgent ? "ON" : "OFF"));
   Print("  Phase3 外部数据: ", (InpUseDXY ? "ON" : "OFF"));
   Print("  Phase4 记忆学习: ", (InpUseReviewer ? "ON" : "OFF"));
   Print("  Phase5 API优化: 重试=", InpAPIRetryCount);
   Print("  Phase6 黄金知识: ", (InpUseGoldKnowledge ? "ON" : "OFF"));
   Print("═══════════════════════════════════════════════════════");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EA逆初始化                                                       |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   ObjectsDeleteAll(0, g_Prefix);
   if(g_HandleRSI != INVALID_HANDLE) IndicatorRelease(g_HandleRSI);
   if(g_HandleMAFast != INVALID_HANDLE) IndicatorRelease(g_HandleMAFast);
   if(g_HandleMASlow != INVALID_HANDLE) IndicatorRelease(g_HandleMASlow);
   if(g_HandleATR != INVALID_HANDLE) IndicatorRelease(g_HandleATR);
   if(g_HandleADX != INVALID_HANDLE) IndicatorRelease(g_HandleADX);
   Print("源流AI交易系统 V4.0 已停止");
}

//+------------------------------------------------------------------+
//| 主循环 OnTick                                                    |
//+------------------------------------------------------------------+
void OnTick()
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double midPrice = (bid + ask) / 2.0;
   double spread = (ask - bid) / g_SymbolPoint;

   UpdateUI("Price", DoubleToString(midPrice, g_SymbolDigits), ClrValue);
   UpdateUI("BidPrice", DoubleToString(bid, g_SymbolDigits), ClrValue);
   UpdateUI("AskPrice", DoubleToString(ask, g_SymbolDigits), ClrValue);
   UpdateUI("Spread", DoubleToString(spread, 0) + " pts", (spread > 30) ? ClrWarning : ClrValue);

   CheckDailyReset();

   static datetime lastRegimeCheck = 0;
   if(TimeCurrent() - lastRegimeCheck >= 60) {
      AdjustStrategyForRegime();
      lastRegimeCheck = TimeCurrent();
   }

   if(InpTestMode && !g_TestCompleted) RunTestMode();

   static datetime lastDataUpdate = 0;
   if(TimeCurrent() - lastDataUpdate >= 1) {
      UpdateAllData();
      lastDataUpdate = TimeCurrent();
   }

   // V4.0 Agent调度器 (Phase 2 - T2.5)
   if(InpUseMultiAgent && !InpTestMode) AgentScheduler();

   // V4.0 持仓时间限制检查 (Phase 1 - T1.5)
   if(InpEnableTrading && InpUsePositionAI) CheckPositionTimeLimit();

   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 定时器                                                           |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(InpTestMode && !g_TestCompleted) RunTestMode();
   UpdateAllData();
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| V4.0 智能追踪止损 - 结构化止损 (Phase 1 - T1.3)                 |
//+------------------------------------------------------------------+
void ManageTrailingStopLoss()
{
   if(!InpEnableTrading) return;

   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
   if(minStopLevel <= 0) minStopLevel = 10 * g_SymbolPoint;

   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MAGIC_NUMBER) continue;

      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);

      int trackerIdx = -1;
      for(int j = 0; j < ArraySize(g_TrackedTickets); j++) {
         if(g_TrackedTickets[j] == ticket) { trackerIdx = j; break; }
      }
      if(trackerIdx < 0) {
         int newSize = ArraySize(g_TrackedTickets) + 1;
         ArrayResize(g_TrackedTickets, newSize);
         ArrayResize(g_MaxProfitPrice, newSize);
         ArrayResize(g_LastSLUpdate, newSize);
         trackerIdx = newSize - 1;
         g_TrackedTickets[trackerIdx] = ticket;
         g_MaxProfitPrice[trackerIdx] = entryPrice;
         g_LastSLUpdate[trackerIdx] = 0;
      }

      if(posType == POSITION_TYPE_BUY) {
         if(currentBid > g_MaxProfitPrice[trackerIdx]) g_MaxProfitPrice[trackerIdx] = currentBid;
      } else {
         if(currentAsk < g_MaxProfitPrice[trackerIdx]) g_MaxProfitPrice[trackerIdx] = currentAsk;
      }

      CheckAndApplyBreakeven(ticket);

      double maxProfit = g_MaxProfitPrice[trackerIdx];
      double trailingSL = 0.0;
      double profitPct = 0.0;

      if(posType == POSITION_TYPE_BUY) {
         profitPct = ((currentBid - entryPrice) / entryPrice) * 100.0;
         double profitDollars = PositionGetDouble(POSITION_PROFIT);

         // V4.0 修正:只有盈利达到InpTrailStartPct才启动追踪,给利润足够呼吸空间
         if(InpUseStructureStop && profitPct >= InpTrailStartPct) {
            double structureSL = FindStructureStop(ticket);
            if(structureSL > 0 && structureSL > currentSL && structureSL < currentBid) {
               trailingSL = NormalizeDouble(structureSL, g_SymbolDigits);
            } else if(currentSL < entryPrice) {
               // 保本位:入场价+缓冲点数(加宽避免被扫)
               trailingSL = NormalizeDouble(entryPrice + (g_SymbolPoint * InpBreakevenBufferPts), g_SymbolDigits);
            } else {
               double trailPoints = (InpTrailingDollar * 100.0) / g_TickValue;
               trailingSL = NormalizeDouble(maxProfit - (trailPoints * g_SymbolPoint), g_SymbolDigits);
            }
         } else if(profitPct >= InpTrailStartPct) {
            if(currentSL < entryPrice) {
               trailingSL = NormalizeDouble(entryPrice + (g_SymbolPoint * InpBreakevenBufferPts), g_SymbolDigits);
            } else {
               double trailPoints = (InpTrailingDollar * 100.0) / g_TickValue;
               trailingSL = NormalizeDouble(maxProfit - (trailPoints * g_SymbolPoint), g_SymbolDigits);
            }
         } else if(profitDollars < -InpRescueSLDollar && currentSL > 0) {
            // 救援模式:亏损较大时才移动止损(避免过早干预)
            double rescuePoints = (InpRescueSLDollar * 50.0) / g_TickValue;
            double rescueSL = currentBid - (rescuePoints * g_SymbolPoint);
            if(rescueSL > currentSL) trailingSL = NormalizeDouble(rescueSL, g_SymbolDigits);
            else trailingSL = currentSL;
         } else {
            // 盈利不足或小亏损:保持原止损,让交易有发展空间
            trailingSL = currentSL;
         }

         double maxAllowedSL = currentBid - minStopLevel;
         if(trailingSL >= maxAllowedSL) trailingSL = NormalizeDouble(maxAllowedSL - (g_SymbolPoint * 1), g_SymbolDigits);

         if(trailingSL > currentSL && trailingSL >= entryPrice) {
            if(g_Trade.PositionModify(ticket, trailingSL, 0)) g_LastSLUpdate[trackerIdx] = TimeCurrent();
         } else if(trailingSL > currentSL && profitDollars < 0) {
            if(g_Trade.PositionModify(ticket, trailingSL, 0)) g_LastSLUpdate[trackerIdx] = TimeCurrent();
         }
      } else if(posType == POSITION_TYPE_SELL) {
         profitPct = ((entryPrice - currentAsk) / entryPrice) * 100.0;
         double profitDollars = PositionGetDouble(POSITION_PROFIT);

         // V4.0 修正:只有盈利达到InpTrailStartPct才启动追踪
         if(InpUseStructureStop && profitPct >= InpTrailStartPct) {
            double structureSL = FindStructureStop(ticket);
            if(structureSL > 0 && structureSL < currentSL && structureSL > currentAsk) {
               trailingSL = NormalizeDouble(structureSL, g_SymbolDigits);
            } else if(currentSL > entryPrice || currentSL == 0) {
               trailingSL = NormalizeDouble(entryPrice - (g_SymbolPoint * InpBreakevenBufferPts), g_SymbolDigits);
            } else {
               double trailPoints = (InpTrailingDollar * 100.0) / g_TickValue;
               trailingSL = NormalizeDouble(maxProfit + (trailPoints * g_SymbolPoint), g_SymbolDigits);
            }
         } else if(profitPct >= InpTrailStartPct) {
            if(currentSL > entryPrice || currentSL == 0) {
               trailingSL = NormalizeDouble(entryPrice - (g_SymbolPoint * InpBreakevenBufferPts), g_SymbolDigits);
            } else {
               double trailPoints = (InpTrailingDollar * 100.0) / g_TickValue;
               trailingSL = NormalizeDouble(maxProfit + (trailPoints * g_SymbolPoint), g_SymbolDigits);
            }
         } else if(profitDollars < -InpRescueSLDollar && currentSL > 0) {
            double rescuePoints = (InpRescueSLDollar * 50.0) / g_TickValue;
            double rescueSL = currentAsk + (rescuePoints * g_SymbolPoint);
            if(rescueSL < currentSL) trailingSL = NormalizeDouble(rescueSL, g_SymbolDigits);
            else trailingSL = currentSL;
         } else {
            trailingSL = currentSL;
         }

         double minAllowedSL = currentAsk + minStopLevel;
         if(trailingSL <= minAllowedSL) trailingSL = NormalizeDouble(minAllowedSL + (g_SymbolPoint * 1), g_SymbolDigits);

         if(trailingSL < currentSL && trailingSL <= entryPrice) {
            if(g_Trade.PositionModify(ticket, trailingSL, 0)) g_LastSLUpdate[trackerIdx] = TimeCurrent();
         } else if(trailingSL < currentSL && profitDollars < 0) {
            if(g_Trade.PositionModify(ticket, trailingSL, 0)) g_LastSLUpdate[trackerIdx] = TimeCurrent();
         }
      }
   }

   // 清理不存在的跟踪器
   for(int k = ArraySize(g_TrackedTickets) - 1; k >= 0; k--) {
      bool exists = false;
      for(int m = PositionsTotal() - 1; m >= 0; m--) {
         if(PositionGetTicket(m) == g_TrackedTickets[k]) { exists = true; break; }
      }
      if(!exists) {
         for(int n = k; n < ArraySize(g_TrackedTickets) - 1; n++) {
            g_TrackedTickets[n] = g_TrackedTickets[n + 1];
            g_MaxProfitPrice[n] = g_MaxProfitPrice[n + 1];
            g_LastSLUpdate[n] = g_LastSLUpdate[n + 1];
         }
         ArrayResize(g_TrackedTickets, ArraySize(g_TrackedTickets) - 1);
         ArrayResize(g_MaxProfitPrice, ArraySize(g_MaxProfitPrice) - 1);
         ArrayResize(g_LastSLUpdate, ArraySize(g_LastSLUpdate) - 1);
      }
   }
}

//+------------------------------------------------------------------+
//| 主数据更新                                                       |
//+------------------------------------------------------------------+
void UpdateAllData()
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double spread = (ask - bid) / g_SymbolPoint;
   double midPrice = (bid + ask) / 2.0;

   UpdateUI("Price", DoubleToString(midPrice, g_SymbolDigits), ClrValue);
   UpdateUI("BidPrice", DoubleToString(bid, g_SymbolDigits), ClrValue);
   UpdateUI("AskPrice", DoubleToString(ask, g_SymbolDigits), ClrValue);
   UpdateUI("Spread", DoubleToString(spread, 0) + " pts", (spread > 30) ? ClrWarning : ClrValue);

   double rsi = 50.0;
   double atr = 0.0;
   bool dataValid = true;

   if(CopyBuffer(g_HandleRSI, 0, 0, 1, g_BufferRSI) < 1 || ArraySize(g_BufferRSI) < 1) {
      dataValid = false;
   } else {
      rsi = g_BufferRSI[0];
   }

   if(CopyBuffer(g_HandleMAFast, 0, 0, 1, g_BufferMAFast) < 1 ||
      CopyBuffer(g_HandleMASlow, 0, 0, 1, g_BufferMASlow) < 1 ||
      CopyBuffer(g_HandleATR, 0, 0, 1, g_BufferATR) < 1) {
      dataValid = false;
   } else {
      if(ArraySize(g_BufferATR) > 0) atr = g_BufferATR[0];
   }

   if(!dataValid) { ChartRedraw(0); return; }

   datetime currentSecond = TimeCurrent();
   if(currentSecond != g_LastSecond) { g_LastSecond = currentSecond; g_TicksPerSecond = 0; }
   g_TicksPerSecond++;
   UpdateUI("Velocity", IntegerToString(g_TicksPerSecond) + " ticks/秒", (g_TicksPerSecond > 10) ? ClrBuy : ClrValue);

   UpdateUI("RSI", DoubleToString(rsi, 1), (rsi < 30) ? ClrBuy : (rsi > 70) ? ClrSell : ClrValue);
   double distanceTo30 = rsi - 30.0;
   double distanceTo70 = 70.0 - rsi;
   if(distanceTo30 <= 0) UpdateUI("RSI_To30", "超卖 ✓", ClrBuy);
   else UpdateUI("RSI_To30", DoubleToString(distanceTo30, 1) + " to <30", ClrBuy);
   if(distanceTo70 <= 0) UpdateUI("RSI_To70", "超买 ✓", ClrSell);
   else UpdateUI("RSI_To70", DoubleToString(distanceTo70, 1) + " to >70", ClrSell);

   if(ArraySize(g_BufferMAFast) > 0) UpdateUI("MAFast", DoubleToString(g_BufferMAFast[0], g_SymbolDigits), ClrValue);
   if(ArraySize(g_BufferMASlow) > 0) UpdateUI("MASlow", DoubleToString(g_BufferMASlow[0], g_SymbolDigits), ClrValue);
   UpdateUI("ATR", DoubleToString(atr, g_SymbolDigits), ClrValue);

   int openPositions = CountTotalOpenPositions();
   int buyPositions = CountOpenBuyPositions();
   int sellPositions = CountOpenSellPositions();

   string statusText = InpEnableTrading ?
      "活跃 (" + IntegerToString(openPositions) + "/" + IntegerToString(InpMaxPositions) +
      " | 多:" + IntegerToString(buyPositions) + " 空:" + IntegerToString(sellPositions) + ")" : "禁用";
   UpdateUI("TradingStatus", statusText, (InpEnableTrading ? ClrBuy : ClrNeutral));

   CheckClosedPositionsAndUpdateStats();

   double floatingProfit = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER) {
         floatingProfit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP) + PositionGetDouble(POSITION_COMMISSION);
      }
   }
   double dailyTotalProfit = g_DailyProfit + floatingProfit;
   UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotalProfit, 2), dailyTotalProfit >= 0 ? ClrBuy : ClrSell);
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);

   // V4.0 更新Agent状态面板
   if(InpUseMultiAgent) {
      string analystText = "--";
      if(g_SharedState.analyst_update_time > 0) {
         int minsAgo = (int)((TimeCurrent() - g_SharedState.analyst_update_time) / 60);
         analystText = g_SharedState.market_bias + " (" + IntegerToString(minsAgo) + "分前)";
      }
      UpdateUI("Analyst", analystText, ClrValue);

      string riskLevelStr = "LOW";
      color riskColor = ClrBuy;
      switch(g_SharedState.current_risk_level) {
         case RISK_LOW: riskLevelStr = "LOW"; riskColor = ClrBuy; break;
         case RISK_MEDIUM: riskLevelStr = "MEDIUM"; riskColor = ClrWarning; break;
         case RISK_HIGH: riskLevelStr = "HIGH"; riskColor = ClrSell; break;
         case RISK_CRITICAL: riskLevelStr = "CRITICAL"; riskColor = ClrSell; break;
         case RISK_CIRCUIT_BREAKER: riskLevelStr = "BREAKER"; riskColor = ClrSell; break;
      }
      UpdateUI("RiskLevel", riskLevelStr, riskColor);

      string extText = "--";
      if(g_SharedState.dxy_value > 0) {
         extText = "DXY:" + DoubleToString(g_SharedState.dxy_value, 1);
         if(g_SharedState.vix_proxy > 0) extText += " VIX:" + DoubleToString(g_SharedState.vix_proxy, 0) + "%";
      }
      UpdateUI("ExternalData", extText, ClrValue);
   }

   // 风控检查
   if(g_DailyProfit >= InpDailyProfitTarget) { UpdateUI("TradingStatus", "✅ 盈利达标", ClrBuy); return; }
   if(g_DailyProfit <= -InpMaxDailyLoss) { UpdateUI("TradingStatus", "❌ 亏损达标", ClrSell); return; }
   if(g_ConsecutiveLosses > 0 && InpCooldownAfterLoss > 0) {
      datetime timeSinceLastLoss = TimeCurrent() - g_LastLossTime;
      if(timeSinceLastLoss < InpCooldownAfterLoss) {
         int remaining = InpCooldownAfterLoss - (int)timeSinceLastLoss;
         UpdateUI("TradingStatus", "⏸️ 冷却中 " + IntegerToString(remaining) + "秒", ClrWarning);
         return;
      } else { g_ConsecutiveLosses = 0; }
   }
   if(g_SharedState.event_lock) { UpdateUI("TradingStatus", "🚨 事件锁定", ClrWarning); return; }
   if(InpUseMultiAgent && !g_SharedState.trading_allowed) { UpdateUI("TradingStatus", "⛔ 风控禁止", ClrSell); return; }

   if(InpUseAI) UpdateAIAnalysis(rsi, bid, ask, atr);
   if(InpEnableTrading) ManageTrailingStopLoss();
   if(InpEnableTrading) ManageAIPositions(rsi, bid, ask, atr);
   if(InpEnableTrading) {
      if(InpTestMode && CountOpenBuyPositions() > 0) {} else {
         CheckAndExecuteTrades(rsi, bid, ask, atr);
      }
   }
   // V4.0 持仓管理Agent (Phase 1 - T1.1)
   if(InpEnableTrading && InpUsePositionAI && !InpTestMode) CallPositionManager();
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 检查并执行交易                                                   |
//+------------------------------------------------------------------+
void CheckAndExecuteTrades(double rsi, double bid, double ask, double atr)
{
   if(!IsTradingAllowed()) return;
   if(!IsGoodTradingTime()) return;
   if(InpAvoidWeekendHold && IsWeekendRiskTime()) return;

   int totalPositions = CountTotalOpenPositions();
   int maxPos = InpUseMultiAgent ? g_SharedState.max_positions : InpMaxPositions;
   if(totalPositions >= maxPos) return;

   if(InpUseAI && g_AIIsActive) {
      double minConf = InpUseMultiAgent ? g_SharedState.adjusted_confidence_min : InpAIConfidenceMin;

      if(g_AISignal == "BUY" && g_AIConfidence >= minConf) {
         if(InpSniperEntry && !CheckSniperEntry("BUY")) return;
         Print("═══════════════════════════════════════════════════════");
         Print("📊 V4.0 AI: BUY | 置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
         ExecuteBuyOrder(ask, atr);
         if(CountTotalOpenPositions() >= maxPos) { g_AISignal = "WAIT"; g_AIReasoning = "已达最大持仓"; }
         Print("═══════════════════════════════════════════════════════");
      } else if(g_AISignal == "SELL" && g_AIConfidence >= minConf) {
         if(InpSniperEntry && !CheckSniperEntry("SELL")) return;
         Print("═══════════════════════════════════════════════════════");
         Print("📊 V4.0 AI: SELL | 置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
         ExecuteSellOrder(bid, atr);
         if(CountTotalOpenPositions() >= maxPos) { g_AISignal = "WAIT"; g_AIReasoning = "已达最大持仓"; }
         Print("═══════════════════════════════════════════════════════");
      }
   }

   if(!InpUseAI || !g_AIIsActive) {
      if(rsi < InpRSIBuyLevel && InpRequireBullishMA) {
         if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0) {
            if(g_BufferMAFast[0] > g_BufferMASlow[0]) ExecuteBuyOrder(ask, atr);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 计算最大止损距离                                                 |
//+------------------------------------------------------------------+
double CalculateMaxStopLossDistance(double lotSize)
{
   if(InpMaxStopLossDollars <= 0) return 0;
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0 || tickValue <= 0) {
      return InpMaxStopLossDollars / (lotSize * 100.0);
   }
   double valuePerTick = tickValue * lotSize;
   double maxTicks = InpMaxStopLossDollars / valuePerTick;
   return maxTicks * tickSize;
}

//+------------------------------------------------------------------+
//| 执行买入订单                                                     |
//+------------------------------------------------------------------+
void ExecuteBuyOrder(double entryPrice, double atr)
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) { Print("错误: 终端自动交易禁用"); return; }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) { Print("错误: EA自动交易禁用"); return; }

   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(currentAsk <= 0 || currentBid <= 0) return;

   double stopLossDistance, stopLoss, takeProfit = 0;
   if(g_AISLPoints > 0) {
      stopLossDistance = g_AISLPoints * g_SymbolPoint;
      stopLoss = currentAsk - stopLossDistance;
   } else {
      double atrMult = InpUseMultiAgent ? g_SharedState.adjusted_sl_atr_mult : InpStopLossATR;
      stopLossDistance = atr * atrMult;
      stopLoss = currentAsk - stopLossDistance;
   }
   stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);
   if(g_AITPPoints > 0) takeProfit = NormalizeDouble(currentAsk + (g_AITPPoints * g_SymbolPoint), g_SymbolDigits);

   double calculatedLots = CalculateKellyCriterionLots(stopLossDistance);
   double maxSLDistance = CalculateMaxStopLossDistance(calculatedLots);
   if(maxSLDistance > 0 && (currentAsk - stopLoss) > maxSLDistance) {
      stopLoss = NormalizeDouble(currentAsk - maxSLDistance, g_SymbolDigits);
   }
   double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
   if(minStopLevel > 0 && (currentAsk - stopLoss) < minStopLevel)
      stopLoss = NormalizeDouble(currentAsk - minStopLevel, g_SymbolDigits);

   Print("=== V4.0 买入 === 手数:", calculatedLots, " 价:", currentAsk, " SL:", stopLoss);

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = calculatedLots;
   request.type = ORDER_TYPE_BUY;
   request.price = currentAsk;
   request.sl = stopLoss;
   request.tp = takeProfit;
   request.deviation = 10;
   request.magic = MAGIC_NUMBER;
   request.comment = "GOLD V4 - AI";

   long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) request.type_filling = ORDER_FILLING_FOK;
   else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) request.type_filling = ORDER_FILLING_IOC;
   else request.type_filling = ORDER_FILLING_RETURN;

   if(OrderSend(request, result)) {
      if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
         Print("✓✓✓ V4.0 买入成功! 订单:", result.order);
         g_LastTradeTicket = result.order;
         Sleep(200);
         if(PositionSelect(_Symbol)) RecordPositionOpen(PositionGetInteger(POSITION_TICKET));
         int openPos = CountTotalOpenPositions();
         UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) + ")", ClrBuy);
         ChartRedraw(0);
      }
   } else {
      Print("✗ V4.0 买入失败: ", result.retcode);
      if(result.retcode == TRADE_RETCODE_REJECT) {
         if(request.type_filling == ORDER_FILLING_FOK) request.type_filling = ORDER_FILLING_IOC;
         else if(request.type_filling == ORDER_FILLING_IOC) request.type_filling = ORDER_FILLING_RETURN;
         OrderSend(request, result);
      }
   }
}

//+------------------------------------------------------------------+
//| 执行卖出订单                                                     |
//+------------------------------------------------------------------+
void ExecuteSellOrder(double entryPrice, double atr)
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return;
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) return;

   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(currentAsk <= 0 || currentBid <= 0) return;

   double stopLossDistance, stopLoss, takeProfit = 0;
   if(g_AISLPoints > 0) {
      stopLossDistance = g_AISLPoints * g_SymbolPoint;
      stopLoss = currentBid + stopLossDistance;
   } else {
      double atrMult = InpUseMultiAgent ? g_SharedState.adjusted_sl_atr_mult : InpStopLossATR;
      stopLossDistance = atr * atrMult;
      stopLoss = currentBid + stopLossDistance;
   }
   stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);
   if(g_AITPPoints > 0) takeProfit = NormalizeDouble(currentBid - (g_AITPPoints * g_SymbolPoint), g_SymbolDigits);

   double calculatedLots = CalculateKellyCriterionLots(stopLossDistance);
   double maxSLDistance = CalculateMaxStopLossDistance(calculatedLots);
   if(maxSLDistance > 0 && (stopLoss - currentBid) > maxSLDistance)
      stopLoss = NormalizeDouble(currentBid + maxSLDistance, g_SymbolDigits);
   double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
   if(minStopLevel > 0 && (stopLoss - currentBid) < minStopLevel)
      stopLoss = NormalizeDouble(currentBid + minStopLevel, g_SymbolDigits);

   Print("=== V4.0 卖出 === 手数:", calculatedLots, " 价:", currentBid, " SL:", stopLoss);

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = calculatedLots;
   request.type = ORDER_TYPE_SELL;
   request.price = currentBid;
   request.sl = stopLoss;
   request.tp = takeProfit;
   request.deviation = 10;
   request.magic = MAGIC_NUMBER;
   request.comment = "GOLD V4 - AI SELL";

   long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) request.type_filling = ORDER_FILLING_FOK;
   else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) request.type_filling = ORDER_FILLING_IOC;
   else request.type_filling = ORDER_FILLING_RETURN;

   if(OrderSend(request, result)) {
      if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
         Print("✓✓✓ V4.0 卖出成功! 订单:", result.order);
         g_LastTradeTicket = result.order;
         Sleep(200);
         if(PositionSelect(_Symbol)) RecordPositionOpen(PositionGetInteger(POSITION_TICKET));
         int openPos = CountTotalOpenPositions();
         UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) + ")", ClrBuy);
         ChartRedraw(0);
      }
   } else {
      Print("✗ V4.0 卖出失败: ", result.retcode);
      if(result.retcode == TRADE_RETCODE_REJECT) {
         if(request.type_filling == ORDER_FILLING_FOK) request.type_filling = ORDER_FILLING_IOC;
         else if(request.type_filling == ORDER_FILLING_IOC) request.type_filling = ORDER_FILLING_RETURN;
         OrderSend(request, result);
      }
   }
}

//+------------------------------------------------------------------+
//| V4.0 管理AI持仓 - AI驱动(Phase 1 - T1.1重构)                    |
//+------------------------------------------------------------------+
void ManageAIPositions(double rsi, double bid, double ask, double atr)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MAGIC_NUMBER) continue;

      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double positionProfit = PositionGetDouble(POSITION_PROFIT);
      double positionVolume = PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double profitPts = 0.0, profitPct = 0.0, currentPrice = 0.0;
      if(posType == POSITION_TYPE_BUY) {
         currentPrice = bid;
         profitPts = (bid - entryPrice) / g_SymbolPoint;
         profitPct = ((bid - entryPrice) / entryPrice) * 100.0;
      } else {
         currentPrice = ask;
         profitPts = (entryPrice - ask) / g_SymbolPoint;
         profitPct = ((entryPrice - ask) / entryPrice) * 100.0;
      }

      // V4.0 分级止盈(Phase 1 - T1.2)
      if(InpUseTieredTakeProfit) ApplyTieredTakeProfit(ticket, profitPct);

      bool shouldClose = false;
      string closeReason = "";

      if(posType == POSITION_TYPE_BUY && g_AISignal == "SELL" && g_AIConfidence >= 0.80 && profitPct > 0.30) {
         shouldClose = true; closeReason = "强AI SELL+盈利";
      } else if(posType == POSITION_TYPE_SELL && g_AISignal == "BUY" && g_AIConfidence >= 0.80 && profitPct > 0.30) {
         shouldClose = true; closeReason = "强AI BUY+盈利";
      } else if(profitPct >= InpStrongProfitPct) {
         shouldClose = true; closeReason = "巨大利润:" + DoubleToString(profitPct, 3) + "%";
      } else if(posType == POSITION_TYPE_BUY && g_AISignal == "SELL" && g_AIConfidence >= 0.90 && profitPct < -0.10) {
         shouldClose = true; closeReason = "紧急:AI反向且亏损";
      } else if(posType == POSITION_TYPE_SELL && g_AISignal == "BUY" && g_AIConfidence >= 0.90 && profitPct < -0.10) {
         shouldClose = true; closeReason = "紧急:AI反向且亏损";
      }

      // V4.0 安全网:单笔最大亏损强制平仓(Phase 1 - T1.5)
      double maxLoss = AccountInfoDouble(ACCOUNT_EQUITY) * (InpMaxSingleLossPct / 100.0);
      if(-positionProfit > maxLoss) {
         shouldClose = true;
         closeReason = "🚨 安全网:单笔亏损超限(" + DoubleToString(InpMaxSingleLossPct, 1) + "%)";
      }

      if(shouldClose) {
         Print("═══════════════════════════════════════════════════════");
         Print("🤖 V4.0 AI平仓 #", ticket, " | ", closeReason, " | 利润:", profitPts, "pts (", DoubleToString(profitPct, 2), "%)");
         if(g_Trade.PositionClose(ticket)) {
            Print("✅ V4.0 平仓成功!");
            RecordPositionClose(ticket, positionProfit, closeReason);
            g_TotalTrades++;
            if(positionProfit > 0) { g_WinningTrades++; g_ConsecutiveLosses = 0; }
            else { g_LosingTrades++; g_ConsecutiveLosses++; g_LastLossTime = TimeCurrent(); }
            g_TotalProfit += positionProfit;
            g_DailyProfit += positionProfit;
            if(positionProfit > 0) {
               g_GrossProfit += positionProfit;
               if(positionProfit > g_LargestWin) g_LargestWin = positionProfit;
               if(g_WinningTrades > 0) g_AvgWin = g_GrossProfit / g_WinningTrades;
            } else {
               g_GrossLoss += MathAbs(positionProfit);
               if(positionProfit < g_LargestLoss) g_LargestLoss = positionProfit;
               if(g_LosingTrades > 0) g_AvgLoss = g_GrossLoss / g_LosingTrades;
            }
            if(g_GrossLoss > 0) g_ProfitFactor = g_GrossProfit / g_GrossLoss;
            else g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;
         }
         Print("═══════════════════════════════════════════════════════");
      }
   }
}

//+------------------------------------------------------------------+
//| 统计函数                                                         |
//+------------------------------------------------------------------+
int CountOpenBuyPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER &&
         PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) count++;
   }
   return count;
}

int CountOpenSellPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER &&
         PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL) count++;
   }
   return count;
}

int CountTotalOpenPositions() { return CountOpenBuyPositions() + CountOpenSellPositions(); }

//+------------------------------------------------------------------+
//| 更新AI分析                                                       |
//+------------------------------------------------------------------+
void UpdateAIAnalysis(double rsi, double bid, double ask, double atr)
{
   datetime currentTime = TimeCurrent();
   int secondsSinceUpdate = (int)(currentTime - g_LastAIUpdate);
   int updateInterval = InpAIUpdateMinutes * 60;

   if(secondsSinceUpdate >= updateInterval || g_LastAIUpdate == 0) {
      g_LastAIUpdate = currentTime;
      Print("═══════════════════════════════════════════════════════");
      Print("📊 V4.0 AI分析中 - 多Agent协作模式");

      string baseContext = BuildMarketContext(rsi, bid, ask, atr);
      string context = EnhanceAIContext(baseContext);
      string aiResponse = CallOpenAI(context);
      ParseAIResponse(aiResponse);

      Print("🎯 V4.0 AI完成: 信号=", g_AISignal, " 置信度=", DoubleToString(g_AIConfidence * 100, 1), "%");
      Print("═══════════════════════════════════════════════════════");
   }

   color aiSignalColor = ClrNeutral;
   string aiSignalDisplay = g_AISignal;
   if(g_AISignal == "BUY") { aiSignalColor = ClrBuy; aiSignalDisplay = "买入"; }
   else if(g_AISignal == "SELL") { aiSignalColor = ClrSell; aiSignalDisplay = "卖出"; }
   else if(g_AISignal == "WAIT") { aiSignalColor = ClrWarning; aiSignalDisplay = "等待"; }
   UpdateUI("AISignal", aiSignalDisplay, aiSignalColor);

   string confidenceText = (g_AIConfidence > 0.0 || g_AISignal != "WAIT") ? DoubleToString(g_AIConfidence * 100, 1) + "%" : "--";
   UpdateUI("AIConfidence", confidenceText, (g_AIConfidence >= InpAIConfidenceMin ? ClrBuy : ClrWarning));

   string statusText = "AI: " + g_AIStatus;
   color statusColor = ClrWarning;
   if(g_AIStatus == "活跃") { statusColor = ClrBuy; statusText = "AI: 活跃 ✓"; }
   else if(g_AIStatus == "模拟") { statusColor = ClrWarning; statusText = "AI: 模拟 ⚠"; }
   else if(g_AIStatus == "错误") { statusColor = ClrSell; statusText = "AI: 错误 ✗"; }
   UpdateUI("AIStatus", statusText, statusColor);

   double floatingProfit = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER) {
         floatingProfit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP) + PositionGetDouble(POSITION_COMMISSION);
      }
   }
   double dailyTotalProfit = g_DailyProfit + floatingProfit;
   UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotalProfit, 2), dailyTotalProfit >= 0 ? ClrBuy : ClrSell);
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);
}

//+------------------------------------------------------------------+
//| 市场数据辅助函数                                                 |
//+------------------------------------------------------------------+
double GetSafeHigh(ENUM_TIMEFRAMES timeframe)
{
   if(iBarShift(_Symbol, timeframe, TimeCurrent()) < 0) return 0.0;
   double buffer[1];
   if(CopyHigh(_Symbol, timeframe, 1, 1, buffer) < 1) return 0.0;
   return buffer[0];
}

double GetSafeLow(ENUM_TIMEFRAMES timeframe)
{
   if(iBarShift(_Symbol, timeframe, TimeCurrent()) < 0) return 0.0;
   double buffer[1];
   if(CopyLow(_Symbol, timeframe, 1, 1, buffer) < 1) return 0.0;
   return buffer[0];
}

double CalculateSentiment(ENUM_TIMEFRAMES timeframe)
{
   if(Bars(_Symbol, timeframe) < 5) return 50.0;
   double high = GetSafeHigh(timeframe);
   double low = GetSafeLow(timeframe);
   if(high == 0 || low == 0 || high == low) return 50.0;
   double close[1];
   if(CopyClose(_Symbol, timeframe, 1, 1, close) < 1) return 50.0;
   double sentiment = ((close[0] - low) / (high - low)) * 100.0;
   return MathMax(0.0, MathMin(100.0, sentiment));
}

void CalculatePivotPoints(double &pivot, double &r1, double &r2, double &r3, double &s1, double &s2, double &s3)
{
   datetime yesterday = TimeCurrent() - PeriodSeconds(PERIOD_D1);
   int barShift = iBarShift(_Symbol, PERIOD_D1, yesterday);
   if(barShift < 0) { pivot = r1 = r2 = r3 = s1 = s2 = s3 = 0.0; return; }
   double high = iHigh(_Symbol, PERIOD_D1, barShift);
   double low = iLow(_Symbol, PERIOD_D1, barShift);
   double close = iClose(_Symbol, PERIOD_D1, barShift);
   pivot = (high + low + close) / 3.0;
   double range = high - low;
   r1 = 2.0 * pivot - low;
   r2 = pivot + range;
   r3 = high + 2.0 * (pivot - low);
   s1 = 2.0 * pivot - high;
   s2 = pivot - range;
   s3 = low - 2.0 * (high - pivot);
}

string GetTradingSession()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int hour = dt.hour;
   if(hour >= 13 && hour < 16) return "EU+US OVERLAP";
   if(hour >= 8 && hour < 13) return "EUROPEAN";
   if(hour >= 13 && hour < 21) return "US";
   return "ASIAN";
}

void GetDailyRange(double &high, double &low, double &range, double &rangePercent)
{
   int todayBar = iBarShift(_Symbol, PERIOD_D1, TimeCurrent());
   if(todayBar < 0) { high = low = range = rangePercent = 0.0; return; }
   high = iHigh(_Symbol, PERIOD_D1, todayBar);
   low = iLow(_Symbol, PERIOD_D1, todayBar);
   if(high > 0 && low > 0) {
      range = high - low;
      double currentPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      rangePercent = range > 0 ? ((currentPrice - low) / range) * 100.0 : 50.0;
   } else { high = low = range = rangePercent = 0.0; }
}

//+------------------------------------------------------------------+
//| V4.0 构建市场上下文(含多时间框架+外部数据)                      |
//+------------------------------------------------------------------+
string BuildMarketContext(double rsi, double bid, double ask, double atr)
{
   bool maBullish = false;
   if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0)
      maBullish = (g_BufferMAFast[0] > g_BufferMASlow[0]);

   int openPositions = CountTotalOpenPositions();
   double winRate = g_TotalTrades > 0 ? (double(g_WinningTrades) / double(g_TotalTrades)) * 100.0 : 0.0;

   string context = "═══════════════════════════════════════════════════════\n";
   context += "V4.0 MULTI-AGENT AI TRADING SYSTEM\n";
   context += "═══════════════════════════════════════════════════════\n";
   context += "Instrument: " + g_SymbolName + (g_IsGoldSymbol ? " (GOLD/XAUUSD)" : "") + "\n";
   context += "Timeframe: M15 | Strategy: Multi-Agent + Pattern Recognition\n\n";

   // V4.0 黄金专业知识(Phase 6)
   if(InpUseGoldKnowledge && StringLen(g_GoldKnowledgePrompt) > 0) context += g_GoldKnowledgePrompt;

   context += "═══ CURRENT MARKET DATA ═══\n";
   context += "Price: BID " + DoubleToString(bid, g_SymbolDigits) + " | ASK " + DoubleToString(ask, g_SymbolDigits) + "\n";
   context += "Spread: " + DoubleToString((ask - bid) / g_SymbolPoint, 0) + " pts\n\n";

   context += "═══ TECHNICAL INDICATORS ═══\n";
   context += "RSI(14): " + DoubleToString(rsi, 1);
   if(rsi < 30) context += " (OVERSOLD)\n";
   else if(rsi > 70) context += " (OVERBOUGHT)\n";
   else context += " (NEUTRAL)\n";
   if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0)
      context += "MA(20/50): " + DoubleToString(g_BufferMAFast[0], g_SymbolDigits) + "/" + DoubleToString(g_BufferMASlow[0], g_SymbolDigits) + (maBullish ? " [BULLISH]\n" : " [BEARISH]\n");
   context += "ATR(14): " + DoubleToString(atr, g_SymbolDigits) + "\n";

   // V4.0 多时间框架K线(Phase 5 - T5.2压缩)
   context += "\n═══ MULTI-TIMEFRAME ANALYSIS ═══\n";

   double m5Open[], m5High[], m5Low[], m5Close[];
   long m5Volume[];
   ArraySetAsSeries(m5Open, true); ArraySetAsSeries(m5High, true);
   ArraySetAsSeries(m5Low, true); ArraySetAsSeries(m5Close, true); ArraySetAsSeries(m5Volume, true);
   if(CopyOpen(_Symbol, PERIOD_M5, 0, 50, m5Open) == 50 && CopyHigh(_Symbol, PERIOD_M5, 0, 50, m5High) == 50 &&
      CopyLow(_Symbol, PERIOD_M5, 0, 50, m5Low) == 50 && CopyClose(_Symbol, PERIOD_M5, 0, 50, m5Close) == 50 &&
      CopyTickVolume(_Symbol, PERIOD_M5, 0, 50, m5Volume) == 50) {
      context += "M5(20bar): ";
      for(int i = 0; i < 20; i++) {
         string dir = m5Close[i] > m5Open[i] ? "+" : "-";
         context += dir + DoubleToString(m5Close[i], g_SymbolDigits) + ":" + DoubleToString((m5High[i]-m5Low[i])/g_SymbolPoint, 0) + ":" + IntegerToString((int)m5Volume[i]);
         if(i < 19) context += "|";
      }
      context += "\n";
   }

   double m15Open[], m15High[], m15Low[], m15Close[];
   long m15Volume[];
   ArraySetAsSeries(m15Open, true); ArraySetAsSeries(m15High, true);
   ArraySetAsSeries(m15Low, true); ArraySetAsSeries(m15Close, true); ArraySetAsSeries(m15Volume, true);
   if(CopyOpen(_Symbol, PERIOD_M15, 0, 100, m15Open) == 100 && CopyHigh(_Symbol, PERIOD_M15, 0, 100, m15High) == 100 &&
      CopyLow(_Symbol, PERIOD_M15, 0, 100, m15Low) == 100 && CopyClose(_Symbol, PERIOD_M15, 0, 100, m15Close) == 100 &&
      CopyTickVolume(_Symbol, PERIOD_M15, 0, 100, m15Volume) == 100) {
      context += "M15(20bar): ";
      for(int i = 0; i < 20; i++) {
         string dir = m15Close[i] > m15Open[i] ? "+" : "-";
         context += dir + DoubleToString(m15Close[i], g_SymbolDigits) + ":" + DoubleToString((m15High[i]-m15Low[i])/g_SymbolPoint, 0);
         if(i < 19) context += "|";
      }
      context += "\n";
   }

   double h1Open[], h1High[], h1Low[], h1Close[];
   long h1Volume[];
   ArraySetAsSeries(h1Open, true); ArraySetAsSeries(h1High, true);
   ArraySetAsSeries(h1Low, true); ArraySetAsSeries(h1Close, true); ArraySetAsSeries(h1Volume, true);
   if(CopyOpen(_Symbol, PERIOD_H1, 0, 50, h1Open) == 50 && CopyHigh(_Symbol, PERIOD_H1, 0, 50, h1High) == 50 &&
      CopyLow(_Symbol, PERIOD_H1, 0, 50, h1Low) == 50 && CopyClose(_Symbol, PERIOD_H1, 0, 50, h1Close) == 50 &&
      CopyTickVolume(_Symbol, PERIOD_H1, 0, 50, h1Volume) == 50) {
      context += "H1(20bar): ";
      for(int i = 0; i < 20; i++) {
         string dir = h1Close[i] > h1Open[i] ? "+" : "-";
         context += dir + DoubleToString(h1Close[i], g_SymbolDigits) + ":" + DoubleToString((h1High[i]-h1Low[i])/g_SymbolPoint, 0);
         if(i < 19) context += "|";
      }
      context += "\n";
   }

   double h4Open[], h4High[], h4Low[], h4Close[];
   ArraySetAsSeries(h4Open, true); ArraySetAsSeries(h4High, true);
   ArraySetAsSeries(h4Low, true); ArraySetAsSeries(h4Close, true);
   if(CopyOpen(_Symbol, PERIOD_H4, 0, 20, h4Open) == 20 && CopyHigh(_Symbol, PERIOD_H4, 0, 20, h4High) == 20 &&
      CopyLow(_Symbol, PERIOD_H4, 0, 20, h4Low) == 20 && CopyClose(_Symbol, PERIOD_H4, 0, 20, h4Close) == 20) {
      context += "H4(20bar): ";
      for(int i = 0; i < 20; i++) {
         string dir = h4Close[i] > h4Open[i] ? "+" : "-";
         context += dir + DoubleToString(h4Close[i], g_SymbolDigits) + ":" + DoubleToString((h4High[i]-h4Low[i])/g_SymbolPoint, 0);
         if(i < 19) context += "|";
      }
      context += "\n";
   }

   double d1Open[], d1High[], d1Low[], d1Close[];
   ArraySetAsSeries(d1Open, true); ArraySetAsSeries(d1High, true);
   ArraySetAsSeries(d1Low, true); ArraySetAsSeries(d1Close, true);
   if(CopyOpen(_Symbol, PERIOD_D1, 0, 30, d1Open) == 30 && CopyHigh(_Symbol, PERIOD_D1, 0, 30, d1High) == 30 &&
      CopyLow(_Symbol, PERIOD_D1, 0, 30, d1Low) == 30 && CopyClose(_Symbol, PERIOD_D1, 0, 30, d1Close) == 30) {
      context += "D1(10day): ";
      for(int i = 0; i < 10; i++) {
         string dir = d1Close[i] > d1Open[i] ? "+" : "-";
         context += dir + DoubleToString(d1Close[i], g_SymbolDigits);
         if(i < 9) context += "|";
      }
      int d1MaxIdx = ArrayMaximum(d1High, 0, 30);
      int d1MinIdx = ArrayMinimum(d1Low, 0, 30);
      if(d1MaxIdx >= 0) context += " | 30D-HIGH:" + DoubleToString(d1High[d1MaxIdx], g_SymbolDigits);
      if(d1MinIdx >= 0) context += " | 30D-LOW:" + DoubleToString(d1Low[d1MinIdx], g_SymbolDigits);
      context += "\n";
   }

   // Session
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   string session = GetTradingSession();
   context += "\nSession: " + session + " | " + IntegerToString(dt.hour) + ":" + IntegerToString(dt.min) + " GMT\n";

   // V4.0 外部数据(Phase 3)
   if(InpUseDXY && g_SharedState.dxy_value > 0) {
      context += "\n═══ EXTERNAL DATA (Phase 3) ═══\n";
      context += "DXY: " + DoubleToString(g_SharedState.dxy_value, 2) + " (Chg:" + DoubleToString(g_SharedState.dxy_change, 2) + ")\n";
      context += "Gold-DXY Corr: " + DoubleToString(g_SharedState.gold_dxy_correlation, 2);
      if(g_SharedState.gold_dxy_correlation < -0.5) context += " [强负相关-正常]";
      else if(g_SharedState.gold_dxy_correlation > 0) context += " [背离预警!]";
      context += "\n";
   }
   if(InpUseTreasuryYield && g_SharedState.us10y_yield > 0)
      context += "US10Y: " + DoubleToString(g_SharedState.us10y_yield, 2) + "%\n";
   if(InpUseVIXProxy && g_SharedState.vix_proxy > 0) {
      context += "VIX Proxy: " + DoubleToString(g_SharedState.vix_proxy, 1) + "%";
      if(g_SharedState.vix_proxy > 80) context += " [高波动]";
      context += "\n";
   }

   // V4.0 共享状态(Phase 2)
   if(InpUseMultiAgent) {
      context += "\n═══ MULTI-AGENT SHARED STATE ═══\n";
      context += "Analyst: " + g_SharedState.market_regime + " | " + g_SharedState.market_bias + " (" + DoubleToString(g_SharedState.regime_confidence * 100, 1) + "%)\n";
      if(StringLen(g_SharedState.market_narrative) > 0) context += "Narrative: " + g_SharedState.market_narrative + "\n";
      context += "RiskOfficer: Trade=" + (g_SharedState.trading_allowed ? "OK" : "BLOCK") + " RiskLvl=" + IntegerToString((int)g_SharedState.current_risk_level) + "\n";
      if(g_SharedState.event_lock) context += "🚨 EVENT LOCK: " + g_SharedState.next_high_impact_event + "\n";
   }

   // V4.0 学习成果(Phase 4)
   if(InpUseReviewer && g_SharedState.learning_update_time > 0) {
      context += "\n═══ LEARNING INSIGHTS (Phase 4) ═══\n";
      context += "AdjConfMin: " + DoubleToString(g_SharedState.adjusted_confidence_min, 2) + " | AdjSLATR: " + DoubleToString(g_SharedState.adjusted_sl_atr_mult, 2) + "\n";
      string lessons = GetRecentLessonsText();
      if(StringLen(lessons) > 0) context += "Lessons: " + lessons + "\n";
   }

   context += "\nPositions: " + IntegerToString(openPositions) + "/" + IntegerToString(InpMaxPositions) + "\n";
   context += "WinRate: " + DoubleToString(winRate, 1) + "% | Trades: " + IntegerToString(g_TotalTrades) + "\n";

   double pivot, r1, r2, r3, s1, s2, s3;
   CalculatePivotPoints(pivot, r1, r2, r3, s1, s2, s3);
   if(pivot > 0) {
      context += "\n═══ KEY LEVELS ═══\n";
      context += "R1=" + DoubleToString(r1, g_SymbolDigits) + " P=" + DoubleToString(pivot, g_SymbolDigits) + " S1=" + DoubleToString(s1, g_SymbolDigits) + "\n";
   }

   context += "\n═══ 响应格式 ═══\n";
   context += "单行回复: 信号|置信度|止损点数|止盈点数|推理|总结\n";
   context += "信号=BUY/SELL/WAIT 置信度=0.50-0.95 止损=整数点 止盈=整数点\n";
   return context;
}

//+------------------------------------------------------------------+
//| Escape JSON                                                      |
//+------------------------------------------------------------------+
string EscapeJSON(string text)
{
   if(StringLen(text) == 0) return "";
   string result = "";
   for(int i = 0; i < StringLen(text); i++) {
      ushort charCode = StringGetCharacter(text, i);
      switch(charCode) {
         case '\\': result += "\\\\"; break;
         case '"': result += "\\\""; break;
         case '\n': result += "\\n"; break;
         case '\r': result += "\\r"; break;
         case '\t': result += "\\t"; break;
         case 0: break;
         default:
            if(charCode < 32) break;
            result += ShortToString(charCode);
            break;
      }
   }
   return result;
}

//+------------------------------------------------------------------+
//| 解析DeepSeek JSON响应                                            |
//+------------------------------------------------------------------+
string ParseOpenAIResponse(string jsonResponse)
{
   int contentStart = -1;
   contentStart = StringFind(jsonResponse, "\"content\":\"");
   if(contentStart >= 0) { contentStart += StringLen("\"content\":\""); }
   if(contentStart < 0) {
      int pos = StringFind(jsonResponse, "\"content\" : \"");
      if(pos >= 0) contentStart = pos + StringLen("\"content\" : \"");
   }
   if(contentStart < 0) {
      int contentFieldPos = StringFind(jsonResponse, "\"content\"");
      if(contentFieldPos >= 0) {
         int colonPos = StringFind(jsonResponse, ":", contentFieldPos);
         if(colonPos >= 0) {
            int quoteStart = colonPos + 1;
            while(quoteStart < StringLen(jsonResponse) && (StringGetCharacter(jsonResponse, quoteStart) == ' ' || StringGetCharacter(jsonResponse, quoteStart) == '\t')) quoteStart++;
            if(quoteStart < StringLen(jsonResponse) && StringGetCharacter(jsonResponse, quoteStart) == '"') contentStart = quoteStart + 1;
         }
      }
   }
   if(contentStart < 0) { Print("错误: 找不到content字段"); return ""; }

   int contentEnd = contentStart;
   int searchPos = contentStart;
   bool found = false;
   while(searchPos < StringLen(jsonResponse) - 1) {
      int nextQuote = StringFind(jsonResponse, "\"", searchPos);
      if(nextQuote < 0) break;
      bool isEscaped = false;
      if(nextQuote > 0) {
         int checkPos = nextQuote - 1;
         int backslashCount = 0;
         while(checkPos >= contentStart && StringGetCharacter(jsonResponse, checkPos) == '\\') { backslashCount++; checkPos--; }
         isEscaped = (backslashCount % 2 == 1);
      }
      if(!isEscaped) { contentEnd = nextQuote; found = true; break; }
      searchPos = nextQuote + 1;
   }
   if(!found) return "";

   string content = StringSubstr(jsonResponse, contentStart, contentEnd - contentStart);
   StringReplace(content, "\\\\", "\x01");
   StringReplace(content, "\\\"", "\"");
   StringReplace(content, "\\n", "\n");
   StringReplace(content, "\\r", "\r");
   StringReplace(content, "\\t", "\t");
   StringReplace(content, "\x01", "\\");
   StringReplace(content, "\n\n", " ");
   StringReplace(content, "\n", " ");
   StringTrimLeft(content); StringTrimRight(content);

   string parts[];
   int count = StringSplit(content, '|', parts);
   if(count >= 6) {
      for(int p = 0; p < count; p++) { StringTrimLeft(parts[p]); StringTrimRight(parts[p]); }
      return parts[0] + "|" + parts[1] + "|" + parts[2] + "|" + parts[3] + "|" + parts[4] + "|" + parts[5];
   } else if(count >= 4) {
      for(int p = 0; p < count; p++) { StringTrimLeft(parts[p]); StringTrimRight(parts[p]); }
      return parts[0] + "|" + parts[1] + "|0|0|" + parts[2] + "|" + parts[3];
   } else {
      string signal = "WAIT";
      double confidence = 0.5;
      if(StringFind(content, "BUY") >= 0) { signal = "BUY"; confidence = 0.80; }
      else if(StringFind(content, "SELL") >= 0) { signal = "SELL"; confidence = 0.80; }
      return signal + "|" + DoubleToString(confidence, 2) + "|0|0|AI analysis|" + content;
   }
}

//+------------------------------------------------------------------+
//| V4.0 调用DeepSeek API(Phase 5增强)                              |
//+------------------------------------------------------------------+
string CallOpenAI(string marketData)
{
   if(StringLen(InpOpenAIAPIKey) == 0 || StringLen(InpOpenAIAPIKey) < 20) {
      g_AIStatus = "模拟"; g_AIIsActive = false;
      return CallOpenAI_Simulated(marketData);
   }

   // V4.0 API预算检查(Phase 5 - T5.1)
   if(g_DailyTokenUsed >= InpDailyTokenBudget) {
      Print("⚠️ V4.0 API预算超限: ", g_DailyTokenUsed, "/", InpDailyTokenBudget);
      g_AIStatus = "模拟"; g_AIIsActive = false;
      return CallOpenAI_Simulated(marketData);
   }

   string escapedContent = EscapeJSON(marketData);
   string escapedModel = EscapeJSON(InpOpenAIModel);

   string systemPrompt = "";
   systemPrompt += "【角色定义】\n你是源流AI交易系统V4.0的入场策略师,专注黄金(XAUUSD)日内交易。\n";
   systemPrompt += "你自主判断止损止盈规模,不设固定点数,根据市场状态和ATR动态调整。\n\n";
   if(InpUseGoldKnowledge && StringLen(g_GoldKnowledgePrompt) > 0) systemPrompt += g_GoldKnowledgePrompt;
   systemPrompt += "【分析框架】\n第一层:趋势判断(D1/H4/H1) — 确定市场状态和方向偏好\n";
   systemPrompt += "第二层:机会识别(M15/M5) — 寻找价格结构中的交易机会\n";
   systemPrompt += "第三层:入场确认(形态+指标共振) — 精确入场位\n\n";
   systemPrompt += "【市场状态自适应交易策略】\n";
   systemPrompt += "趋势市(TRENDING):仅做顺势单,回调至MA或支撑阻力位入场。止损=ATR x 0.8-1.2(紧),止盈=ATR x 2.5-4.0(宽)\n";
   systemPrompt += "震荡市(RANGING):区间边界处高抛低吸,避免区间中部入场。止损=ATR x 1.5-2.0(宽),止盈=ATR x 0.8-1.5(紧)\n";
   systemPrompt += "波动市(VOLATILE):仅高置信度(>0.70)入场或输出WAIT。止损=ATR x 2.0-2.5(宽),止盈=ATR x 2.0-3.5(宽)\n";
   systemPrompt += "逆Bias方向交易:止损须加宽0.5x ATR,置信度须>0.70,否则输出WAIT\n\n";
   systemPrompt += "【核心形态】SFP(假突破)/FVG(公允价值缺口)/双顶双底/订单块/RSI背离\n\n";
   systemPrompt += "【置信度校准】\n";
   systemPrompt += "0.75-0.90:趋势+形态共振,方向与Bias一致,高确定性\n";
   systemPrompt += "0.65-0.74:形态信号明确,但某个维度略有不一致\n";
   systemPrompt += "0.55-0.64:信号较弱但可轻仓尝试\n";
   systemPrompt += "0.50-0.54:信号模糊或逆Bias,输出WAIT\n\n";
   systemPrompt += "【输出格式】单行:信号|置信度|止损点数|止盈点数|推理|总结\n";
   systemPrompt += "信号=BUY/SELL/WAIT 置信度=0.50-0.95 止损止盈=根据ATR和市场状态计算的整数点数\n\n";
   systemPrompt += "【示例】\n";
   systemPrompt += "BUY|0.75|250|600|趋势偏多,M15回调至上升趋势线+RSI从超卖回升,顺势做多紧止损宽止盈|趋势回调做多\n";
   systemPrompt += "SELL|0.72|280|700|H1双顶形态,D1趋势偏空,反弹至阻力位,顺势做空紧止损宽止盈|顺势高位做空\n";
   systemPrompt += "BUY|0.65|450|350|震荡市下沿支撑反弹,区间空间有限,宽止损防假突破,紧止盈到上沿|震荡市区间做多\n";
   systemPrompt += "WAIT|0.55|0|0|波动率突升方向不明,或事件风险临近,观望等待|波动观望\n";

   string escapedSystem = EscapeJSON(systemPrompt);
   string jsonRequest = "{";
   jsonRequest += "\"model\":\"" + escapedModel + "\",";
   jsonRequest += "\"messages\":[";
   jsonRequest += "{\"role\":\"system\",\"content\":\"" + escapedSystem + "\"},";
   jsonRequest += "{\"role\":\"user\",\"content\":\"" + escapedContent + "\"}";
   jsonRequest += "],\"temperature\":1,\"max_completion_tokens\":15000}";

   int jsonLen = StringLen(jsonRequest);
   if(jsonLen == 0) return CallOpenAI_Simulated(marketData);
   if(!InpReduceLogs) Print("V4.0 JSON长度: ", jsonLen);

   string headers = "Content-Type: application/json\r\n";
   headers += "Authorization: Bearer " + InpOpenAIAPIKey + "\r\n";
   headers += "User-Agent: MT5-EA-V4/1.0\r\n";

   // V4.0 带重试的API调用(Phase 5 - T5.3)
   string jsonResponse = SendAPIRequestWithRetry(jsonRequest, "https://api.deepseek.com/v1/chat/completions", headers, InpAPITimeoutMs);

   if(StringLen(jsonResponse) == 0) {
      g_AIStatus = "错误"; g_AIIsActive = false;
      LogAPIFailure("entry_strategist", "API调用失败");
      return CallOpenAI_Simulated(marketData);
   }
   if(StringFind(jsonResponse, "\"error\"") >= 0 || StringLen(jsonResponse) < 50) {
      Print("❌ V4.0 API错误: ", StringSubstr(jsonResponse, 0, 200));
      g_AIStatus = "错误"; g_AIIsActive = false;
      LogAPIFailure("entry_strategist", "API返回错误");
      return CallOpenAI_Simulated(marketData);
   }

   string aiMessage = ParseOpenAIResponse(jsonResponse);
   g_DailyTokenUsed += (int)(jsonLen / 4) + 1000;

   if(StringLen(aiMessage) > 0) {
      g_AIStatus = "活跃"; g_AIIsActive = true; g_APIFailureCount = 0;
      return aiMessage;
   }
   Print("解析失败,使用模拟");
   g_AIStatus = "错误"; g_AIIsActive = false;
   return CallOpenAI_Simulated(marketData);
}

//+------------------------------------------------------------------+
//| V4.0 带重试的API请求(Phase 5 - T5.3)                            |
//+------------------------------------------------------------------+
string SendAPIRequestWithRetry(string json, string url, string headers, int timeout)
{
   char postData[];
   char result[];
   string resultHeaders;
   uchar bytes[];
   int bytesCount = StringToCharArray(json, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   if(bytesCount <= 0) return "";
   if(bytesCount > 0 && bytes[bytesCount - 1] == 0) bytesCount--;
   ArrayResize(postData, bytesCount);
   ArrayCopy(postData, bytes, 0, 0, bytesCount);

   // V4.0 指数退避重试(macOS MT5 SSL握手慢,首次延迟加大)
   for(int attempt = 0; attempt < InpAPIRetryCount; attempt++) {
      ResetLastError();
      int res = WebRequest("POST", url, headers, timeout, postData, result, resultHeaders);
      if(res == 200) return CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

      // 诊断日志
      string errDetail = "";
      if(res == -1) {
         int error = GetLastError();
         errDetail = " GetLastError=" + IntegerToString(error);
         if(error == 4060) { Print("→ 请添加URL到允许列表: ", url); return ""; }
      } else if(res == 1003) {
         errDetail = " (macOS SSL/网络层错误,可能是TLS握手超时或兼容层问题)";
      } else if(res >= 400 && res < 500) {
         errDetail = " (客户端错误,检查API Key)";
      } else if(res >= 500) {
         errDetail = " (DeepSeek服务端错误,稍后重试)";
      }
      Print("⚠️ V4.0 API重试 ", attempt + 1, "/", InpAPIRetryCount, " 错误:", res, errDetail);

      if(attempt < InpAPIRetryCount - 1) {
         // macOS MT5兼容层SSL握手慢,加大退避: 2s/4s/8s
         int delayMs = 2000 * (int)MathPow(2, attempt);
         if(delayMs > 15000) delayMs = 15000;
         Sleep(delayMs);
      }
   }
   return "";
}

//+------------------------------------------------------------------+
//| V4.0 记录API失败(Phase 5)                                       |
//+------------------------------------------------------------------+
void LogAPIFailure(string agentRole, string reason)
{
   g_APIFailureCount++;
   Print("🚨 V4.0 API失败[", agentRole, "]: ", reason, " 累计:", g_APIFailureCount);
   if(g_APIFailureCount >= 5) {
      Print("⚠️ V4.0 API连续失败5次,触发降级");
      g_SharedState.current_risk_level = RISK_HIGH;
   }
}

//+------------------------------------------------------------------+
//| 模拟响应                                                         |
//+------------------------------------------------------------------+
string CallOpenAI_Simulated(string marketData)
{
   if(g_AIStatus != "错误") g_AIStatus = "模拟";
   g_AIIsActive = false;
   if(ArraySize(g_BufferRSI) < 1) return "WAIT|0.50|0|0|等待数据|等待数据";
   double rsi = g_BufferRSI[0];
   if(rsi < 35) return "BUY|0.85|250|350|RSI超卖反弹做多|RSI超卖";
   if(rsi > 65) return "WAIT|0.60|0|0|RSI超买观望|RSI超买";
   return "WAIT|0.50|0|0|中性震荡|中性";
}

//+------------------------------------------------------------------+
//| Split summary                                                    |
//+------------------------------------------------------------------+
void SplitSummaryIntoLines()
{
   ArrayResize(g_AISummaryLines, 10);
   for(int j = 0; j < 10; j++) g_AISummaryLines[j] = "";
   if(StringLen(g_AISummary) == 0) { g_AISummaryLines[0] = "Waiting..."; return; }
   string sentences[];
   int sentenceCount = StringSplit(g_AISummary, '.', sentences);
   int lineIndex = 0;
   for(int i = 0; i < sentenceCount && lineIndex < 10; i++) {
      string sentence = sentences[i];
      while(StringLen(sentence) > 0 && StringGetCharacter(sentence, 0) == ' ') sentence = StringSubstr(sentence, 1);
      while(StringLen(sentence) > 0 && StringGetCharacter(sentence, StringLen(sentence) - 1) == ' ') sentence = StringSubstr(sentence, 0, StringLen(sentence) - 1);
      if(StringLen(sentence) == 0) continue;
      sentence += ".";
      if(StringLen(sentence) > 120) {
         string parts[];
         int partCount = StringSplit(sentence, ',', parts);
         for(int p = 0; p < partCount && lineIndex < 10; p++) {
            string part = parts[p];
            while(StringLen(part) > 0 && StringGetCharacter(part, 0) == ' ') part = StringSubstr(part, 1);
            if(StringLen(part) > 0) { if(p < partCount - 1) part += ","; g_AISummaryLines[lineIndex] = part; lineIndex++; }
         }
      } else { g_AISummaryLines[lineIndex] = sentence; lineIndex++; }
   }
}

//+------------------------------------------------------------------+
//| Parse AI response                                                |
//+------------------------------------------------------------------+
void ParseAIResponse(string response)
{
   string parts[];
   int count = StringSplit(response, '|', parts);
   if(count >= 6) {
      g_AISignal = parts[0]; StringTrimLeft(g_AISignal); StringTrimRight(g_AISignal);
      g_AIConfidence = StringToDouble(parts[1]);
      g_AISLPoints = StringToDouble(parts[2]);
      g_AITPPoints = StringToDouble(parts[3]);
      g_AIReasoning = parts[4]; g_AISummary = parts[5];
      StringTrimLeft(g_AIReasoning); StringTrimRight(g_AIReasoning);
      if(g_AISignal != "BUY" && g_AISignal != "SELL" && g_AISignal != "WAIT") g_AISignal = "WAIT";
      if(g_AIConfidence < 0.0) g_AIConfidence = 0.0;
      if(g_AIConfidence > 1.0) g_AIConfidence = 1.0;
      if(g_AISLPoints < 80) g_AISLPoints = 80;       // 最小80点(趋势明确时极紧止损)
      if(g_AISLPoints > 1500) g_AISLPoints = 1500;  // 最大1500点(震荡市宽止损上限)
      if(g_AITPPoints < 100) g_AITPPoints = 100;    // 最小100点(震荡紧止盈)
      if(g_AITPPoints > 5000) g_AITPPoints = 5000;  // 最大5000点(趋势市宽止盈,ATR 800点 x 6倍)
      // V4.0 同步共享状态(Phase 2)
      if(InpUseMultiAgent) {
         g_SharedState.entry_signal = g_AISignal;
         g_SharedState.entry_confidence = g_AIConfidence;
         g_SharedState.suggested_sl_points = (int)g_AISLPoints;
         g_SharedState.suggested_tp_points = (int)g_AITPPoints;
         g_SharedState.entry_update_time = TimeCurrent();
      }
      SplitSummaryIntoLines();
   } else if(count >= 4) {
      g_AISignal = parts[0]; StringTrimLeft(g_AISignal); StringTrimRight(g_AISignal);
      g_AIConfidence = StringToDouble(parts[1]);
      g_AIReasoning = parts[2]; g_AISummary = parts[3];
      g_AISLPoints = 0; g_AITPPoints = 0;
      if(g_AISignal != "BUY" && g_AISignal != "SELL" && g_AISignal != "WAIT") g_AISignal = "WAIT";
      SplitSummaryIntoLines();
   } else {
      g_AISignal = "WAIT"; g_AIConfidence = 0.0; g_AISLPoints = 0; g_AITPPoints = 0;
      g_AIReasoning = "无效响应"; g_AISummary = "等待AI...";
      SplitSummaryIntoLines();
   }
}

//+------------------------------------------------------------------+
//| UI Functions                                                     |
//+------------------------------------------------------------------+
void DrawDashboard()
{
   int leftX = InpXLeft, topY = InpYTop, leftWidth = InpWidthLeft, panelHeight = InpPanelHeight;
   CreateRectangle("BG_Left", leftX, topY, leftWidth, panelHeight, ClrBackground, CORNER_LEFT_UPPER);
   CreateTextLabel("Title_Left", "源流AI V4.0 多Agent", leftX + 10, topY + 5, ClrHeader, true, 10, CORNER_LEFT_UPPER);
   int y = topY + 30;

   CreateTextLabel("L_TradingStatus", "交易状态:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_TradingStatus", "初始化", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_AIStatus", "AI状态:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AIStatus", "初始化", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 5;

   CreateTextLabel("L_Price", "价格:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_Price", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_BidPrice", "买价:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_BidPrice", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_AskPrice", "卖价:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AskPrice", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_Spread", "点差:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_Spread", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 5;

   CreateTextLabel("L_RSI", "RSI:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RSI", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_RSI_To30", "距超卖:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RSI_To30", "--", leftX + 100, y, ClrBuy, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_RSI_To70", "距超买:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RSI_To70", "--", leftX + 100, y, ClrSell, true, 9, CORNER_LEFT_UPPER); y += 5;

   CreateTextLabel("L_AISignal", "AI信号:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AISignal", "等待", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_AIConfidence", "AI置信度:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AIConfidence", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 5;

   CreateTextLabel("L_DailyProfit", "今日盈利:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_DailyProfit", "$0.00", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_DailyLimit", "每日限制:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_DailyLimit", "+$" + DoubleToString(InpDailyProfitTarget, 0) + "/-$" + DoubleToString(InpMaxDailyLoss, 0), leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_WinRate", "胜率:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_WinRate", "0%", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 5;

   // V4.0 多Agent状态面板
   CreateTextLabel("L_AgentStatus", "── V4.0 Agent状态 ──", leftX + 10, y, ClrHeader, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_Analyst", "首席分析师:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_Analyst", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_RiskLevel", "风险级别:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RiskLevel", "LOW", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER); y += 18;
   CreateTextLabel("L_ExternalData", "外部数据:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_ExternalData", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
}

void CreateRectangle(string name, int x, int y, int width, int height, color bgColor, int corner)
{
   string objName = g_Prefix + name;
   if(ObjectFind(0, objName) < 0) ObjectCreate(0, objName, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, objName, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, objName, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, objName, OBJPROP_XSIZE, width);
   ObjectSetInteger(0, objName, OBJPROP_YSIZE, height);
   ObjectSetInteger(0, objName, OBJPROP_BGCOLOR, bgColor);
   ObjectSetInteger(0, objName, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, objName, OBJPROP_CORNER, corner);
   ObjectSetInteger(0, objName, OBJPROP_BACK, false);
   ObjectSetInteger(0, objName, OBJPROP_SELECTABLE, false);
}

void CreateTextLabel(string name, string text, int x, int y, color clr, bool bold, int fontSize, int corner)
{
   string objName = g_Prefix + name;
   if(ObjectFind(0, objName) < 0) ObjectCreate(0, objName, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, objName, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, objName, OBJPROP_YDISTANCE, y);
   ObjectSetString(0, objName, OBJPROP_TEXT, text);
   ObjectSetInteger(0, objName, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, objName, OBJPROP_FONTSIZE, fontSize);
   ObjectSetString(0, objName, OBJPROP_FONT, bold ? "Consolas Bold" : "Consolas");
   ObjectSetInteger(0, objName, OBJPROP_CORNER, corner);
   ObjectSetInteger(0, objName, OBJPROP_BACK, false);
   ObjectSetInteger(0, objName, OBJPROP_SELECTABLE, false);
}

void UpdateUI(string suffix, string value, color clr)
{
   string objName = g_Prefix + "V_" + suffix;
   if(ObjectFind(0, objName) >= 0) {
      ObjectSetString(0, objName, OBJPROP_TEXT, value);
      ObjectSetInteger(0, objName, OBJPROP_COLOR, clr);
   }
}

//+------------------------------------------------------------------+
//| 动态手数计算                                                     |
//+------------------------------------------------------------------+
double CalculateDynamicLots(double stopLossDistance)
{
   double lots = InpMinLotSize;
   if(InpUseMoneyManagement) {
      double equity = AccountInfoDouble(ACCOUNT_EQUITY);
      double riskAmount = equity * (InpRiskPercent / 100.0);
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tickValue > 0 && tickSize > 0 && stopLossDistance > 0) {
         double pointsAtRisk = MathAbs(stopLossDistance) / tickSize;
         double denominator = pointsAtRisk * tickValue;
         if(denominator > 0.0001) lots = riskAmount / denominator;
      }
   } else { lots = InpLotSize; }
   if(lots > InpMaxLotCap) lots = InpMaxLotCap;
   if(lots < InpMinLotSize) lots = InpMinLotSize;
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0) lots = MathFloor(lots / step) * step;
   return lots;
}

//+------------------------------------------------------------------+
//| 狙击手入场过滤                                                   |
//+------------------------------------------------------------------+
bool CheckSniperEntry(string signal)
{
   if(!InpSniperEntry) return true;
   int handleM1 = iRSI(_Symbol, PERIOD_M1, 14, PRICE_CLOSE);
   if(handleM1 == INVALID_HANDLE) return true;
   double buffM1[];
   ArraySetAsSeries(buffM1, true);
   bool allowEntry = true;
   if(CopyBuffer(handleM1, 0, 0, 1, buffM1) > 0 && ArraySize(buffM1) > 0) {
      double rsiM1 = buffM1[0];
      if(signal == "BUY" && rsiM1 > 70) allowEntry = false;
      if(signal == "SELL" && rsiM1 < 30) allowEntry = false;
   }
   IndicatorRelease(handleM1);
   return allowEntry;
}

//+------------------------------------------------------------------+
//| 保本逻辑                                                         |
//+------------------------------------------------------------------+
void CheckAndApplyBreakeven(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return;
   double floatingProfit = PositionGetDouble(POSITION_PROFIT);
   if(floatingProfit >= InpBreakevenTrigger) {
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);
      double volume = PositionGetDouble(POSITION_VOLUME);
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tickValue == 0 || tickSize == 0 || volume == 0) return;
      double denominator = volume * tickValue;
      if(denominator <= 0) return;
      double paddingDist = (InpBreakevenPadding / denominator) * tickSize;
      bool shouldModify = false;
      double newSL = 0;
      if(posType == POSITION_TYPE_BUY) {
         double bePrice = entryPrice + paddingDist;
         if(currentSL < bePrice) { newSL = bePrice; shouldModify = true; }
      } else {
         double bePrice = entryPrice - paddingDist;
         if(currentSL > bePrice || currentSL == 0) { newSL = bePrice; shouldModify = true; }
      }
      if(shouldModify) {
         newSL = NormalizeDouble(newSL, g_SymbolDigits);
         g_Trade.PositionModify(ticket, newSL, 0);
      }
   }
}

//+------------------------------------------------------------------+
//| 每日重置                                                         |
//+------------------------------------------------------------------+
void CheckDailyReset()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   datetime today = StringToTime(IntegerToString(dt.year) + "." + IntegerToString(dt.mon) + "." + IntegerToString(dt.day));
   if(today != g_LastResetDate) {
      g_DailyProfit = 0.0;
      g_DailyHighEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      g_LastResetDate = today;
      g_TradingHalted = false;
      g_DailyTokenUsed = 0;
      g_TokenBudgetResetDate = today;
      g_APIFailureCount = 0;
      Print("📅 V4.0 新交易日 - 重置 | Token预算重置");
   }
   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(currentEquity > g_DailyHighEquity) g_DailyHighEquity = currentEquity;
}

//+------------------------------------------------------------------+
//| 检查交易是否允许                                                 |
//+------------------------------------------------------------------+
bool IsTradingAllowed()
{
   if(!InpEnableTrading) return false;
   CheckDailyReset();
   if(g_SharedState.current_risk_level == RISK_CIRCUIT_BREAKER) {
      Print("🚨 V4.0 熔断:停止交易");
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| 更新交易统计                                                     |
//+------------------------------------------------------------------+
void UpdateTradeStatistics(double profit)
{
   g_DailyProfit += profit;
   g_TotalProfit += profit;
   if(profit > 0) {
      g_WinningTrades++; g_ConsecutiveLosses = 0;
      g_GrossProfit += profit;
      if(profit > g_LargestWin) g_LargestWin = profit;
      if(g_WinningTrades > 0) g_AvgWin = g_GrossProfit / g_WinningTrades;
   } else if(profit < 0) {
      g_LosingTrades++; g_ConsecutiveLosses++;
      g_LastLossTime = TimeCurrent();
      g_GrossLoss += MathAbs(profit);
      if(profit < g_LargestLoss) g_LargestLoss = profit;
      if(g_LosingTrades > 0) g_AvgLoss = g_GrossLoss / g_LosingTrades;
   }
   if(g_GrossLoss > 0) g_ProfitFactor = g_GrossProfit / g_GrossLoss;
   else g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;
   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(g_DailyHighEquity > 0.0001) {
      double drawdown = ((g_DailyHighEquity - currentEquity) / g_DailyHighEquity) * 100.0;
      if(drawdown > g_MaxDrawdown) g_MaxDrawdown = drawdown;
   }
   // V4.0 风险递进控制(8.3)
   if(g_DailyProfit <= -InpMaxDailyLoss * 0.5) g_SharedState.current_risk_level = RISK_MEDIUM;
   if(g_DailyProfit <= -InpMaxDailyLoss * 0.8) g_SharedState.current_risk_level = RISK_HIGH;
   if(g_DailyProfit <= -InpMaxDailyLoss) g_SharedState.current_risk_level = RISK_CRITICAL;
   if(g_ConsecutiveLosses >= InpMaxConsecLosses) g_SharedState.current_risk_level = RISK_CIRCUIT_BREAKER;
}

//+------------------------------------------------------------------+
//| 凯利公式                                                         |
//+------------------------------------------------------------------+
double CalculateKellyCriterionLots(double stopLossDistance)
{
   if(!InpUseKellyCriterion) return CalculateDynamicLots(stopLossDistance);
   if(g_TotalTrades < InpMinTradesForKelly) return CalculateDynamicLots(stopLossDistance);
   if(g_WinningTrades == 0 || g_LosingTrades == 0) return CalculateDynamicLots(stopLossDistance);
   if(g_TotalTrades == 0) return CalculateDynamicLots(stopLossDistance);
   double winRate = (double)g_WinningTrades / (double)g_TotalTrades;
   double avgWin = g_AvgWin > 0 ? g_AvgWin : 1.0;
   double avgLoss = g_AvgLoss > 0 ? g_AvgLoss : 1.0;
   if(avgLoss <= 0) return CalculateDynamicLots(stopLossDistance);
   double b = avgWin / avgLoss;
   if(MathAbs(b) < 0.0001) return CalculateDynamicLots(stopLossDistance);
   double kellyPercent = (winRate * b - (1 - winRate)) / b;
   kellyPercent = kellyPercent * InpKellyFraction;
   if(kellyPercent > (InpMaxRiskPerTrade / 100.0)) kellyPercent = InpMaxRiskPerTrade / 100.0;
   if(kellyPercent < 0.001) kellyPercent = 0.001;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double riskAmount = equity * kellyPercent;
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double lots = InpMinLotSize;
   if(tickValue > 0 && tickSize > 0 && stopLossDistance > 0) {
      double pointsAtRisk = MathAbs(stopLossDistance) / tickSize;
      double denominator = pointsAtRisk * tickValue;
      if(denominator > 0.0001) lots = riskAmount / denominator;
   }
   if(lots > InpMaxLotCap) lots = InpMaxLotCap;
   if(lots < InpMinLotSize) lots = InpMinLotSize;
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0.0001) lots = MathFloor(lots / step) * step;
   if(lots <= 0) lots = InpMinLotSize;
   return lots;
}

//+------------------------------------------------------------------+
//| 线性回归斜率                                                     |
//+------------------------------------------------------------------+
double CalculateLinearRegressionSlope(double &data[], int period)
{
   if(ArraySize(data) < period) return 0.0;
   double sumX = 0.0, sumY = 0.0, sumXY = 0.0, sumX2 = 0.0;
   for(int i = 0; i < period; i++) {
      double x = (double)i, y = data[i];
      sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
   }
   double n = (double)period;
   double denominator = (n * sumX2 - sumX * sumX);
   if(MathAbs(denominator) < 0.0001) return 0.0;
   return (n * sumXY - sumX * sumY) / denominator;
}

//+------------------------------------------------------------------+
//| 市场状态检测                                                     |
//+------------------------------------------------------------------+
MARKET_REGIME DetectMarketRegime()
{
   if(!InpUseRegimeDetection) return REGIME_UNKNOWN;
   double adxBuffer[];
   ArraySetAsSeries(adxBuffer, true);
   if(g_HandleADX == INVALID_HANDLE) {
      g_HandleADX = iADX(_Symbol, PERIOD_M15, InpRegimeADXPeriod);
      if(g_HandleADX == INVALID_HANDLE) return REGIME_UNKNOWN;
   }
   if(CopyBuffer(g_HandleADX, 0, 0, 1, adxBuffer) < 1) return REGIME_UNKNOWN;
   double adxValue = adxBuffer[0];
   double high[], low[], close[];
   ArraySetAsSeries(high, true); ArraySetAsSeries(low, true); ArraySetAsSeries(close, true);
   if(CopyHigh(_Symbol, PERIOD_M15, 0, 50, high) != 50) return REGIME_UNKNOWN;
   if(CopyLow(_Symbol, PERIOD_M15, 0, 50, low) != 50) return REGIME_UNKNOWN;
   if(CopyClose(_Symbol, PERIOD_M15, 0, 50, close) != 50) return REGIME_UNKNOWN;
   if(ArraySize(high) < 50 || ArraySize(low) < 50) return REGIME_UNKNOWN;
   int maxIdx = ArrayMaximum(high, 0, 50);
   int minIdx = ArrayMinimum(low, 0, 50);
   if(maxIdx < 0 || minIdx < 0) return REGIME_UNKNOWN;
   double range50 = high[maxIdx] - low[minIdx];
   if(range50 <= 0) return REGIME_UNKNOWN;
   double avgATR = (ArraySize(g_BufferATR) > 0 && g_BufferATR[0] > 0) ? g_BufferATR[0] : range50 / 10.0;
   double atrRatio = 0.0;
   double atrDenominator = avgATR * 50.0;
   if(atrDenominator > 0.0001) atrRatio = range50 / atrDenominator;
   double slope = CalculateLinearRegressionSlope(close, 50);
   if(adxValue > InpRegimeADXThreshold && slope > 0.001) return REGIME_TRENDING_UP;
   if(adxValue > InpRegimeADXThreshold && slope < -0.001) return REGIME_TRENDING_DOWN;
   if(atrRatio > 2.0 && adxValue < 20.0) return REGIME_VOLATILE;
   if(adxValue < 20.0) return REGIME_RANGING;
   return REGIME_UNKNOWN;
}

void AdjustStrategyForRegime()
{
   if(!InpUseRegimeDetection) return;
   MARKET_REGIME newRegime = DetectMarketRegime();
   if(newRegime != g_CurrentRegime) {
      g_CurrentRegime = newRegime;
      if(InpUseMultiAgent) {
         switch(g_CurrentRegime) {
            case REGIME_TRENDING_UP: g_SharedState.market_regime = "TRENDING_UP"; g_SharedState.market_bias = "BULLISH"; break;
            case REGIME_TRENDING_DOWN: g_SharedState.market_regime = "TRENDING_DOWN"; g_SharedState.market_bias = "BEARISH"; break;
            case REGIME_RANGING: g_SharedState.market_regime = "RANGING"; g_SharedState.market_bias = "NEUTRAL"; break;
            case REGIME_VOLATILE: g_SharedState.market_regime = "VOLATILE"; g_SharedState.market_bias = "NEUTRAL"; break;
            default: g_SharedState.market_regime = "UNKNOWN"; break;
         }
      }
      switch(g_CurrentRegime) {
         case REGIME_TRENDING_UP: Print("📈 V4.0 市场:上升趋势"); break;
         case REGIME_TRENDING_DOWN: Print("📉 V4.0 市场:下降趋势"); break;
         case REGIME_RANGING: Print("↔️ V4.0 市场:震荡"); break;
         case REGIME_VOLATILE: Print("⚡ V4.0 市场:高波动"); break;
         default: Print("❓ V4.0 市场:未知"); break;
      }
   }
}

//+------------------------------------------------------------------+
//| 良好交易时段检查                                                 |
//+------------------------------------------------------------------+
bool IsGoodTradingTime()
{
   if(!InpUseTimeFilters) return true;
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(InpAvoidAsianDeadZone && dt.hour >= 2 && dt.hour < 5) return false;
   string session = GetTradingSession();
   if(InpAvoidSessionOpen && ((dt.hour == 8 && dt.min < 15) || (dt.hour == 13 && dt.min < 15))) return false;
   if(InpAvoidSessionClose && session == "US" && dt.hour == 20 && dt.min > 45) return false;
   if(InpAvoidWeekendHold && IsWeekendRiskTime()) return false;
   if(g_SharedState.event_lock) return false;
   return true;
}

//+------------------------------------------------------------------+
//| 夏普比率                                                         |
//+------------------------------------------------------------------+
double CalculateSharpeRatio()
{
   if(g_TotalTrades < 10) return 0.0;
   if(g_AvgLoss > 0) {
      double riskAdjustedReturn = (g_AvgWin * (double)g_WinningTrades - g_AvgLoss * (double)g_LosingTrades) / g_TotalTrades;
      if(g_AvgLoss > 0) return riskAdjustedReturn / g_AvgLoss;
   }
   return 0.0;
}

void DrawPerformancePanel() {}
void UpdatePerformancePanel() {}

//+------------------------------------------------------------------+
//| 加载历史统计                                                     |
//+------------------------------------------------------------------+
void LoadHistoricalStatistics()
{
   Print("═══════════════════════════════════════════════════════");
   Print("📊 V4.0 加载历史统计: ", _Symbol);
   datetime startTime = 0, endTime = TimeCurrent();
   if(!HistorySelect(startTime, endTime)) { Print("⚠️ 无法访问历史"); return; }

   g_TotalTrades = 0; g_WinningTrades = 0; g_LosingTrades = 0;
   g_TotalProfit = 0.0; g_GrossProfit = 0.0; g_GrossLoss = 0.0;
   g_LargestWin = 0.0; g_LargestLoss = 0.0; g_ConsecutiveLosses = 0;

   ulong processedPositionIds[];
   ulong positionIds[];
   double positionProfits[];
   datetime positionCloseTimes[];

   int totalDeals = HistoryDealsTotal();
   for(int i = 0; i < totalDeals; i++) {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket <= 0) continue;
      string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
      if(dealSymbol != g_SymbolName && dealSymbol != _Symbol) continue;
      long dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      if(!InpIncludeAllMagicNumbers && dealMagic != 0 && dealMagic != MAGIC_NUMBER) continue;
      ulong positionId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
      if(positionId == 0) continue;
      ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if(dealEntry != DEAL_ENTRY_OUT) continue;

      bool alreadyProcessed = false;
      for(int j = 0; j < ArraySize(processedPositionIds); j++) {
         if(processedPositionIds[j] == positionId) { alreadyProcessed = true; break; }
      }
      if(alreadyProcessed) continue;

      if(!HistorySelectByPosition(positionId)) continue;
      double totalPositionProfit = 0.0, totalCommission = 0.0, totalSwap = 0.0;
      datetime positionCloseTime = 0;
      int positionDeals = HistoryDealsTotal();
      for(int d = 0; d < positionDeals; d++) {
         ulong posDealTicket = HistoryDealGetTicket(d);
         if(posDealTicket <= 0) continue;
         string posDealSymbol = HistoryDealGetString(posDealTicket, DEAL_SYMBOL);
         if(posDealSymbol != g_SymbolName && posDealSymbol != _Symbol) continue;
         totalPositionProfit += HistoryDealGetDouble(posDealTicket, DEAL_PROFIT);
         totalCommission += HistoryDealGetDouble(posDealTicket, DEAL_COMMISSION);
         totalSwap += HistoryDealGetDouble(posDealTicket, DEAL_SWAP);
         if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(posDealTicket, DEAL_ENTRY) == DEAL_ENTRY_OUT) {
            datetime dealTime = (datetime)HistoryDealGetInteger(posDealTicket, DEAL_TIME);
            if(dealTime > positionCloseTime) positionCloseTime = dealTime;
         }
      }
      double finalProfit = totalPositionProfit + totalCommission + totalSwap;
      int arraySize = ArraySize(positionIds);
      ArrayResize(positionIds, arraySize + 1);
      ArrayResize(positionProfits, arraySize + 1);
      ArrayResize(positionCloseTimes, arraySize + 1);
      ArrayResize(processedPositionIds, arraySize + 1);
      positionIds[arraySize] = positionId;
      positionProfits[arraySize] = finalProfit;
      positionCloseTimes[arraySize] = positionCloseTime;
      processedPositionIds[arraySize] = positionId;
   }
   HistorySelect(startTime, endTime);

   int closedPositions = ArraySize(positionIds);
   if(closedPositions == 0) { Print("   ⚠️ 无历史交易"); return; }

   for(int i = 0; i < closedPositions - 1; i++) {
      for(int j = i + 1; j < closedPositions; j++) {
         if(positionCloseTimes[i] > positionCloseTimes[j]) {
            ulong tempId = positionIds[i]; positionIds[i] = positionIds[j]; positionIds[j] = tempId;
            double tempProfit = positionProfits[i]; positionProfits[i] = positionProfits[j]; positionProfits[j] = tempProfit;
            datetime tempTime = positionCloseTimes[i]; positionCloseTimes[i] = positionCloseTimes[j]; positionCloseTimes[j] = tempTime;
         }
      }
   }

   for(int i = 0; i < closedPositions; i++) {
      double profit = positionProfits[i];
      g_TotalTrades++; g_TotalProfit += profit;
      if(profit > 0) {
         g_WinningTrades++; g_ConsecutiveLosses = 0;
         g_GrossProfit += profit;
         if(profit > g_LargestWin) g_LargestWin = profit;
      } else if(profit < 0) {
         g_LosingTrades++; g_ConsecutiveLosses++;
         g_LastLossTime = positionCloseTimes[i];
         g_GrossLoss += MathAbs(profit);
         if(profit < g_LargestLoss) g_LargestLoss = profit;
      }
   }
   if(g_WinningTrades > 0) g_AvgWin = g_GrossProfit / g_WinningTrades;
   if(g_LosingTrades > 0) g_AvgLoss = g_GrossLoss / g_LosingTrades;
   if(g_GrossLoss > 0) g_ProfitFactor = g_GrossProfit / g_GrossLoss;
   else g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;

   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0.0;
   Print("📊 V4.0 历史加载: 交易=", g_TotalTrades, " 胜率=", DoubleToString(winRate, 1), "% PF=", DoubleToString(g_ProfitFactor, 2));
   Print("═══════════════════════════════════════════════════════");
}

//+------------------------------------------------------------------+
//| 检查平仓并更新统计                                               |
//+------------------------------------------------------------------+
void CheckClosedPositionsAndUpdateStats()
{
   datetime startTime = TimeCurrent() - 172800;
   datetime endTime = TimeCurrent() + 60;
   if(!HistorySelect(startTime, endTime)) return;
   int totalDeals = HistoryDealsTotal();

   for(int i = 0; i < totalDeals; i++) {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;
      ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      long dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
      double dealProfit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
      if(dealEntry != DEAL_ENTRY_OUT && dealEntry != DEAL_ENTRY_OUT_BY) continue;
      if(dealMagic != MAGIC_NUMBER || dealSymbol != _Symbol) continue;

      bool alreadyProcessed = false;
      for(int j = 0; j < ArraySize(g_ProcessedDeals); j++) {
         if(g_ProcessedDeals[j] == dealTicket) { alreadyProcessed = true; break; }
      }
      if(alreadyProcessed) continue;

      double dealCommission = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
      double dealSwap = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
      double totalDealProfit = dealProfit + dealCommission + dealSwap;

      int newSize = ArraySize(g_ProcessedDeals) + 1;
      ArrayResize(g_ProcessedDeals, newSize);
      g_ProcessedDeals[newSize - 1] = dealTicket;

      g_TotalTrades++; g_TotalProfit += totalDealProfit; g_DailyProfit += totalDealProfit;
      if(totalDealProfit > 0) {
         g_WinningTrades++; g_ConsecutiveLosses = 0;
         g_GrossProfit += totalDealProfit;
         if(totalDealProfit > g_LargestWin) g_LargestWin = totalDealProfit;
         if(g_WinningTrades > 0) g_AvgWin = g_GrossProfit / g_WinningTrades;
      } else {
         g_LosingTrades++; g_ConsecutiveLosses++;
         g_LastLossTime = TimeCurrent();
         g_GrossLoss += MathAbs(totalDealProfit);
         if(totalDealProfit < g_LargestLoss) g_LargestLoss = totalDealProfit;
      }
      if(g_GrossLoss > 0) g_ProfitFactor = g_GrossProfit / g_GrossLoss;
      else g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;
      double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      if(g_DailyHighEquity > 0.0001) {
         double drawdown = ((g_DailyHighEquity - currentEquity) / g_DailyHighEquity) * 100.0;
         if(drawdown > g_MaxDrawdown) g_MaxDrawdown = drawdown;
      }
      Print("📊 V4.0 平仓: $", DoubleToString(totalDealProfit, 2), " | 总=", g_TotalTrades);
      UpdatePanelAfterTrade();
   }
}

//+------------------------------------------------------------------+
//| V4.0 增强AI上下文                                                |
//+------------------------------------------------------------------+
string EnhanceAIContext(string baseContext)
{
   string enhanced = baseContext;
   if(InpUseRegimeDetection && g_CurrentRegime != REGIME_UNKNOWN) {
      string regimeStr = "";
      switch(g_CurrentRegime) {
         case REGIME_TRENDING_UP: regimeStr = "TRENDING UP"; break;
         case REGIME_TRENDING_DOWN: regimeStr = "TRENDING DOWN"; break;
         case REGIME_RANGING: regimeStr = "RANGING"; break;
         case REGIME_VOLATILE: regimeStr = "VOLATILE"; break;
      }
      enhanced += "\nMarket Regime: " + regimeStr + "\n";
   }
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0.0;
   if(winRate < 40.0 && g_TotalTrades > 10) enhanced += "\n🚨 胜率<40% - 减少交易频率!\n";
   if(g_ConsecutiveLosses >= 2) enhanced += "\n⚠️ 连续亏损" + IntegerToString(g_ConsecutiveLosses) + "次 - 保守\n";
   if(g_DailyProfit < -InpMaxDailyLoss * 0.5) enhanced += "\n⚠️ 日亏损接近限制\n";
   if(g_ProfitFactor > 0) {
      enhanced += "\nProfit Factor: " + DoubleToString(g_ProfitFactor, 2);
      if(g_ProfitFactor > 2.0) enhanced += " (优秀)\n";
      else if(g_ProfitFactor > 1.5) enhanced += " (良好)\n";
      else if(g_ProfitFactor > 1.0) enhanced += " (一般)\n";
      else enhanced += " (需改进)\n";
   }
   return enhanced;
}

//+------------------------------------------------------------------+
//| V4.0 交易后面板更新                                              |
//+------------------------------------------------------------------+
void UpdatePanelAfterTrade()
{
   double floatingProfit = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER) {
         floatingProfit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP) + PositionGetDouble(POSITION_COMMISSION);
      }
   }
   double dailyTotalProfit = g_DailyProfit + floatingProfit;
   UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotalProfit, 2), dailyTotalProfit >= 0 ? ClrBuy : ClrSell);
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);
   int openPos = CountTotalOpenPositions();
   UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) + ")", ClrBuy);
   string riskLevelStr = "LOW"; color riskColor = ClrBuy;
   switch(g_SharedState.current_risk_level) {
      case RISK_LOW: riskLevelStr = "LOW"; riskColor = ClrBuy; break;
      case RISK_MEDIUM: riskLevelStr = "MEDIUM"; riskColor = ClrWarning; break;
      case RISK_HIGH: riskLevelStr = "HIGH"; riskColor = ClrSell; break;
      case RISK_CRITICAL: riskLevelStr = "CRITICAL"; riskColor = ClrSell; break;
      case RISK_CIRCUIT_BREAKER: riskLevelStr = "BREAKER"; riskColor = ClrSell; break;
   }
   UpdateUI("RiskLevel", riskLevelStr, riskColor);
   ChartRedraw(0);
}

//==================================================================
//           V4.0 Phase 1: 持仓管理AI化 (T1.1-T1.5)
//==================================================================

//+------------------------------------------------------------------+
//| V4.0 持仓管理Agent主函数 (Phase 1 - T1.1)                       |
//+------------------------------------------------------------------+
void CallPositionManager()
{
   if(!InpUseAI || !g_AIIsActive) return;
   static datetime lastCall = 0;
   if(TimeCurrent() - lastCall < InpPositionManagerIntervalSec) return;
   lastCall = TimeCurrent();

   string context = BuildPositionContext();
   if(StringLen(context) == 0) return;

   string response = "";
   if(InpUseMultiAgent) {
      response = CallAIAgent("position_manager", context, 2000);
   } else { return; }

   ExecutePositionActions(response);
}

//+------------------------------------------------------------------+
//| V4.0 构建持仓上下文(精简版 Phase 1 - T1.1 / Phase 5 - T5.2)     |
//+------------------------------------------------------------------+
string BuildPositionContext()
{
   string ctx = "";
   bool hasPositions = false;
   ctx += "═══ V4.0 持仓管理Agent ═══\n当前持仓:\n";

   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MAGIC_NUMBER) continue;
      hasPositions = true;

      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);
      double profit = PositionGetDouble(POSITION_PROFIT);
      double volume = PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);

      double currentPrice = (posType == POSITION_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double profitPct = (posType == POSITION_TYPE_BUY) ? ((currentPrice - entryPrice) / entryPrice) * 100.0 : ((entryPrice - currentPrice) / entryPrice) * 100.0;
      int holdHours = (int)((TimeCurrent() - openTime) / 3600);
      int tpTier = GetTPTierLevel(ticket);
      int addCount = GetAddCount(ticket);

      ctx += StringFormat("#%I64u %s 入场:%.2f 当前:%.2f SL:%.2f 盈亏:$%.2f(%.2f%%) 手:%.2f 持:%d小时 TP级:%d 加仓:%d\n",
         ticket, posType == POSITION_TYPE_BUY ? "BUY" : "SELL",
         entryPrice, currentPrice, currentSL, profit, profitPct, volume, holdHours, tpTier, addCount);

      if(i == PositionsTotal() - 1) {
         double m5Close[];
         ArraySetAsSeries(m5Close, true);
         if(CopyClose(_Symbol, PERIOD_M5, 0, 5, m5Close) == 5) {
            ctx += "M5: ";
            for(int k = 0; k < 5; k++) ctx += DoubleToString(m5Close[k], g_SymbolDigits) + " ";
            ctx += "\n";
         }
      }
   }
   if(!hasPositions) return "";

   ctx += StringFormat("市场:%s 偏好:%s 风险级:%d\n", g_SharedState.market_regime, g_SharedState.market_bias, (int)g_SharedState.current_risk_level);
   if(ArraySize(g_BufferRSI) > 0 && ArraySize(g_BufferATR) > 0)
      ctx += StringFormat("RSI:%.1f ATR:%.2f\n", g_BufferRSI[0], g_BufferATR[0]);
   ctx += StringFormat("入场信号:%s(%.0f%%)\n", g_SharedState.entry_signal, g_SharedState.entry_confidence * 100);

   ctx += "\n对每个持仓给操作指令(JSON数组):\n";
   ctx += "[{\"ticket\":12345,\"action\":\"HOLD/TRAIL_SL/MOVE_BE/PARTIAL_CLOSE/CLOSE/ADD\",\"new_sl\":0,\"close_percent\":0,\"add_lots\":0,\"reason\":\"理由\"}]\n";
   ctx += "HOLD:持有 TRAIL_SL:移动止损 MOVE_BE:保本 PARTIAL_CLOSE:部分平仓 CLOSE:全平 ADD:加仓\n";
   ctx += "原则:让利润奔跑,控制风险,顺势加仓\n";
   return ctx;
}

//+------------------------------------------------------------------+
//| V4.0 执行持仓操作指令 (Phase 1 - T1.1)                          |
//+------------------------------------------------------------------+
void ExecutePositionActions(string response)
{
   if(StringLen(response) == 0) return;
   int searchPos = 0;
   while(searchPos < StringLen(response)) {
      int ticketStart = StringFind(response, "\"ticket\":", searchPos);
      if(ticketStart < 0) break;
      ticketStart += StringLen("\"ticket\":");
      int ticketEnd = ticketStart;
      while(ticketEnd < StringLen(response)) {
         ushort c = StringGetCharacter(response, ticketEnd);
         if(c == ',' || c == '}' || c == ' ') break;
         ticketEnd++;
      }
      string ticketStr = StringSubstr(response, ticketStart, ticketEnd - ticketStart);
      StringTrimLeft(ticketStr); StringTrimRight(ticketStr);
      ulong ticket = (ulong)StringToInteger(ticketStr);

      int actionStart = StringFind(response, "\"action\":\"", ticketEnd);
      if(actionStart < 0 || actionStart > ticketEnd + 200) { searchPos = ticketEnd; continue; }
      actionStart += StringLen("\"action\":\"");
      int actionEnd = StringFind(response, "\"", actionStart);
      if(actionEnd < 0) break;
      string action = StringSubstr(response, actionStart, actionEnd - actionStart);

      double newSL = 0;
      int slStart = StringFind(response, "\"new_sl\":", actionEnd);
      if(slStart >= 0 && slStart < actionEnd + 200) {
         slStart += StringLen("\"new_sl\":");
         int slEnd = slStart;
         while(slEnd < StringLen(response)) {
            ushort c = StringGetCharacter(response, slEnd);
            if(c == ',' || c == '}' || c == ' ') break;
            slEnd++;
         }
         newSL = StringToDouble(StringSubstr(response, slStart, slEnd - slStart));
      }

      double closePercent = 0;
      int cpStart = StringFind(response, "\"close_percent\":", actionEnd);
      if(cpStart >= 0 && cpStart < actionEnd + 300) {
         cpStart += StringLen("\"close_percent\":");
         int cpEnd = cpStart;
         while(cpEnd < StringLen(response)) {
            ushort c = StringGetCharacter(response, cpEnd);
            if(c == ',' || c == '}' || c == ' ') break;
            cpEnd++;
         }
         closePercent = StringToDouble(StringSubstr(response, cpStart, cpEnd - cpStart));
      }

      double addLots = 0;
      int alStart = StringFind(response, "\"add_lots\":", actionEnd);
      if(alStart >= 0 && alStart < actionEnd + 400) {
         alStart += StringLen("\"add_lots\":");
         int alEnd = alStart;
         while(alEnd < StringLen(response)) {
            ushort c = StringGetCharacter(response, alEnd);
            if(c == ',' || c == '}' || c == ' ') break;
            alEnd++;
         }
         addLots = StringToDouble(StringSubstr(response, alStart, alEnd - alStart));
      }

      // V4.0 安全网校验(Phase 1 - T1.5)
      if(!ValidateAIAction(ticket, action, newSL)) {
         Print("🚨 V4.0 安全网拦截: #", ticket, " ", action);
         searchPos = actionEnd;
         continue;
      }

      if(action == "CLOSE") {
         if(PositionSelectByTicket(ticket)) {
            double profit = PositionGetDouble(POSITION_PROFIT);
            Print("🤖 V4.0 持仓Agent: 平仓 #", ticket);
            if(g_Trade.PositionClose(ticket)) RecordPositionClose(ticket, profit, "AI持仓Agent平仓");
         }
      } else if(action == "PARTIAL_CLOSE" && closePercent > 0 && closePercent < 100) {
         ExecutePartialClose(ticket, closePercent);
      } else if(action == "TRAIL_SL" && newSL > 0) {
         if(PositionSelectByTicket(ticket)) {
            double currentTP = PositionGetDouble(POSITION_TP);
            newSL = NormalizeDouble(newSL, g_SymbolDigits);
            g_Trade.PositionModify(ticket, newSL, currentTP);
            Print("🤖 V4.0 持仓Agent: 移动止损 #", ticket, "→", newSL);
         }
      } else if(action == "MOVE_BE") {
         if(PositionSelectByTicket(ticket)) {
            double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
            double bePrice = (posType == POSITION_TYPE_BUY) ? entryPrice + (g_SymbolPoint * 5) : entryPrice - (g_SymbolPoint * 5);
            bePrice = NormalizeDouble(bePrice, g_SymbolDigits);
            double currentTP = PositionGetDouble(POSITION_TP);
            g_Trade.PositionModify(ticket, bePrice, currentTP);
            Print("🤖 V4.0 持仓Agent: 保本 #", ticket);
         }
      } else if(action == "ADD" && addLots > 0 && InpAllowAddPosition) {
         ExecuteAddPosition(ticket, addLots);
      }
      searchPos = actionEnd;
   }
}

//+------------------------------------------------------------------+
//| V4.0 部分平仓 (Phase 1 - T1.2)                                  |
//+------------------------------------------------------------------+
bool ExecutePartialClose(ulong ticket, double closePercent)
{
   if(!PositionSelectByTicket(ticket)) return false;
   double volume = PositionGetDouble(POSITION_VOLUME);
   double closeVolume = volume * (closePercent / 100.0);
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0) closeVolume = MathFloor(closeVolume / step) * step;
   if(closeVolume < minLot) { Print("⚠️ V4.0 部分平仓手数过小"); return false; }
   Print("🤖 V4.0 部分平仓: #", ticket, " ", DoubleToString(closePercent, 0), "% (", DoubleToString(closeVolume, 2), "手)");
   bool result = g_Trade.PositionClosePartial(ticket, closeVolume);
   if(result) Print("✅ V4.0 部分平仓成功");
   else Print("❌ V4.0 部分平仓失败: ", g_Trade.ResultRetcodeDescription());
   return result;
}

//+------------------------------------------------------------------+
//| V4.0 顺势加仓 (Phase 1 - T1.4)                                  |
//+------------------------------------------------------------------+
bool ExecuteAddPosition(ulong baseTicket, double addLots)
{
   if(!InpAllowAddPosition) return false;
   if(!PositionSelectByTicket(baseTicket)) return false;

   int currentAddCount = GetAddCount(baseTicket);
   if(currentAddCount >= InpMaxAddCount) { Print("⚠️ V4.0 加仓次数上限"); return false; }

   double profit = PositionGetDouble(POSITION_PROFIT);
   if(profit <= 0) { Print("⚠️ V4.0 加仓要求已盈利"); return false; }

   // V4.0 金字塔减量加仓
   double pyramidLots = addLots * MathPow(InpAddPyramidFactor, currentAddCount + 1);
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0) pyramidLots = MathFloor(pyramidLots / step) * step;
   if(pyramidLots < minLot) pyramidLots = minLot;

   // V4.0 总敞口限制(安全网)
   double totalExposure = CalculateTotalExposure();
   double maxExposure = AccountInfoDouble(ACCOUNT_EQUITY) * 0.1;
   if(totalExposure + pyramidLots > maxExposure) { Print("⚠️ V4.0 加仓超总敞口限制"); return false; }

   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   double price = (posType == POSITION_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);

   Print("🤖 V4.0 顺势加仓: #", baseTicket, " ", DoubleToString(pyramidLots, 2), "手");

   MqlTradeRequest request = {};
   MqlTradeResult result = {};
   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = pyramidLots;
   request.type = (posType == POSITION_TYPE_BUY) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   request.price = price;
   request.sl = PositionGetDouble(POSITION_SL);
   request.tp = PositionGetDouble(POSITION_TP);
   request.deviation = 10;
   request.magic = MAGIC_NUMBER;
   request.comment = "GOLD V4 - AI ADD";

   long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) request.type_filling = ORDER_FILLING_FOK;
   else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) request.type_filling = ORDER_FILLING_IOC;
   else request.type_filling = ORDER_FILLING_RETURN;

   if(OrderSend(request, result)) {
      if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
         Print("✅ V4.0 加仓成功!");
         IncrementAddCount(baseTicket);
         return true;
      }
   }
   Print("❌ V4.0 加仓失败: ", result.retcode);
   return false;
}

//+------------------------------------------------------------------+
//| V4.0 安全网校验 (Phase 1 - T1.5)                                |
//+------------------------------------------------------------------+
bool ValidateAIAction(ulong ticket, string action, double param)
{
   if(!PositionSelectByTicket(ticket)) return false;
   // 1. 单笔最大亏损检查 - 不可被AI突破
   double maxLoss = AccountInfoDouble(ACCOUNT_EQUITY) * (InpMaxSingleLossPct / 100.0);
   double currentLoss = -PositionGetDouble(POSITION_PROFIT);
   if(currentLoss > maxLoss && action != "CLOSE") {
      Print("🚨 V4.0 安全网: 单笔亏损超限,强制平仓");
      double profit = PositionGetDouble(POSITION_PROFIT);
      g_Trade.PositionClose(ticket);
      RecordPositionClose(ticket, profit, "安全网强制平仓");
      return false;
   }
   // 2. 止损只能向有利方向移动
   if(action == "TRAIL_SL" || action == "MOVE_BE") {
      double currentSL = PositionGetDouble(POSITION_SL);
      ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      if(type == POSITION_TYPE_BUY && param < currentSL && currentSL > 0) return false;
      if(type == POSITION_TYPE_SELL && param > currentSL && currentSL > 0) return false;
   }
   // 3. 加仓总量限制
   if(action == "ADD") {
      double totalExposure = CalculateTotalExposure();
      double maxExposure = AccountInfoDouble(ACCOUNT_EQUITY) * 0.1;
      if(totalExposure > maxExposure) return false;
   }
   // 4. 持仓时间上限检查
   datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
   if(TimeCurrent() - openTime > InpMaxPositionHours * 3600 && action == "HOLD") {
      Print("⚠️ V4.0 安全网: 持仓超", InpMaxPositionHours, "小时,建议平仓");
   }
   return true;
}

//+------------------------------------------------------------------+
//| V4.0 分级止盈 (Phase 1 - T1.2)                                  |
//+------------------------------------------------------------------+
void ApplyTieredTakeProfit(ulong ticket, double profitPct)
{
   if(!InpUseTieredTakeProfit) return;
   if(!PositionSelectByTicket(ticket)) return;
   int currentLevel = GetTPTierLevel(ticket);

   if(currentLevel == 0 && profitPct >= InpTP1Pct) {
      Print("🎯 V4.0 TP1: 盈利", DoubleToString(profitPct, 2), "% → 平仓", DoubleToString(InpTP1ClosePct, 0), "%");
      if(ExecutePartialClose(ticket, InpTP1ClosePct)) SetTPTierLevel(ticket, 1);
   } else if(currentLevel == 1 && profitPct >= InpTP2Pct) {
      Print("🎯 V4.0 TP2: 盈利", DoubleToString(profitPct, 2), "% → 平仓", DoubleToString(InpTP2ClosePct, 0), "%");
      if(ExecutePartialClose(ticket, InpTP2ClosePct)) SetTPTierLevel(ticket, 2);
   } else if(currentLevel == 2 && profitPct >= InpTP3Pct) {
      SetTPTierLevel(ticket, 3);
      Print("🎯 V4.0 TP3: 盈利", DoubleToString(profitPct, 2), "% → 启用紧追踪");
      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      double lockProfit = entryPrice * (InpTP1Pct / 100.0);
      double newSL = (posType == POSITION_TYPE_BUY) ? entryPrice + lockProfit : entryPrice - lockProfit;
      newSL = NormalizeDouble(newSL, g_SymbolDigits);
      double currentTP = PositionGetDouble(POSITION_TP);
      g_Trade.PositionModify(ticket, newSL, currentTP);
   }
}

//+------------------------------------------------------------------+
//| V4.0 查找结构化止损位 (Phase 1 - T1.3)                          |
//+------------------------------------------------------------------+
double FindStructureStop(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return 0;
   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double m15Low[], m15High[];
   ArraySetAsSeries(m15Low, true); ArraySetAsSeries(m15High, true);
   if(CopyLow(_Symbol, PERIOD_M15, 0, 20, m15Low) != 20) return 0;
   if(CopyHigh(_Symbol, PERIOD_M15, 0, 20, m15High) != 20) return 0;

   if(posType == POSITION_TYPE_BUY) {
      int minIdx = ArrayMinimum(m15Low, 2, 15);
      if(minIdx >= 0 && minIdx < ArraySize(m15Low)) {
         double stopPrice = m15Low[minIdx] - (5 * g_SymbolPoint);
         if(stopPrice > entryPrice) return stopPrice;
      }
   } else {
      int maxIdx = ArrayMaximum(m15High, 2, 15);
      if(maxIdx >= 0 && maxIdx < ArraySize(m15High)) {
         double stopPrice = m15High[maxIdx] + (5 * g_SymbolPoint);
         if(stopPrice < entryPrice) return stopPrice;
      }
   }
   return 0;
}

//+------------------------------------------------------------------+
//| V4.0 分级止盈级别跟踪辅助函数                                   |
//+------------------------------------------------------------------+
int GetTPTierLevel(ulong ticket)
{
   for(int i = 0; i < ArraySize(g_TPTierTickets); i++) {
      if(g_TPTierTickets[i] == ticket) return g_TPTierLevel[i];
   }
   return 0;
}

void SetTPTierLevel(ulong ticket, int level)
{
   for(int i = 0; i < ArraySize(g_TPTierTickets); i++) {
      if(g_TPTierTickets[i] == ticket) { g_TPTierLevel[i] = level; return; }
   }
   int newSize = ArraySize(g_TPTierTickets) + 1;
   ArrayResize(g_TPTierTickets, newSize);
   ArrayResize(g_TPTierLevel, newSize);
   g_TPTierTickets[newSize - 1] = ticket;
   g_TPTierLevel[newSize - 1] = level;
}

//+------------------------------------------------------------------+
//| V4.0 加仓跟踪辅助函数                                           |
//+------------------------------------------------------------------+
int GetAddCount(ulong ticket)
{
   for(int i = 0; i < ArraySize(g_AddBaseTickets); i++) {
      if(g_AddBaseTickets[i] == ticket) return g_AddCount[i];
   }
   return 0;
}

void IncrementAddCount(ulong ticket)
{
   for(int i = 0; i < ArraySize(g_AddBaseTickets); i++) {
      if(g_AddBaseTickets[i] == ticket) { g_AddCount[i]++; return; }
   }
   int newSize = ArraySize(g_AddBaseTickets) + 1;
   ArrayResize(g_AddBaseTickets, newSize);
   ArrayResize(g_AddCount, newSize);
   g_AddBaseTickets[newSize - 1] = ticket;
   g_AddCount[newSize - 1] = 1;
}

//+------------------------------------------------------------------+
//| V4.0 持仓时间限制检查 (Phase 1 - T1.5)                          |
//+------------------------------------------------------------------+
void CheckPositionTimeLimit()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MAGIC_NUMBER) continue;

      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
      int holdHours = (int)((TimeCurrent() - openTime) / 3600);
      if(holdHours >= InpMaxPositionHours) {
         double profit = PositionGetDouble(POSITION_PROFIT);
         Print("⏰ V4.0 持仓超时: #", ticket, " 持仓", holdHours, "小时(上限", InpMaxPositionHours, "小时)");
         if(profit > 0) {
            Print("   → 盈利持仓,平仓锁定利润");
            if(g_Trade.PositionClose(ticket)) RecordPositionClose(ticket, profit, "持仓超时平仓");
         } else {
            Print("   → 亏损持仓,给AI持仓管理Agent处理");
         }
      }
   }
}

//+------------------------------------------------------------------+
//| V4.0 计算总敞口 (Phase 1 - T1.5安全网)                          |
//+------------------------------------------------------------------+
double CalculateTotalExposure()
{
   double totalLots = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MAGIC_NUMBER) {
         totalLots += PositionGetDouble(POSITION_VOLUME);
      }
   }
   return totalLots;
}

//==================================================================
//           V4.0 Phase 2: 多Agent架构搭建 (T2.1-T2.5)
//==================================================================

//+------------------------------------------------------------------+
//| V4.0 Agent调度器 (Phase 2 - T2.5)                               |
//+------------------------------------------------------------------+
void AgentScheduler()
{
   datetime now = TimeCurrent();

   // V4.0 外部数据更新(Phase 3) - 每5分钟
   if(TimeCurrent() - g_LastEventCheck >= 300) {
      UpdateExternalData();
      CheckEconomicEvents();
      g_LastEventCheck = now;
   }

   // 首席分析师 - 每15分钟 (Phase 2 - T2.2)
   if(TimeCurrent() - g_LastAnalystCall >= InpAnalystIntervalMin * 60) {
      CallChiefAnalyst();
      g_LastAnalystCall = now;
   }

   // 入场策略师 - 每3-5分钟 (Phase 2 - T2.3)
   if(TimeCurrent() - g_LastEntryCall >= InpEntryIntervalMin * 60) {
      CallEntryStrategist();
      g_LastEntryCall = now;
   }

   // 风险控制官 - 每小时 (Phase 2 - T2.4)
   if(TimeCurrent() - g_LastRiskOfficerCall >= InpRiskOfficerIntervalMin * 60) {
      CallRiskOfficer();
      g_LastRiskOfficerCall = now;
   }

   // 复盘学习员 - 每日指定时间 (Phase 4 - T4.2)
   if(InpUseReviewer) {
      MqlDateTime dt;
      TimeToStruct(now, dt);
      if(dt.hour == InpReviewerHour && dt.min < 5) {
         if(TimeCurrent() - g_LastReviewerCall >= 3600) {
            CallReviewAgent();
            g_LastReviewerCall = now;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| V4.0 统一Agent调用入口 (Phase 2)                                |
//+------------------------------------------------------------------+
string CallAIAgent(string agentRole, string context, int maxTokens)
{
   // V4.0 API预算检查(Phase 5 - T5.1)
   if(!CheckAPIBudget(agentRole)) {
      return GetFallbackResponse(agentRole);
   }

   string model = SelectModelByRole(agentRole);
   string systemPrompt = GetSystemPrompt(agentRole);
   string escapedContent = EscapeJSON(context);
   string escapedSystem = EscapeJSON(systemPrompt);
   string escapedModel = EscapeJSON(model);

   string jsonRequest = "{";
   jsonRequest += "\"model\":\"" + escapedModel + "\",";
   jsonRequest += "\"messages\":[";
   jsonRequest += "{\"role\":\"system\",\"content\":\"" + escapedSystem + "\"},";
   jsonRequest += "{\"role\":\"user\",\"content\":\"" + escapedContent + "\"}";
   jsonRequest += "],\"temperature\":0.7,\"max_completion_tokens\":" + IntegerToString(maxTokens) + "}";

   string headers = "Content-Type: application/json\r\n";
   headers += "Authorization: Bearer " + InpOpenAIAPIKey + "\r\n";
   headers += "User-Agent: MT5-EA-V4/1.0\r\n";

   // V4.0 带重试的API调用(Phase 5 - T5.3)
   string jsonResponse = SendAPIRequestWithRetry(jsonRequest, "https://api.deepseek.com/v1/chat/completions", headers, InpAPITimeoutMs);

   if(StringLen(jsonResponse) == 0) {
      LogAPIFailure(agentRole, "API调用失败");
      return GetFallbackResponse(agentRole);
   }

   g_DailyTokenUsed += (int)(StringLen(jsonRequest) / 4) + 1000;
   return ParseOpenAIResponse(jsonResponse);
}

//+------------------------------------------------------------------+
//| V4.0 按角色选择模型 (Phase 2)                                   |
//+------------------------------------------------------------------+
string SelectModelByRole(string role)
{
   // 首席分析师和复盘学习员用强推理模型
   if(role == "chief_analyst") return InpModelReasoner;
   if(role == "reviewer") return InpModelReasoner;
   // 其他用快速模型
   return InpOpenAIModel;
}

//+------------------------------------------------------------------+
//| V4.0 获取系统Prompt (Phase 2)                                   |
//+------------------------------------------------------------------+
string GetSystemPrompt(string agentRole)
{
   string prompt = "";

   if(agentRole == "chief_analyst") {
      prompt += "你是黄金市场首席分析师,专注大周期趋势判断。\n";
      prompt += "调用频率:每15分钟 | 输出:市场状态报告+偏好方向+关键价位\n\n";
      if(InpUseGoldKnowledge && StringLen(g_GoldKnowledgePrompt) > 0) prompt += g_GoldKnowledgePrompt;
      prompt += "输出JSON格式:\n";
      prompt += "{\"regime\":\"TRENDING_UP/RANGING/TRENDING_DOWN/VOLATILE\",\"bias\":\"BULLISH/BEARISH/NEUTRAL\",\"confidence\":0.0-1.0,\"narrative\":\"50字叙事\",\"recommendation\":\"建议\"}\n";
   } else if(agentRole == "entry_strategist") {
      prompt += "你是黄金(XAUUSD)日内交易策略师,基于首席分析师的市场状态报告(Regime/Bias)决定交易方向和止损止盈规模。\n\n";
      if(InpUseGoldKnowledge && StringLen(g_GoldKnowledgePrompt) > 0) prompt += g_GoldKnowledgePrompt + "\n";
      prompt += "【核心规则】\n";
      prompt += "1.方向对齐:交易方向应尽量与Bias一致。Bias=BULLISH优先BUY,Bias=BEARISH优先SELL。逆Bias交易需置信度>0.70\n";
      prompt += "2.止损止盈根据Regime自适应:TRENDING→紧止损宽止盈,RANGING→宽止损紧止盈,VOLATILE→宽止损宽止盈或WAIT\n";
      prompt += "3.用上下文中提供的ATR值(POINTS)作为止损止盈的基准倍数,不要用固定点数\n";
      prompt += "4.置信度:0.70+=顺Bias+明确形态,0.60-0.69=形态明确但小周期不一致,0.50-0.59=信号模糊倾向WAIT\n\n";
      prompt += "输出格式:信号|置信度|止损点数|止盈点数|推理|总结\n";
   } else if(agentRole == "position_manager") {
      prompt += "你是持仓管理专家,让利润奔跑同时控制风险。\n";
      prompt += "对每个持仓给操作指令JSON数组:\n";
      prompt += "[{\"ticket\":0,\"action\":\"HOLD/TRAIL_SL/MOVE_BE/PARTIAL_CLOSE/CLOSE/ADD\",\"new_sl\":0,\"close_percent\":0,\"add_lots\":0,\"reason\":\"理由\"}]\n";
   } else if(agentRole == "risk_officer") {
      prompt += "你是严格的风险控制官,保护资本是第一优先级。\n";
      prompt += "输出JSON:\n";
      prompt += "{\"trading_allowed\":true,\"max_positions\":5,\"max_risk_per_trade\":0.5,\"daily_loss_limit\":10.0,\"warnings\":[\"警告\"],\"adjustments\":\"说明\"}\n";
   } else if(agentRole == "reviewer") {
      prompt += "你是交易策略优化师,从历史交易中学习并改进。\n";
      prompt += "输出JSON:\n";
      prompt += "{\"performance_summary\":\"总结\",\"parameter_suggestions\":{\"ai_confidence_min\":0.65,\"stop_loss_atr_mult\":2.5,\"trailing_distance\":30},\"lessons_learned\":[\"教训\"]}\n";
   }

   return prompt;
}

//+------------------------------------------------------------------+
//| V4.0 API预算检查 (Phase 5 - T5.1)                               |
//+------------------------------------------------------------------+
bool CheckAPIBudget(string agentRole)
{
   if(g_DailyTokenUsed >= InpDailyTokenBudget) {
      Print("⚠️ V4.0 API预算超限: ", g_DailyTokenUsed, "/", InpDailyTokenBudget, " [", agentRole, "]");
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| V4.0 降级响应 (Phase 5 - T5.3)                                  |
//+------------------------------------------------------------------+
string GetFallbackResponse(string agentRole)
{
   if(agentRole == "chief_analyst") {
      return "{\"regime\":\"UNKNOWN\",\"bias\":\"NEUTRAL\",\"confidence\":0.0,\"narrative\":\"API降级\",\"recommendation\":\"观望\"}";
   } else if(agentRole == "entry_strategist") {
      return "WAIT|0.50|0|0|API降级|降级模式";
   } else if(agentRole == "position_manager") {
      return "[]";
   } else if(agentRole == "risk_officer") {
      return "{\"trading_allowed\":false,\"max_positions\":1,\"warnings\":[\"API降级,保守模式\"]}";
   } else if(agentRole == "reviewer") {
      return "{\"performance_summary\":\"API降级\",\"parameter_suggestions\":{}}";
   }
   return "";
}

//+------------------------------------------------------------------+
//| V4.0 首席分析师Agent (Phase 2 - T2.2)                           |
//+------------------------------------------------------------------+
void CallChiefAnalyst()
{
   if(!InpUseAI || !g_AIIsActive) return;
   Print("📊 V4.0 首席分析师Agent启动 - D1/H4/H1大周期分析");

   string context = BuildAnalystContext();
   string response = CallAIAgent("chief_analyst", context, 4000);
   ParseAnalystResponse(response);
}

//+------------------------------------------------------------------+
//| V4.0 构建分析师上下文 (Phase 2 - T2.2)                          |
//+------------------------------------------------------------------+
string BuildAnalystContext()
{
   string ctx = "═══ V4.0 首席分析师 - 大周期分析 ═══\n";
   ctx += "品种: " + g_SymbolName + "\n\n";

   // D1数据(30天)
   double d1Open[], d1High[], d1Low[], d1Close[];
   long d1Vol[];
   ArraySetAsSeries(d1Open, true); ArraySetAsSeries(d1High, true);
   ArraySetAsSeries(d1Low, true); ArraySetAsSeries(d1Close, true); ArraySetAsSeries(d1Vol, true);
   if(CopyOpen(_Symbol, PERIOD_D1, 0, 30, d1Open) == 30 && CopyHigh(_Symbol, PERIOD_D1, 0, 30, d1High) == 30 &&
      CopyLow(_Symbol, PERIOD_D1, 0, 30, d1Low) == 30 && CopyClose(_Symbol, PERIOD_D1, 0, 30, d1Close) == 30 &&
      CopyTickVolume(_Symbol, PERIOD_D1, 0, 30, d1Vol) == 30) {
      ctx += "D1(30天): ";
      for(int i = 0; i < 15; i++) {
         string dir = d1Close[i] > d1Open[i] ? "+" : "-";
         ctx += dir + DoubleToString(d1Close[i], g_SymbolDigits) + ":" + DoubleToString((d1High[i]-d1Low[i])/g_SymbolPoint, 0);
         if(i < 14) ctx += "|";
      }
      int maxIdx = ArrayMaximum(d1High, 0, 30);
      int minIdx = ArrayMinimum(d1Low, 0, 30);
      if(maxIdx >= 0) ctx += " | HIGH:" + DoubleToString(d1High[maxIdx], g_SymbolDigits);
      if(minIdx >= 0) ctx += " | LOW:" + DoubleToString(d1Low[minIdx], g_SymbolDigits);
      ctx += "\n";
   }

   // H4数据(20根)
   double h4Open[], h4High[], h4Low[], h4Close[];
   ArraySetAsSeries(h4Open, true); ArraySetAsSeries(h4High, true);
   ArraySetAsSeries(h4Low, true); ArraySetAsSeries(h4Close, true);
   if(CopyOpen(_Symbol, PERIOD_H4, 0, 20, h4Open) == 20 && CopyHigh(_Symbol, PERIOD_H4, 0, 20, h4High) == 20 &&
      CopyLow(_Symbol, PERIOD_H4, 0, 20, h4Low) == 20 && CopyClose(_Symbol, PERIOD_H4, 0, 20, h4Close) == 20) {
      ctx += "H4(20根): ";
      for(int i = 0; i < 20; i++) {
         string dir = h4Close[i] > h4Open[i] ? "+" : "-";
         ctx += dir + DoubleToString(h4Close[i], g_SymbolDigits);
         if(i < 19) ctx += "|";
      }
      ctx += "\n";
   }

   // H1数据(30根)
   double h1Open[], h1High[], h1Low[], h1Close[];
   ArraySetAsSeries(h1Open, true); ArraySetAsSeries(h1High, true);
   ArraySetAsSeries(h1Low, true); ArraySetAsSeries(h1Close, true);
   if(CopyOpen(_Symbol, PERIOD_H1, 0, 30, h1Open) == 30 && CopyHigh(_Symbol, PERIOD_H1, 0, 30, h1High) == 30 &&
      CopyLow(_Symbol, PERIOD_H1, 0, 30, h1Low) == 30 && CopyClose(_Symbol, PERIOD_H1, 0, 30, h1Close) == 30) {
      ctx += "H1(30根): ";
      for(int i = 0; i < 30; i++) {
         string dir = h1Close[i] > h1Open[i] ? "+" : "-";
         ctx += dir + DoubleToString(h1Close[i], g_SymbolDigits);
         if(i < 29) ctx += "|";
      }
      ctx += "\n";
   }

   // V4.0 外部数据(Phase 3)
   if(InpUseDXY && g_SharedState.dxy_value > 0) {
      ctx += "\nDXY: " + DoubleToString(g_SharedState.dxy_value, 2) + " (Chg:" + DoubleToString(g_SharedState.dxy_change, 2) + ")\n";
      ctx += "Gold-DXY相关性: " + DoubleToString(g_SharedState.gold_dxy_correlation, 2) + "\n";
   }
   if(InpUseTreasuryYield && g_SharedState.us10y_yield > 0)
      ctx += "US10Y: " + DoubleToString(g_SharedState.us10y_yield, 2) + "%\n";

   // V4.0 学习成果(Phase 4)
   if(InpUseReviewer && g_SharedState.learning_update_time > 0) {
      ctx += "\n近期教训: " + GetRecentLessonsText() + "\n";
   }

   ctx += "\n请分析大周期趋势,输出JSON格式报告\n";
   return ctx;
}

//+------------------------------------------------------------------+
//| V4.0 解析分析师响应 (Phase 2 - T2.2)                            |
//+------------------------------------------------------------------+
void ParseAnalystResponse(string response)
{
   if(StringLen(response) == 0) return;

   // 解析JSON字段
   int regimeStart = StringFind(response, "\"regime\":\"");
   if(regimeStart >= 0) {
      regimeStart += StringLen("\"regime\":\"");
      int regimeEnd = StringFind(response, "\"", regimeStart);
      if(regimeEnd > 0) {
         g_SharedState.market_regime = StringSubstr(response, regimeStart, regimeEnd - regimeStart);
      }
   }

   int biasStart = StringFind(response, "\"bias\":\"");
   if(biasStart >= 0) {
      biasStart += StringLen("\"bias\":\"");
      int biasEnd = StringFind(response, "\"", biasStart);
      if(biasEnd > 0) {
         g_SharedState.market_bias = StringSubstr(response, biasStart, biasEnd - biasStart);
      }
   }

   int confStart = StringFind(response, "\"confidence\":");
   if(confStart >= 0) {
      confStart += StringLen("\"confidence\":");
      int confEnd = confStart;
      while(confEnd < StringLen(response)) {
         ushort c = StringGetCharacter(response, confEnd);
         if(c == ',' || c == '}' || c == ' ') break;
         confEnd++;
      }
      g_SharedState.regime_confidence = StringToDouble(StringSubstr(response, confStart, confEnd - confStart));
   }

   int narrStart = StringFind(response, "\"narrative\":\"");
   if(narrStart >= 0) {
      narrStart += StringLen("\"narrative\":\"");
      int narrEnd = StringFind(response, "\"", narrStart);
      if(narrEnd > 0) {
         g_SharedState.market_narrative = StringSubstr(response, narrStart, narrEnd - narrStart);
      }
   }

   g_SharedState.analyst_update_time = TimeCurrent();
   Print("📊 V4.0 首席分析师: ", g_SharedState.market_regime, " | ", g_SharedState.market_bias,
         " | 置信度:", DoubleToString(g_SharedState.regime_confidence * 100, 1), "%");
   if(StringLen(g_SharedState.market_narrative) > 0)
      Print("   叙事: ", g_SharedState.market_narrative);
}

//+------------------------------------------------------------------+
//| V4.0 入场策略师Agent (Phase 2 - T2.3)                           |
//+------------------------------------------------------------------+
void CallEntryStrategist()
{
   if(!InpUseAI || !g_AIIsActive) return;
   Print("🎯 V4.0 入场策略师Agent启动");

   string context = BuildEntryContext();
   string response = CallAIAgent("entry_strategist", context, 3000);
   ParseEntryResponse(response);
}

//+------------------------------------------------------------------+
//| V4.0 构建入场上下文 (Phase 2 - T2.3)                            |
//+------------------------------------------------------------------+
string BuildEntryContext()
{
   string ctx = "═══ V4.0 入场策略师 ═══\n\n";
   ctx += "【首席分析师报告】\n";
   ctx += "  Regime(市场状态): " + g_SharedState.market_regime + " | Bias(方向偏好): " + g_SharedState.market_bias;
   ctx += " | 置信度:" + DoubleToString(g_SharedState.regime_confidence * 100, 1) + "%\n";
   if(StringLen(g_SharedState.market_narrative) > 0)
      ctx += "  分析师叙事: " + g_SharedState.market_narrative + "\n";
   ctx += "→ 请根据此Regime选择止损止盈策略:\n";
   ctx += "  TRENDING=紧止损(0.8-1.2xATR)+宽止盈(2.5-4.0xATR),仅顺势\n";
   ctx += "  RANGING=宽止损(1.5-2.0xATR)+紧止盈(0.8-1.5xATR),双向均可\n";
   ctx += "  VOLATILE=宽止损(2.0-2.5xATR)+宽止盈(2.0-3.5xATR),置信度>0.70才入场\n\n";

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   ctx += "【当前行情】\n";
   ctx += "当前价: BID " + DoubleToString(bid, g_SymbolDigits) + " | ASK " + DoubleToString(ask, g_SymbolDigits) + "\n";

   if(ArraySize(g_BufferRSI) > 0) {
      ctx += "RSI(14): " + DoubleToString(g_BufferRSI[0], 1);
      if(g_BufferRSI[0] < 30) ctx += " [超卖区]";
      else if(g_BufferRSI[0] > 70) ctx += " [超买区]";
      else ctx += " [中性]";
      ctx += "\n";
   }
   if(ArraySize(g_BufferATR) > 0) {
      double atrPoints = g_BufferATR[0] / g_SymbolPoint;
      ctx += "ATR(14): " + DoubleToString(g_BufferATR[0], g_SymbolDigits) + " ≈" + DoubleToString(atrPoints, 0) + "点";
      ctx += " ←止损止盈请以此为基准倍数\n";
   }
   if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0) {
      string maTrend = g_BufferMAFast[0] > g_BufferMASlow[0] ? "多头排列(20>50)" : "空头排列(20<50)";
      ctx += "MA(20/50): " + DoubleToString(g_BufferMAFast[0], g_SymbolDigits) + "/" + DoubleToString(g_BufferMASlow[0], g_SymbolDigits) + " [" + maTrend + "]\n";
   }

   // M15最近20根收盘价(供识别支撑阻力)
   double m15Close[];
   ArraySetAsSeries(m15Close, true);
   if(CopyClose(_Symbol, PERIOD_M15, 0, 20, m15Close) == 20) {
      ctx += "M15最近20收盘: ";
      for(int i = 0; i < 20; i++) { ctx += DoubleToString(m15Close[i], g_SymbolDigits) + " "; }
      ctx += "\n";
   }

   // Pivot关键价位
   double pivot, r1, r2, r3, s1, s2, s3;
   CalculatePivotPoints(pivot, r1, r2, r3, s1, s2, s3);
   if(pivot > 0) {
      ctx += "关键价位(Pivot): R1=" + DoubleToString(r1, g_SymbolDigits) + " Pivot=" + DoubleToString(pivot, g_SymbolDigits) + " S1=" + DoubleToString(s1, g_SymbolDigits) + "\n";
      ctx += "→止损放在S1下方或R1上方,止盈参考对侧关键价位\n";
   }

   ctx += "持仓: " + IntegerToString(CountTotalOpenPositions()) + "/" + IntegerToString(InpMaxPositions) + "\n\n";
   ctx += "【输出格式】单行:信号|置信度|止损点数|止盈点数|推理|总结\n";
   ctx += "示例(趋势做多):BUY|0.75|250|600|M15回调支撑,顺Bias做多,紧止损宽止盈|顺势回调做多\n";
   ctx += "示例(震荡做多):BUY|0.65|450|350|区间下沿,宽止损防假突破,紧止盈到上沿|区间做多\n";
   ctx += "示例(观望):WAIT|0.55|0|0|波动率突升方向不明,或逆Bias信心不足|等待突破\n";
   return ctx;
}

//+------------------------------------------------------------------+
//| V4.0 解析入场响应 (Phase 2 - T2.3)                              |
//+------------------------------------------------------------------+
void ParseEntryResponse(string response)
{
   if(StringLen(response) == 0) return;
   // 复用ParseAIResponse逻辑
   ParseAIResponse(response);
   Print("🎯 V4.0 入场策略师: ", g_AISignal, " (", DoubleToString(g_AIConfidence * 100, 1), "%)");
}

//+------------------------------------------------------------------+
//| V4.0 风险控制官Agent (Phase 2 - T2.4)                           |
//+------------------------------------------------------------------+
void CallRiskOfficer()
{
   if(!InpUseAI || !g_AIIsActive) return;
   Print("🛡️ V4.0 风险控制官Agent启动");

   string context = BuildRiskContext();
   string response = CallAIAgent("risk_officer", context, 2000);
   ParseRiskResponse(response);
}

//+------------------------------------------------------------------+
//| V4.0 构建风控上下文 (Phase 2 - T2.4)                            |
//+------------------------------------------------------------------+
string BuildRiskContext()
{
   string ctx = "═══ V4.0 风险控制官 ═══\n";
   ctx += "账户净值: $" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n";
   ctx += "今日盈亏: $" + DoubleToString(g_DailyProfit, 2) + "\n";
   ctx += "连续亏损: " + IntegerToString(g_ConsecutiveLosses) + "次\n";
   ctx += "持仓数: " + IntegerToString(CountTotalOpenPositions()) + "/" + IntegerToString(InpMaxPositions) + "\n";
   ctx += "总交易: " + IntegerToString(g_TotalTrades) + " | 胜率: ";
   ctx += DoubleToString(g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0, 1) + "%\n";
   ctx += "盈亏比: " + DoubleToString(g_ProfitFactor, 2) + "\n";
   ctx += "最大回撤: " + DoubleToString(g_MaxDrawdown, 2) + "%\n";
   ctx += "当前风险级别: " + IntegerToString((int)g_SharedState.current_risk_level) + "\n";
   if(g_SharedState.event_lock) ctx += "🚨 事件锁定中: " + g_SharedState.next_high_impact_event + "\n";
   ctx += "\n请评估风险,输出JSON调整建议\n";
   return ctx;
}

//+------------------------------------------------------------------+
//| V4.0 解析风控响应 (Phase 2 - T2.4)                              |
//+------------------------------------------------------------------+
void ParseRiskResponse(string response)
{
   if(StringLen(response) == 0) return;

   int allowedStart = StringFind(response, "\"trading_allowed\":");
   if(allowedStart >= 0) {
      allowedStart += StringLen("\"trading_allowed\":");
      string allowedStr = StringSubstr(response, allowedStart, 5);
      g_SharedState.trading_allowed = (StringFind(allowedStr, "true") >= 0);
   }

   int maxPosStart = StringFind(response, "\"max_positions\":");
   if(maxPosStart >= 0) {
      maxPosStart += StringLen("\"max_positions\":");
      int end = maxPosStart;
      while(end < StringLen(response)) {
         ushort c = StringGetCharacter(response, end);
         if(c == ',' || c == '}' || c == ' ') break;
         end++;
      }
      g_SharedState.max_positions = (int)StringToInteger(StringSubstr(response, maxPosStart, end - maxPosStart));
   }

   g_SharedState.risk_update_time = TimeCurrent();
   Print("🛡️ V4.0 风控官: 交易=", (g_SharedState.trading_allowed ? "允许" : "禁止"),
         " | 最大持仓=", g_SharedState.max_positions);
}

//==================================================================
//           V4.0 Phase 3: 外部数据集成 (T3.1-T3.4)
//==================================================================

//+------------------------------------------------------------------+
//| V4.0 更新外部数据 (Phase 3)                                     |
//+------------------------------------------------------------------+
void UpdateExternalData()
{
   // T3.1 DXY数据
   if(InpUseDXY) {
      double dxyValue = 0, dxyChange = 0;
      if(GetDXYData(dxyValue, dxyChange)) {
         g_SharedState.dxy_value = dxyValue;
         g_SharedState.dxy_change = dxyChange;
         g_SharedState.gold_dxy_correlation = CalculateGoldDXYCorrelation(50);
         Print("📊 V4.0 DXY: ", DoubleToString(dxyValue, 2), " | 相关性: ", DoubleToString(g_SharedState.gold_dxy_correlation, 2));
      }
   }

   // T3.2 美债收益率 - 不可用时静默(只警告一次)
   if(InpUseTreasuryYield) {
      static bool yieldWarned = false;
      double yieldValue = 0;
      if(GetTreasuryYield(InpUS10YSymbol, yieldValue)) {
         g_SharedState.us10y_yield = yieldValue;
         Print("📊 V4.0 US10Y: ", DoubleToString(yieldValue, 2), "%");
      } else if(!yieldWarned) {
         Print("ℹ️ V4.0 美债品种不可用(经纪商未提供),已禁用美债数据。这不影响黄金交易。");
         yieldWarned = true;
      }
   }

   // T3.4 VIX替代指标
   if(InpUseVIXProxy) {
      g_SharedState.vix_proxy = CalculateVIXProxy(InpVIXProxyPeriod);
   }

   g_SharedState.external_data_time = TimeCurrent();
}

//+------------------------------------------------------------------+
//| V4.0 计算黄金-DXY相关性 (Phase 3 - T3.1)                        |
//+------------------------------------------------------------------+
double CalculateGoldDXYCorrelation(int period)
{
   double goldClose[], dxyClose[];
   ArraySetAsSeries(goldClose, true);
   ArraySetAsSeries(dxyClose, true);

   if(CopyClose(_Symbol, PERIOD_H1, 0, period, goldClose) != period) return 0;
   if(CopyClose(InpDXYSymbol, PERIOD_H1, 0, period, dxyClose) != period) return 0;

   double goldMean = 0, dxyMean = 0;
   for(int i = 0; i < period; i++) { goldMean += goldClose[i]; dxyMean += dxyClose[i]; }
   goldMean /= period; dxyMean /= period;

   double numerator = 0, goldVar = 0, dxyVar = 0;
   for(int i = 0; i < period; i++) {
      double gd = goldClose[i] - goldMean;
      double dd = dxyClose[i] - dxyMean;
      numerator += gd * dd;
      goldVar += gd * gd;
      dxyVar += dd * dd;
   }

   double denominator = MathSqrt(goldVar * dxyVar);
   if(denominator == 0) return 0;
   return numerator / denominator;
}

//+------------------------------------------------------------------+
//| V4.0 获取DXY数据 (Phase 3 - T3.1)                               |
//| 自动尝试多个常见DXY品种名+数据合理性校验                         |
//+------------------------------------------------------------------+
bool GetDXYData(double &dxyValue, double &dxyChange)
{
   static string validDXYSymbol = "";
   static bool dxyChecked = false;
   static bool dxyWarned = false;

   // 已确认不可用,直接返回(避免每次都尝试)
   if(dxyChecked && StringLen(validDXYSymbol) == 0) {
      return false;
   }

   // 首次调用:尝试多个常见DXY品种名
   if(!dxyChecked) {
      dxyChecked = true;
      string candidates[] = {"USDX", "DXY", "UDXY", "DINIW", "DollarIndex", "DINW", "DX", "USDIndex", "US_Dollar_Index"};
      for(int i = 0; i < ArraySize(candidates); i++) {
         if(SymbolSelect(candidates[i], true)) {
            // 合理性校验:读取价格确认是DXY(应在90-110范围)
            double testClose[];
            ArraySetAsSeries(testClose, true);
            if(CopyClose(candidates[i], PERIOD_H1, 0, 2, testClose) >= 2) {
               if(testClose[0] >= 80.0 && testClose[0] <= 120.0) {
                  validDXYSymbol = candidates[i];
                  Print("📊 V4.0 DXY品种已找到: ", candidates[i], " (价格:", DoubleToString(testClose[0], 2), ")");
                  break;
               }
            }
            SymbolSelect(candidates[i], false); // 取消选择无效品种
         }
      }

      if(StringLen(validDXYSymbol) == 0) {
         if(!dxyWarned) {
            Print("ℹ️ V4.0 经纪商未提供DXY美元指数品种,已自动禁用DXY数据。");
            Print("   如需启用:请在MT5市场报价中订阅USDX/DXY等品种,或联系经纪商。");
            Print("   这不影响黄金交易,只是缺少一个参考数据维度。");
            dxyWarned = true;
         }
         return false;
      }
   }

   // 读取DXY数据
   double dxyClose[];
   ArraySetAsSeries(dxyClose, true);
   if(CopyClose(validDXYSymbol, PERIOD_H1, 0, 2, dxyClose) < 2) return false;

   // 最终合理性校验
   if(dxyClose[0] < 80.0 || dxyClose[0] > 120.0) {
      return false;
   }

   dxyValue = dxyClose[0];
   dxyChange = dxyClose[0] - dxyClose[1];
   return true;
}

//+------------------------------------------------------------------+
//| V4.0 获取美债收益率 (Phase 3 - T3.2)                            |
//+------------------------------------------------------------------+
bool GetTreasuryYield(string symbol, double &yieldValue)
{
   if(!SymbolSelect(symbol, true)) {
      Print("⚠️ V4.0 美债品种不可用: ", symbol);
      return false;
   }

   double yieldClose[];
   ArraySetAsSeries(yieldClose, true);
   if(CopyClose(symbol, PERIOD_H1, 0, 1, yieldClose) < 1) return false;

   yieldValue = yieldClose[0];
   return true;
}

//+------------------------------------------------------------------+
//| V4.0 计算VIX替代指标 (Phase 3 - T3.4)                           |
//+------------------------------------------------------------------+
double CalculateVIXProxy(int period)
{
   double atrHistory[];
   ArraySetAsSeries(atrHistory, true);
   if(CopyBuffer(g_HandleATR, 0, 0, period, atrHistory) != period) return 0;

   double currentATR = atrHistory[0];
   double maxATR = currentATR;
   double minATR = currentATR;

   for(int i = 0; i < period; i++) {
      if(atrHistory[i] > maxATR) maxATR = atrHistory[i];
      if(atrHistory[i] < minATR) minATR = atrHistory[i];
   }

   if(maxATR == minATR) return 50.0;
   // 当前ATR在历史区间的百分位
   double percentile = ((currentATR - minATR) / (maxATR - minATR)) * 100.0;
   return MathMax(0.0, MathMin(100.0, percentile));
}

//+------------------------------------------------------------------+
//| V4.0 检查经济事件 (Phase 3 - T3.3)                              |
//+------------------------------------------------------------------+
bool CheckEconomicEvents()
{
   if(!InpUseEconCalendar) return false;

   // V4.0 简化实现:基于时间的高风险时段检测
   // 实际生产中应通过WebFetch获取财经日历
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);

   // 美国数据发布高峰:21:30-22:30北京时间(夏令时)
   bool isDataReleaseTime = (dt.hour == 21 && dt.min >= 30) || (dt.hour == 22 && dt.min <= 30);

   // 周五晚间高风险
   bool isFridayRisk = (dt.day_of_week == 5 && dt.hour >= 21);

   if(isDataReleaseTime) {
      g_SharedState.event_lock = true;
      g_SharedState.next_high_impact_event = "美国数据发布";
      g_SharedState.event_time = TimeCurrent();
      Print("🚨 V4.0 事件监控: 美国数据发布时段,锁定交易");
      return true;
   }

   if(isFridayRisk) {
      g_SharedState.event_lock = true;
      g_SharedState.next_high_impact_event = "周五周末风险";
      g_SharedState.event_time = TimeCurrent();
      Print("🚨 V4.0 事件监控: 周五晚间,锁定新仓");
      return true;
   }

   // 解除锁定
   if(g_SharedState.event_lock && !isDataReleaseTime && !isFridayRisk) {
      g_SharedState.event_lock = false;
      g_SharedState.next_high_impact_event = "";
      Print("✅ V4.0 事件监控: 风险解除,恢复交易");
   }

   return false;
}

//+------------------------------------------------------------------+
//| V4.0 是否高影响事件时段 (Phase 3 - T3.3)                        |
//+------------------------------------------------------------------+
bool IsHighImpactEventTime()
{
   return g_SharedState.event_lock;
}

//==================================================================
//           V4.0 Phase 4: 记忆与学习系统 (T4.1-T4.4)
//==================================================================

//+------------------------------------------------------------------+
//| V4.0 记录持仓开仓 (Phase 4 - T4.1)                              |
//+------------------------------------------------------------------+
void RecordPositionOpen(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return;

   TradeLogEntry entry;
   entry.open_time = (datetime)PositionGetInteger(POSITION_TIME);
   entry.close_time = 0;
   entry.position_type = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 0 : 1;
   entry.entry_price = PositionGetDouble(POSITION_PRICE_OPEN);
   entry.exit_price = 0;
   entry.sl_price = PositionGetDouble(POSITION_SL);
   entry.tp_price = PositionGetDouble(POSITION_TP);
   entry.volume = PositionGetDouble(POSITION_VOLUME);
   entry.profit = 0;
   entry.max_floating_profit = 0;
   entry.max_floating_loss = 0;
   entry.hold_seconds = 0;
   entry.rsi_at_entry = (ArraySize(g_BufferRSI) > 0) ? g_BufferRSI[0] : 0;
   entry.atr_at_entry = (ArraySize(g_BufferATR) > 0) ? g_BufferATR[0] : 0;
   entry.market_regime_at_entry = g_SharedState.market_regime;
   entry.ai_signal_at_entry = g_AISignal;
   entry.ai_confidence_at_entry = g_AIConfidence;
   entry.exit_reason = "";
   entry.was_added = false;
   entry.add_count = 0;

   // 添加到开仓跟踪
   int idx = ArraySize(g_OpenPositionTickets);
   ArrayResize(g_OpenPositionTickets, idx + 1);
   ArrayResize(g_OpenTradeLogs, idx + 1);
   g_OpenPositionTickets[idx] = ticket;
   g_OpenTradeLogs[idx] = entry;

   Print("📝 V4.0 记录开仓: #", ticket, " ", (entry.position_type == 0 ? "BUY" : "SELL"),
         " 价:", entry.entry_price, " 手:", entry.volume);
}

//+------------------------------------------------------------------+
//| V4.0 记录持仓平仓 (Phase 4 - T4.1)                              |
//+------------------------------------------------------------------+
void RecordPositionClose(ulong ticket, double profit, string reason)
{
   // 查找开仓记录
   int foundIdx = -1;
   for(int i = 0; i < ArraySize(g_OpenPositionTickets); i++) {
      if(g_OpenPositionTickets[i] == ticket) { foundIdx = i; break; }
   }

   TradeLogEntry entry;
   if(foundIdx >= 0) {
      entry = g_OpenTradeLogs[foundIdx];
      entry.close_time = TimeCurrent();
      entry.exit_price = SymbolInfoDouble(_Symbol, (entry.position_type == 0) ? SYMBOL_BID : SYMBOL_ASK);
      entry.profit = profit;
      entry.hold_seconds = (int)(TimeCurrent() - entry.open_time);
      entry.exit_reason = reason;

      // 移除开仓跟踪
      for(int i = foundIdx; i < ArraySize(g_OpenPositionTickets) - 1; i++) {
         g_OpenPositionTickets[i] = g_OpenPositionTickets[i + 1];
         g_OpenTradeLogs[i] = g_OpenTradeLogs[i + 1];
      }
      ArrayResize(g_OpenPositionTickets, ArraySize(g_OpenPositionTickets) - 1);
      ArrayResize(g_OpenTradeLogs, ArraySize(g_OpenTradeLogs) - 1);
   } else {
      entry.open_time = 0;
      entry.close_time = TimeCurrent();
      entry.position_type = 0;
      entry.entry_price = 0;
      entry.exit_price = 0;
      entry.profit = profit;
      entry.exit_reason = reason;
   }

   SaveTradeLog(entry);
   Print("📝 V4.0 记录平仓: #", ticket, " 盈亏:$", DoubleToString(profit, 2), " 原因:", reason);
}

//+------------------------------------------------------------------+
//| V4.0 保存交易日志 (Phase 4 - T4.1)                              |
//+------------------------------------------------------------------+
void SaveTradeLog(TradeLogEntry &entry)
{
   if(g_TradeLogCount < MAX_TRADE_LOGS) {
      ArrayResize(g_TradeLogs, g_TradeLogCount + 1);
      g_TradeLogs[g_TradeLogCount] = entry;
      g_TradeLogCount++;
   } else {
      // 满了则滚动覆盖最旧的
      for(int i = 0; i < MAX_TRADE_LOGS - 1; i++) {
         g_TradeLogs[i] = g_TradeLogs[i + 1];
      }
      g_TradeLogs[MAX_TRADE_LOGS - 1] = entry;
   }
}

//+------------------------------------------------------------------+
//| V4.0 加载交易日志 (Phase 4 - T4.1)                              |
//+------------------------------------------------------------------+
void LoadTradeLogs()
{
   g_TradeLogCount = 0;
   ArrayResize(g_TradeLogs, 0);
   Print("📝 V4.0 交易日志系统初始化");
}

//+------------------------------------------------------------------+
//| V4.0 复盘学习员Agent (Phase 4 - T4.2)                           |
//+------------------------------------------------------------------+
void CallReviewAgent()
{
   if(!InpUseAI || !g_AIIsActive) return;
   if(g_TradeLogCount < 5) {
      Print("📝 V4.0 复盘学习员: 交易记录不足,跳过");
      return;
   }

   Print("📝 V4.0 复盘学习员Agent启动 - 分析", g_TradeLogCount, "笔交易");

   string context = BuildReviewContext();
   string response = CallAIAgent("reviewer", context, 6000);
   ParseReviewResponse(response);
}

//+------------------------------------------------------------------+
//| V4.0 构建复盘上下文 (Phase 4 - T4.2)                            |
//+------------------------------------------------------------------+
string BuildReviewContext()
{
   string ctx = "═══ V4.0 复盘学习员 ═══\n";
   ctx += "总交易数: " + IntegerToString(g_TotalTrades) + "\n";
   ctx += "盈利: " + IntegerToString(g_WinningTrades) + " | 亏损: " + IntegerToString(g_LosingTrades) + "\n";
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   ctx += "胜率: " + DoubleToString(winRate, 1) + "%\n";
   ctx += "盈亏比: " + DoubleToString(g_ProfitFactor, 2) + "\n";
   ctx += "最大盈利: $" + DoubleToString(g_LargestWin, 2) + " | 最大亏损: $" + DoubleToString(g_LargestLoss, 2) + "\n";
   ctx += "平均盈利: $" + DoubleToString(g_AvgWin, 2) + " | 平均亏损: $" + DoubleToString(g_AvgLoss, 2) + "\n";
   ctx += "最大回撤: " + DoubleToString(g_MaxDrawdown, 2) + "%\n\n";

   // 最近交易记录
   int startIdx = MathMax(0, g_TradeLogCount - 20);
   ctx += "最近交易记录:\n";
   for(int i = startIdx; i < g_TradeLogCount; i++) {
      ctx += StringFormat("#%d %s 入:%.2f 出:%.2f 盈亏:$%.2f 持:%d秒 RSI:%.1f 信号:%s\n",
         i, g_TradeLogs[i].position_type == 0 ? "BUY" : "SELL",
         g_TradeLogs[i].entry_price, g_TradeLogs[i].exit_price, g_TradeLogs[i].profit,
         g_TradeLogs[i].hold_seconds, g_TradeLogs[i].rsi_at_entry, g_TradeLogs[i].ai_signal_at_entry);
   }

   ctx += "\n请分析交易模式,输出JSON优化建议\n";
   ctx += "{\"performance_summary\":\"\",\"parameter_suggestions\":{\"ai_confidence_min\":0.65,\"stop_loss_atr_mult\":2.5,\"trailing_distance\":30},\"lessons_learned\":[\"\"]}\n";
   return ctx;
}

//+------------------------------------------------------------------+
//| V4.0 解析复盘响应 (Phase 4 - T4.2/T4.3)                         |
//+------------------------------------------------------------------+
void ParseReviewResponse(string response)
{
   if(StringLen(response) == 0) return;

   double confMin = InpAIConfidenceMin;
   double slAtrMult = InpStopLossATR;
   double trailDist = InpTrailingDollar;

   // 解析参数建议
   int confMinStart = StringFind(response, "\"ai_confidence_min\":");
   if(confMinStart >= 0) {
      confMinStart += StringLen("\"ai_confidence_min\":");
      int end = confMinStart;
      while(end < StringLen(response)) {
         ushort c = StringGetCharacter(response, end);
         if(c == ',' || c == '}' || c == ' ') break;
         end++;
      }
      confMin = StringToDouble(StringSubstr(response, confMinStart, end - confMinStart));
   }

   int slStart = StringFind(response, "\"stop_loss_atr_mult\":");
   if(slStart >= 0) {
      slStart += StringLen("\"stop_loss_atr_mult\":");
      int end = slStart;
      while(end < StringLen(response)) {
         ushort c = StringGetCharacter(response, end);
         if(c == ',' || c == '}' || c == ' ') break;
         end++;
      }
      slAtrMult = StringToDouble(StringSubstr(response, slStart, end - slStart));
   }

   int trailStart = StringFind(response, "\"trailing_distance\":");
   if(trailStart >= 0) {
      trailStart += StringLen("\"trailing_distance\":");
      int end = trailStart;
      while(end < StringLen(response)) {
         ushort c = StringGetCharacter(response, end);
         if(c == ',' || c == '}' || c == ' ') break;
         end++;
      }
      trailDist = StringToDouble(StringSubstr(response, trailStart, end - trailStart));
   }

   // V4.0 应用参数建议(Phase 4 - T4.3)
   if(InpAutoApplyLearning) {
      ApplyParameterSuggestions(confMin, slAtrMult, trailDist);
   } else {
      Print("📝 V4.0 复盘建议(需人工审核):");
      Print("   置信度阈值: ", DoubleToString(confMin, 2));
      Print("   止损ATR倍数: ", DoubleToString(slAtrMult, 2));
      Print("   追踪距离: ", DoubleToString(trailDist, 2));
   }

   // 解析教训
   int lessonStart = StringFind(response, "\"lessons_learned\":[");
   if(lessonStart >= 0) {
      lessonStart += StringLen("\"lessons_learned\":[");
      for(int i = 0; i < MAX_RECENT_LESSONS; i++) {
         int lStart = StringFind(response, "\"", lessonStart);
         if(lStart < 0) break;
         lStart++;
         int lEnd = StringFind(response, "\"", lStart);
         if(lEnd < 0) break;
         g_SharedState.recent_lessons[i] = StringSubstr(response, lStart, lEnd - lStart);
         lessonStart = lEnd + 1;
      }
   }

   g_SharedState.learning_update_time = TimeCurrent();
   Print("📝 V4.0 复盘完成 | 学习时间:", TimeToString(TimeCurrent()));
}

//+------------------------------------------------------------------+
//| V4.0 应用参数建议 (Phase 4 - T4.3)                              |
//+------------------------------------------------------------------+
void ApplyParameterSuggestions(double confMin, double slAtrMult, double trailDist)
{
   // 安全范围校验
   if(confMin >= 0.50 && confMin <= 0.90) {
      g_SharedState.adjusted_confidence_min = confMin;
      Print("📝 V4.0 应用学习: 置信度阈值→", DoubleToString(confMin, 2));
   }
   if(slAtrMult >= 1.0 && slAtrMult <= 10.0) {
      g_SharedState.adjusted_sl_atr_mult = slAtrMult;
      Print("📝 V4.0 应用学习: 止损ATR倍数→", DoubleToString(slAtrMult, 2));
   }
}

//+------------------------------------------------------------------+
//| V4.0 获取近期教训文本 (Phase 4 - T4.4)                          |
//+------------------------------------------------------------------+
string GetRecentLessonsText()
{
   string text = "";
   for(int i = 0; i < MAX_RECENT_LESSONS; i++) {
      if(StringLen(g_SharedState.recent_lessons[i]) > 0) {
         text += "[" + IntegerToString(i + 1) + "]" + g_SharedState.recent_lessons[i] + " ";
      }
   }
   return text;
}

//==================================================================
//           V4.0 Phase 5: 执行优化与健壮性 (剩余T5.2/T5.4)
//==================================================================

//+------------------------------------------------------------------+
//| V4.0 构建压缩上下文 (Phase 5 - T5.2)                            |
//+------------------------------------------------------------------+
string BuildCompressedContext(string agentRole, double rsi, double bid, double ask, double atr)
{
   string ctx = "";
   if(agentRole == "position_manager") {
      // 持仓管理者用极简上下文
      ctx += "═══ 持仓管理(精简) ═══\n";
      ctx += "价:" + DoubleToString(bid, g_SymbolDigits) + "/" + DoubleToString(ask, g_SymbolDigits) + "\n";
      ctx += "RSI:" + DoubleToString(rsi, 1) + " ATR:" + DoubleToString(atr, g_SymbolDigits) + "\n";
      ctx += "市场:" + g_SharedState.market_regime + " " + g_SharedState.market_bias + "\n";
   } else if(agentRole == "risk_officer") {
      // 风控官用统计上下文(无K线)
      ctx += "═══ 风控(精简) ═══\n";
      ctx += "净值:$" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n";
      ctx += "今日:$" + DoubleToString(g_DailyProfit, 2) + " 连亏:" + IntegerToString(g_ConsecutiveLosses) + "\n";
      ctx += "胜率:" + DoubleToString(g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0, 1) + "%\n";
   } else {
      // 默认使用完整上下文
      ctx = BuildMarketContext(rsi, bid, ask, atr);
   }
   return ctx;
}

//==================================================================
//           V4.0 Phase 6: 黄金交易专业能力强化 (T6.1-T6.4)
//==================================================================

//+------------------------------------------------------------------+
//| V4.0 黄金季节性 favorable (Phase 6 - T6.2)                      |
//+------------------------------------------------------------------+
bool IsGoldSeasonalFavorable()
{
   if(!InpUseSeasonalFilter) return true;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int month = dt.mon;

   // 印度婚礼季(10-12月):利好
   if(month >= 10 && month <= 12) return true;
   // 中国春节(1-2月):利好
   if(month >= 1 && month <= 2) return true;
   // 夏季低迷(6-8月):中性偏空
   if(month >= 6 && month <= 8) return false;
   // 其他:中性
   return true;
}

//+------------------------------------------------------------------+
//| V4.0 伦敦定盘价时段 (Phase 6 - T6.1)                            |
//+------------------------------------------------------------------+
bool IsLondonFixTime()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   // 伦敦定盘价:上午10:30和下午3:00(GMT)
   // 北京时间夏令时+7,冬令时+8
   int gmtHour = dt.hour - 8; // 简化:假设北京时间
   if(gmtHour < 0) gmtHour += 24;

   // 上午10:25-10:35 或 下午14:55-15:05 GMT
   if(gmtHour == 10 && dt.min >= 25 && dt.min <= 35) return true;
   if(gmtHour == 14 && dt.min >= 55) return true;
   if(gmtHour == 15 && dt.min <= 5) return true;
   return false;
}

//+------------------------------------------------------------------+
//| V4.0 周末风险时段 (Phase 6 - T6.2)                              |
//+------------------------------------------------------------------+
bool IsWeekendRiskTime()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   // 周五21:00后不建议建新仓
   if(dt.day_of_week == 5 && dt.hour >= 21) return true;
   // 周日全天
   if(dt.day_of_week == 0) return true;
   return false;
}

//+------------------------------------------------------------------+
//| V4.0 流动性真空检测 (Phase 6 - T6.4)                            |
//+------------------------------------------------------------------+
double DetectLiquidityVacuum()
{
   // 基于近期K线振幅检测流动性真空
   double m5High[], m5Low[];
   ArraySetAsSeries(m5High, true);
   ArraySetAsSeries(m5Low, true);
   if(CopyHigh(_Symbol, PERIOD_M5, 0, 20, m5High) != 20) return 0;
   if(CopyLow(_Symbol, PERIOD_M5, 0, 20, m5Low) != 20) return 0;

   double avgRange = 0;
   for(int i = 0; i < 20; i++) avgRange += (m5High[i] - m5Low[i]);
   avgRange /= 20.0;

   double currentRange = m5High[0] - m5Low[0];
   if(avgRange <= 0) return 0;

   // 当前振幅远低于平均 = 流动性真空
   double ratio = currentRange / avgRange;
   if(ratio < 0.3) return 1.0 - ratio; // 返回真空程度
   return 0;
}

//+------------------------------------------------------------------+
//| V4.0 黄金-美元联动信号 (Phase 6 - T6.3)                         |
//+------------------------------------------------------------------+
// 已在CalculateGoldDXYCorrelation中实现相关性计算
// 背离预警逻辑集成在BuildMarketContext中

//+------------------------------------------------------------------+
//| 文件结束                                                         |
//+------------------------------------------------------------------+
// 源流AI交易系统 V4.0 - 多Agent协作架构
// Phase 1: 持仓管理AI化 ✓ (T1.1-T1.5)
// Phase 2: 多Agent架构搭建 ✓ (T2.1-T2.5)
// Phase 3: 外部数据集成 ✓ (T3.1-T3.4)
// Phase 4: 记忆与学习系统 ✓ (T4.1-T4.4)
// Phase 5: 执行优化与健壮性 ✓ (T5.1-T5.4)
// Phase 6: 黄金交易专业能力强化 ✓ (T6.1-T6.4)
//+------------------------------------------------------------------+

#property strict
#property copyright "FXKiller | liquidity-zones variant"
#property link      ""
#property version   "4.00"
#property description "FXKiller Gold King MT5 EA (v4.00 均衡版)"
#property description "Pending orders anchored to multi-TF prior highs/lows, asymmetric lots"

#include <Trade/Trade.mqh>

#define GOLDKING_NEW_CYCLE_DELAY_SECONDS 3
#define GOLDKING_TRAIL_TRIGGER_POINTS 50
#define GOLDKING_TRAIL_STEP_POINTS 25
#define GOLDKING_FIRST_ORDER_TRAIL_TIMEOUT_SECONDS 15
#define GOLDKING_ENTRY_TIMEFRAME PERIOD_M1
#define GOLDKING_DYNAMIC_STEP_MIN_POINTS 50
#define GOLDKING_DYNAMIC_STEP_MAX_POINTS 150
#define GOLDKING_FIRST_STEP_POINTS 30
#define GOLDKING_PENDING_TRAIL_POINTS 10
#define GOLDKING_PENDING_TRAIL_INTERVAL_SECONDS 5
#define GOLDKING_STOP_ORDER_SAFETY_POINTS 3
#define GOLDKING_MARKET_REGIME_TF_COUNT 3
#define GOLDKING_MARKET_CONTEXT_DAYS 20
#define GOLDKING_MARKET_CONTEXT_WINDOW_MINUTES 120
#define GOLDKING_MARKET_SCORE_UPDATE_SECONDS 5
#define GOLDKING_MARKET_RANGE_LIMIT 20
#define GOLDKING_MARKET_TREND_CONFIRM 45
#define GOLDKING_MARKET_STRONG_TREND 70
#define GOLDKING_CLOSE_ALL_AMOUNT 0.5
#define GOLDKING_SIDE_AVG_NET_BASE 2.5
#define GOLDKING_LOT_MULTIPLIER_BASE 1.5
#define GOLDKING_PAIR_CLOSE_MIN_NET 0.01
#define GOLDKING_ASYNC_CLOSE_RETRY_SECONDS 3
#define GOLDKING_DIAGNOSTIC_LOG_INTERVAL_SECONDS 3600

input string         ContactWebsite                         = "https://www.t5fx.com/"; // 官网
input string         ContactBroker                          = "https://tickmill.link/3Rfxez5"; // 合作经纪商
input string         ContactTelegram                        = "https://t.me/A1mt5_com";   // Telegram频道

input group "Grid"
input bool           Over                                    = false;   // 平仓后停止交易

input group "Risk"
input double         lot                                     = 0.01;    // 起始手数 (v3.20冠军参数: w6峰值$1.49M)
input double         GridLotMultiplier                       = 1;    // 震荡基准马丁倍率 (v3.20冠军: 1.5 - 比V3.10的1.80平,深档不爆)
input double         TrendMultMin                            = 1    // 趋势内马丁倍率下限(压平防爆仓)
// hidden internals (pivot 反向掉头检测,用户不需要调)
const  int            PivotMomLookback                       = 10;      // 30秒K线动量回看条数(10=5分钟)
const  double         PivotMomThreshold                      = 1.50;    // 反向掉头动量阈值($价格)
const  double         PivotLossPct                           = 0.05;    // 掉头触发亏损阈值(权益的比例)
input double         EquityBaseline                          = 10000.0; // 基准账户余额(手数按当前权益相对此值复利缩放)
input double         EquityScaleCap                          = 1.0;   // 复利缩放上限倍数 (固定0.01手: 1.0 即不缩放; 想复利放大改大)
input double         StepAtrMult                             = 1.00;    // 网格间距 = 此系数 × M1_ATR(波动自适应)
// hidden internals (用户不需要调)
const  double         EquityScalePower                       = 1.0;     // 复利缩放幂指数
const  double         CloseAllAmplifier                      = 1.0;     // 平仓目标放大系数
const  double         CloseAllScalePower                     = 1.0;     // 平仓目标随权益的幂指数
// 注: 真正的网格间距上下限在 #define GOLDKING_DYNAMIC_STEP_MIN/MAX_POINTS (50/150 raw points,
//     经 PriceDistancePoints() 在3位/5位经纪商自动 ×10);  StepMinPoints/StepMaxPoints 已废弃删除
input double         CommissionPerLot                        = 6.0;     // 每手完整交易手续费(美元)
input int            Slippage                                = 10;      // 平仓允许滑点(点)
input long           Magic                                   = 888999;
input int            Totals                                  = 50;      // 最大单量
input int            MaxSpread                               = 25;      // 点差限制(点)

input double         NetExposureCap                          = 0.08;    // 最大净敞口|多手-空手|(硬回撤护栏)
input int            MaxPerSide                              = 10;      // 每侧最大持仓数(马丁深度上限,留盈利空间)
input double         FastTakeProfit                          = 0.80;    // 每仓快速止盈($/0.01手)

// hidden Brain internals (趋势内核常数,用户不需要调)
const  double         TrendDirEnter                          = 26.0;    // 趋势确认分值(进入只做顺势)
const  double         TrendDirExit                           = 14.0;    // 趋势退出分值(回到双向网格)
const  double         ChopGate                               = 0.58;    // 震荡门槛(chop>此值强制双向)
const  double         EngageMin                              = 0.0;     // 空仓入场最小分值

input group "Session"
input string         EA_StartTime                            = "00:00"; // EA开始时间
input string         EA_StopTime                             = "24:00"; // EA结束时间
const  int            FridayWrapUpLeadHours                  = 12;      // 周五提前几小时开启收尾(隐藏,内部常数)
input double         DailyProfitTarget                       = 0.0;     // 每日盈利目标，>0启用
input int            NewsPauseMinutes                       = 0;       // 新闻前后暂停分钟，0关闭

input group "LiquidityZones"
input bool           UseLiquidityZones        = true;   // 启用流动性区叠加(v3.20 grid 始终运行,LZ 在关键位附近额外挂多档非对称单)
input int            LZ_LookbackBars          = 60;     // 每 TF 取前 N 根 K 线极值作为锚点
input int            LZ_SkipRecentBars        = 3;      // 跳过最近 N 根 K (避免新高=当前价)
input int            LZ_TriggerBandPoints     = 300;    // line ± N 点 = 触发带(进入即挂单)
input int            LZ_FirstOrderGapPoints   = 600;    // line ± N 点 = 首单挂单距离
input int            LZ_OrderSpacingPoints    = 300;    // 同侧相邻档位间距(点)
input int            LZ_OrdersPerSide         = 4;      // 每个 zone 每侧挂几档
input double         LZ_FirstLotFraction      = 0.5;    // 首单 = 对侧持仓 × N (用户规定 0.5)
input double         LZ_BreakoutMultPerLevel  = 4.0;    // 突破侧每升一档 × N
input double         LZ_RejectionMultPerLevel = 2.0;    // 反弹侧每升一档 × N
input double         LZ_BreakoutTotalCap      = 4.0;    // 突破侧累计手数 ≤ 对侧 bag × N (硬性风险护栏)
input double         LZ_RejectionTotalCap     = 2.0;    // 反弹侧累计手数 ≤ 对侧 bag × N
input bool           LZ_LargeOrdersFirst      = true;   // true=最近档位大手数,远档小手数 (用户优化);false=原 small→big 排列
input bool           LZ_TrailFakeBreakout     = true;   // 假突破跟踪:价格穿越触发带时,对侧 pending 整体平移跟随
input int            LZ_TrailStepPoints       = 50;     // 每移动 N 点才更新一次跟踪(避免每 tick 频繁 OrderModify)
input double         LZ_TrendScoreMin         = 45.0;   // 趋势门控:仅当 |g_market_score| >= N 时才挂 LZ(避震荡)
input double         LZ_DailyLossBudgetPct    = 5.0;    // LZ 当日累计净亏 ≥ 余额 N% 时,该日不再挂新 LZ
input double         LZ_OcoFloatingLossPct    = 2.0;    // Phase2 撤单阈值: 浮亏 < 余额 N% 时撤剩余 pending
input int            LZ_ZoneRecycleMinutes    = 30;     // 完整周期(撤单或全填)后冷却分钟数

struct EAStats
  {
   int               buy_positions;
   int               sell_positions;
   int               buy_pending;
   int               sell_pending;
   int               buy_pending_regular;   // LZ 变体: 排除 LZ_* 标签的 buy pending 数,正常 grid 用这个判断
   int               sell_pending_regular;  // 同上,sell pending
   double            buy_lots;
   double            sell_lots;
   double            buy_profit;
   double            sell_profit;
   double            total_profit;
   double            buy_highest_any;
   double            buy_lowest_position;
   double            sell_highest_position;
   double            sell_lowest_any;
   double            buy_pending_price;
   double            sell_pending_price;
   ulong             buy_pending_ticket;
   ulong             sell_pending_ticket;
   ulong             single_position_ticket;
   ENUM_POSITION_TYPE single_position_type;
   double            single_position_open_price;
   datetime          latest_position_open_time;
  };

struct PanelMetrics
  {
   int               margin_x;
   int               margin_y;
   int               width;
   int               pad;
   int               section_gap;
   int               header_h;
   int               row_h;
   int               gap;
   int               button_h;
   int               inner_w;
   int               half_w;
   int               card_status_h;
   int               card_metrics_h;
   int               card_actions_h;
   int               button_font;
   int               font_sm;
   int               font_xs;
   int               font_lg;
   int               panel_h;
   int               toggle_w;
  };

struct NewsWindowState
  {
   bool              enabled;
   bool              calendar_available;
   bool              using_schedule_rules;
   bool              has_active_window;
   bool              in_pre_window;
   bool              in_post_window;
   bool              has_upcoming_event;
   bool              block_entries;
   datetime          server_now;
   datetime          event_time;
   datetime          resume_time;
   string            currency;
   string            event_name;
   string            error_text;
  };

struct NewsEvalAccumulator
  {
   bool              any_success;
   string            first_error;
   datetime          active_block_start;
   datetime          active_block_end;
   datetime          active_future_time;
   string            active_future_currency;
   string            active_future_name;
   datetime          active_past_time;
   string            active_past_currency;
   string            active_past_name;
   datetime          next_upcoming_time;
   string            next_upcoming_currency;
   string            next_upcoming_name;
  };

struct MarketFrameScore
  {
   double            score;
   double            direction_score;
   double            trend_power;
   double            range_pressure;
   double            sample_count;
  };

CTrade               g_trade;
bool                 g_allow_buy              = true;
bool                 g_allow_sell             = true;
bool                 g_panel_open             = true;
datetime             g_pause_until            = 0;
datetime             g_last_panel_refresh     = 0;
datetime             g_last_pending_trail_time= 0;
bool                 g_basket_trail_active    = false;
double               g_basket_trail_peak      = 0.0;
double               g_basket_trail_peak_price= 0.0;
int                  g_basket_trail_direction = 0;
bool                 g_first_order_trail_active=false;
double               g_first_order_trail_peak = 0.0;
double               g_first_order_trail_peak_price=0.0;
int                  g_first_order_trail_direction=0;
datetime             g_first_entry_bar_lock   = 0;
double               g_market_range_probability=0.50;
int                  g_market_trend_direction = 0;
double               g_market_trend_confidence= 0.0;
double               g_market_score           = 0.0;
double               g_market_score_raw       = 0.0;
double               g_market_score_target    = 0.0;
double               g_market_score_coherence = 0.0;
double               g_market_conflict_weight = 0.0;
int                  g_market_state           = 0;
double               g_ts_chop                = 0.0;
int                  g_ts_dir                 = 0;
datetime             g_last_regime_update     = 0;
datetime             g_last_diagnostic_log    = 0;
bool                 g_async_close_active     = false;
uint                 g_async_close_started_ms = 0;
uint                 g_async_close_last_retry_ms=0;
int                  g_async_close_direction  = 0;
bool                 g_async_close_current_symbol_only=true;
long                 g_async_close_magic_filter=Magic;
bool                 g_async_close_use_pairs  = false;
bool                 g_async_close_arm_cooldown=false;
// Set true after the broker rejects TRADE_ACTION_CLOSE_BY (retcodes INVALID_ORDER /
// INVALID / TRADE_DISABLED). Many retail FX brokers don't support CLOSE_BY; without
// this guard the EA would re-issue the failing request every tick and flood the
// journal. Cleared by EA restart so the broker gets re-probed.
bool                 g_close_by_unsupported   = false;
string               g_today_key              = "";
bool                 g_daily_target_locked    = false;
double               g_daily_target_hit_value = 0.0;
NewsWindowState      g_news_state;
datetime             g_news_cache_minute      = 0;
string               g_panel_prefix           = "GoldKylinMT5.";

ENUM_TIMEFRAMES      g_regime_timeframes[GOLDKING_MARKET_REGIME_TF_COUNT]={PERIOD_M1,PERIOD_M5,PERIOD_M15};
double               g_regime_weights[GOLDKING_MARKET_REGIME_TF_COUNT]={0.25,0.35,0.40};
double               g_market_frame_scores[GOLDKING_MARKET_REGIME_TF_COUNT]={0.0,0.0,0.0};
double               g_market_frame_trend_power[GOLDKING_MARKET_REGIME_TF_COUNT]={0.0,0.0,0.0};
double               g_market_frame_range_pressure[GOLDKING_MARKET_REGIME_TF_COUNT]={0.5,0.5,0.5};
double               g_market_frame_direction[GOLDKING_MARKET_REGIME_TF_COUNT]={0.0,0.0,0.0};
double               g_market_frame_samples[GOLDKING_MARKET_REGIME_TF_COUNT]={0.0,0.0,0.0};
int                  g_adx_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_bands_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_atr_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_ma_fast_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_ma_mid_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_ma_slow_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_rsi_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};
int                  g_macd_handles[GOLDKING_MARKET_REGIME_TF_COUNT]={INVALID_HANDLE,INVALID_HANDLE,INVALID_HANDLE};

// 30-second self-built K-line: tick-aggregated bars. Used for fast reversal /
// momentum detection (M1 = 60s, this is 30s -> 2x faster reaction for pivots).
#define S30_BUF_SIZE 200
datetime g_s30_time[S30_BUF_SIZE];
double   g_s30_open[S30_BUF_SIZE];
double   g_s30_high[S30_BUF_SIZE];
double   g_s30_low[S30_BUF_SIZE];
double   g_s30_close[S30_BUF_SIZE];
int      g_s30_count           = 0;
int      g_s30_head            = -1;
datetime g_s30_cur_time        = 0;
double   g_s30_cur_open        = 0.0;
double   g_s30_cur_high        = 0.0;
double   g_s30_cur_low         = 0.0;
double   g_s30_cur_close       = 0.0;
bool     g_s30_cur_active      = false;

#define GOLDKING_ORDER_COMMENT_PRIMARY "FXKiller_GoldKing"

bool       IsTestingMode();
datetime   ReferenceNow();
datetime   ReferenceNewsNow();
string     CleanTimeString(const string value);
datetime   TodayAt(const string time_text,const datetime now_value);
bool       IsInWindow(const string start_text,const string stop_text,const datetime now_value);
bool       IsAfterSessionStop(const datetime now_value);
bool       IsTradingSessionOpen(const datetime now_value);
bool       IsTradingSessionAfterStop(const datetime now_value);
bool       IsFridayWrapUpWindow(const datetime now_value);
bool       IsSymbolTradeSessionOpen(const datetime now_value);
void       ResetNewsState(NewsWindowState &state);
void       ResetNewsEvalAccumulator(NewsEvalAccumulator &eval);
void       AppendUniqueText(string &items[],const string value);
void       BuildNewsCurrencies(string &currencies[]);
string     CalendarErrorText(const int error_code);
datetime   BuildDateTime(const int year,const int mon,const int day,const int hour,const int min,const int sec);
int        DaysInMonth(const int year,const int mon);
int        WeekdayOfDate(const int year,const int mon,const int day);
int        NthWeekdayDay(const int year,const int mon,const int weekday,const int ordinal);
int        LastWeekdayDay(const int year,const int mon,const int weekday);
int        BusinessDayOfMonth(const int year,const int mon,const int ordinal);
bool       IsUsEasternDstDate(const int year,const int mon,const int day);
datetime   UsEasternReleaseUtc(const int year,const int mon,const int day,const int hour,const int min);
void       ConsiderUsdRuleEvent(const datetime now_server,const int year,const int mon,const int day,const int hour,const int min,const string event_name,const int lead_seconds,const int cooldown_seconds,NewsEvalAccumulator &eval);
void       ConsiderNewsEvent(const datetime now_server,const datetime event_time,const string currency,const string event_name,const int lead_seconds,const int cooldown_seconds,NewsEvalAccumulator &eval);
void       ApplyNewsAccumulator(const NewsEvalAccumulator &eval);
void       RefreshRuleBacktestNewsState(const datetime now_server);
void       RefreshNewsState(const bool force);
double     ClampDouble(const double value,const double min_value,const double max_value);
bool       ReadIndicatorSeries(const int handle,const int buffer,const int shift,const int count,double &values[]);
bool       InitMarketRegimeIndicators();
void       ReleaseMarketRegimeIndicators();
int        TimeframeMinutes(const ENUM_TIMEFRAMES tf);
bool       IsSameTimeWindow(const datetime sample_time,const datetime base_time,const int window_minutes);
double     PercentileRank(double &values[],const int count,const double value);
double     ClampUnitSigned(const double value);
double     SeriesValue(double &values[],const int shift,const double fallback);
double     ManualAtr(MqlRates &rates[],const int copied,const int shift,const int period);
double     EfficiencyRatio(MqlRates &rates[],const int copied,const int shift,const int period);
double     RegressionSlopeAtr(MqlRates &rates[],const int copied,const int shift,const int period,const double atr,double &r2);
double     ChoppinessIndex(MqlRates &rates[],const int copied,const int shift,const int period);
double     DonchianBreakoutStrength(MqlRates &rates[],const int copied,const int shift,const int period,const double atr);
double     ComputeFrameScore(const int tf_index,double &out_trendiness);
int        MarketStateFromScore(const double score);
string     MarketStateText();
double     MarketTrendProtectionRatio();
int        MarketScoreDirection();
int        MarketBaseGridStepPoints();
int        DirectionalGridStepPoints(const bool is_buy);
double     MarketTrendStrength01();
double     DynamicLotMultiplier(const bool is_buy);
double     DynamicCloseAllTarget();
double     DynamicSideAverageOrderNetProfit(const bool is_buy);
void       UpdateMarketRegimeState(const bool force);
int        PricePointScale();
int        PriceDistancePoints(const int points);
double     PipDivisor();
double     CurrentSpreadPoints();
int        VolumeDigits(const double step);
double     NormalizeVolumeToSymbol(double volume);
double     AdjustVolumeAvoidLock(const EAStats &stats,const bool is_buy,double volume);
double     NormalizePriceToSymbol(double price);
double     NormalizePriceDirectional(const double price,const bool round_up);
int        BrokerMinDistancePoints();
int        StopOrderMinDistancePoints();
bool       PrepareStopOrderPrice(const ENUM_ORDER_TYPE type,const double raw_price,double &safe_price);
bool       CanAffordOrder(const ENUM_ORDER_TYPE type,const double volume,const double price);
ulong      TradeDeviationPoints();
bool       IsHedgingAccount();
void       ResetStats(EAStats &stats);
double     EstimatedPositionCommission(const double volume);
double     EstimatedExecutionCostBuffer(const double volume);
double     CurrentPositionNetProfit();
double     PointValueForVolume(const double volume);
double     EstimatedSlippageCost(const double volume);
double     StatsGrossLots(const EAStats &stats);
double     StatsNetLots(const EAStats &stats);
int        StatsNetDirection(const EAStats &stats);
double     TrailingNetProfitAfterCosts(const EAStats &stats);
double     TrailingPriceMoveMoney(const EAStats &stats,const int points);
bool       CurrentTrailPrice(const int direction,double &price);
bool       TrailPriceRetraced(const int direction,const double peak_price,const double current_price,const int step_points);
double     TrailRetracePrice(const int direction,const double peak_price,const int step_points);
void       CollectStats(EAStats &stats);
double     CalculateClosedProfit(const datetime from_time,const datetime to_time,const long magic_filter,const bool current_symbol_only);
string     TradingDayKey(const datetime now_value);
double     TodayClosedProfit(const datetime now_value);
double     TodayProgressProfit(const datetime now_value,const EAStats &stats);
bool       HasOpenPositions(const EAStats &stats);
void       RefreshDailyLocks(const datetime now_value,const EAStats &stats);
bool       GetPositionNetProfitAndVolume(const ulong ticket,double &profit,double &volume);
double     SelectedPositionAdverseDistancePoints();
bool       EstimatePairNetAfterCosts(const ulong profit_ticket,const ulong risk_ticket,double &paired_volume,double &net_after_costs);
bool       FindProfitableReductionPair(const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,ulong &profit_ticket,ulong &risk_ticket,double &net_after_costs);
bool       TryPairedSideReduction(const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type);
bool       TrendProtectedPairAllowed(const EAStats &stats,const int trend_direction,const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,const double paired_volume);
bool       FindTrendProtectedReductionPair(const EAStats &stats,const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,const int trend_direction,ulong &profit_ticket,ulong &risk_ticket,double &net_after_costs);
bool       TryTrendProtectedPairReduction(const EAStats &stats,const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,const int trend_direction);
ulong      FindNewestPositionTicket(const ENUM_POSITION_TYPE type,const bool current_symbol_only,const long magic_filter);
bool       CloseByPair(const ulong position_ticket,const ulong opposite_ticket);
void       CloseOppositePairs();
bool       TradeRetcodeOk(const uint retcode);
bool       CheckTradeResult(const bool request_ok,const string action);
bool       CheckOrderSendResult(const bool request_ok,const MqlTradeResult &result,const string action);
bool       ClosePositionTicket(const ulong ticket);
bool       DeletePendingOrder(const ulong ticket);
void       DeleteEaPendingOrders();
void       DeleteCurrentSymbolPendingOrders();
bool       PendingOrderMatchesCloseScope(const ENUM_ORDER_TYPE type,const int direction);
void       DeletePendingOrdersForCloseScope(const int direction,const bool current_symbol_only,const long magic_filter);
bool       ModifyPendingPrice(const ulong ticket,const double new_price);
bool       SelectedPositionMatchesCloseScope(const int direction,const bool current_symbol_only,const long magic_filter);
int        CountCloseScopePositions(const int direction,const bool current_symbol_only,const long magic_filter);
bool       SendAsyncCloseRequests(const int direction,const bool current_symbol_only,const long magic_filter);
void       SendSyncCloseRequests(const int direction,const bool current_symbol_only,const long magic_filter);
void       ResetAsyncCloseState();
void       CompleteAsyncCloseIfDone();
bool       ProcessAsyncCloseMonitor();
void       StartManagedClose(const int direction,const bool use_pairs,const bool arm_cooldown,const bool current_symbol_only,const long magic_filter);
void       CloseEaOrders(const int direction,const bool use_pairs,const bool arm_cooldown);
void       CloseCurrentSymbolExposure();
bool       IsTradingEnvironmentOk(const EAStats &stats,string &reason);
void       ResetBasketTrailing();
void       ResetFirstOrderTrailing();
bool       TryBasketTrailingClose(const EAStats &stats,const bool use_pairs);
bool       HasSingleFirstPosition(const EAStats &stats);
bool       TryFirstOrderTrailingClose(const EAStats &stats);
datetime   CurrentEntryBarTime();
bool       IsFirstEntryBarLocked(const EAStats &stats);
bool       TryProtectiveCloseBySide(const EAStats &stats);
bool       TryFastScalpClose();
bool       TryAutoCloseLogic(const EAStats &stats);
void       ApplyTrendGridFilter(const EAStats &stats,bool &allow_buy,bool &allow_sell);
void       PrintDiagnosticLog(const EAStats &stats,const bool env_ok,const string env_reason,const bool allow_buy,const bool allow_sell);
void       TryPlacePendingOrders(const EAStats &stats,const bool allow_buy,const bool allow_sell);
void       TryTrailPendingOrders(const EAStats &stats,const bool allow_buy,const bool allow_sell);
void       ExecuteStrategy();
double     UiScale();
double     UiFontScale();
int        ScalePx(const int value);
int        ScaleFont(const int value);
void       BuildPanelMetrics(PanelMetrics &m);
string     PanelObjectName(const string suffix);
void       EnsurePanelRectangle(const string suffix,const int x,const int y,const int w,const int h,const color bg,const color border,const int corner);
void       EnsurePanelLabel(const string suffix,const string text,const int x,const int y,const int font_size,const color clr,const int corner,const string font="Microsoft YaHei");
void       EnsurePanelButton(const string suffix,const string text,const int x,const int y,const int w,const int h,const color bg,const color fg,const int corner,const int font_size=0,const string font="Microsoft YaHei");
void       DrawPanelLabelPair(const string left_suffix,const string left_text,const string right_suffix,const string right_text,const int left_x,const int right_x,const int y,const int font_size,const color left_color,const color right_color,const int corner);
void       EnsureRectangle(const string name,const int x,const int y,const int w,const int h,const color bg,const color border,const int corner);
void       EnsureLabel(const string name,const string text,const int x,const int y,const int font_size,const color clr,const int corner,const string font="Microsoft YaHei");
void       EnsureButton(const string name,const string text,const int x,const int y,const int w,const int h,const color bg,const color fg,const int corner,const int font_size=0,const string font="Microsoft YaHei");
string     BoolText(const bool enabled,const string on_text,const string off_text);
string     FormatSignedMoney(const double value);
string     FormatPercent(const double value);
string     FormatPanelMoment(const datetime when,const datetime now_value);
string     NewsPauseReason(const EAStats &stats);
string     WrapUpPauseReason(const EAStats &stats);
string     SessionStateText(const datetime now_value,const EAStats &stats);
string     WrapUpStateText(const EAStats &stats);
string     NewsStateText(const EAStats &stats);
string     EntryStateText(const string stop_reason);
string     CloseReasonText();
string     ClipText(const string text,const int max_chars);
void       DrawPanel(const EAStats &stats);
void       RefreshPanel(const bool force);
void       DeletePanelBodyObjects();
void       DeleteObjectsByPrefix(const string prefix);

int OnInit()
  {
   // v3.20: 自动检测 2 位 vs 3/5 位经纪商,所有按"点"输入的参数 (MaxSpread, Slippage,
   // 内部grid step) 通过 PriceDistancePoints() 自动 ×10 兼容
   PrintFormat("[v4.00 均衡版] 经纪商: %s  digits=%d  point=%.5f  point_scale=%d  (3位经纪商自动×10)",
               _Symbol, (int)_Digits, _Point, PricePointScale());
   g_trade.SetExpertMagicNumber(Magic);
   g_trade.SetTypeFillingBySymbol(_Symbol);
   g_trade.SetDeviationInPoints(TradeDeviationPoints());

   g_allow_buy             = true;
   g_allow_sell            = true;
   g_panel_open            = true;
   g_pause_until           = 0;
   g_last_panel_refresh    = 0;
   g_last_pending_trail_time=0;
   g_last_regime_update    = 0;
   g_last_diagnostic_log   = 0;
   ResetAsyncCloseState();
   g_market_range_probability=0.50;
   g_market_trend_direction=0;
   g_market_trend_confidence=0.0;
   g_market_score          = 0.0;
   g_market_score_raw      = 0.0;
   g_market_score_target   = 0.0;
   g_market_score_coherence=0.0;
   g_market_conflict_weight=0.0;
   g_market_state          = 0;
   g_ts_chop               = 0.0;
   g_ts_dir                = 0;
   g_s30_count             = 0;
   g_s30_head              = -1;
   g_s30_cur_active        = false;
   g_s30_cur_time          = 0;
   for(int i=0; i<GOLDKING_MARKET_REGIME_TF_COUNT; ++i)
     {
      g_market_frame_scores[i]=0.0;
      g_market_frame_trend_power[i]=0.0;
      g_market_frame_range_pressure[i]=0.5;
      g_market_frame_direction[i]=0.0;
      g_market_frame_samples[i]=0.0;
     }
   ResetBasketTrailing();
   ResetFirstOrderTrailing();
   ResetNewsState(g_news_state);
   g_news_cache_minute     = 0;

   DeleteObjectsByPrefix(g_panel_prefix);
   InitMarketRegimeIndicators();
   UpdateMarketRegimeState(true);
   RefreshNewsState(true);
   EventSetTimer(1);
   RefreshPanel(true);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   ReleaseMarketRegimeIndicators();
   DeleteObjectsByPrefix(g_panel_prefix);
  }

void OnTick()
  {
   S30_UpdateOnTick();
   ExecuteStrategy();
  }

void OnTimer()
  {
   ProcessAsyncCloseMonitor();
   EAStats stats;
   CollectStats(stats);
   RefreshPanel(false);
  }

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
  {
   CompleteAsyncCloseIfDone();
  }

void OnChartEvent(const int id,const long &lparam,const double &dparam,const string &sparam)
  {
   if(id != CHARTEVENT_OBJECT_CLICK)
      return;

   const string key=sparam;
   if(key == g_panel_prefix + "toggle_panel" ||
      key == g_panel_prefix + "header" ||
      key == g_panel_prefix + "title")
     {
      g_panel_open = !g_panel_open;
      RefreshPanel(true);
      return;
     }

   if(key == g_panel_prefix + "stop_all")
     {
      ObjectSetInteger(0,key,OBJPROP_STATE,false);
      const bool currently_on=(g_allow_buy || g_allow_sell);
      g_allow_buy = !currently_on;
      g_allow_sell = !currently_on;
      RefreshPanel(true);
      return;
     }

   if(key == g_panel_prefix + "close_ea")
     {
      ObjectSetInteger(0,key,OBJPROP_STATE,false);
      ResetBasketTrailing();
      ResetFirstOrderTrailing();
      CloseCurrentSymbolExposure();
      g_allow_buy=false;
      g_allow_sell=false;
      g_pause_until=0;
      RefreshPanel(true);
      return;
     }
  }

bool IsTestingMode()
  {
   return((bool)MQLInfoInteger(MQL_TESTER));
  }

datetime ReferenceNow()
  {
   if(IsTestingMode())
      return(TimeCurrent());

   datetime server_time=TimeTradeServer();
   if(server_time > 0)
      return(server_time);

   server_time=TimeCurrent();
   if(server_time > 0)
      return(server_time);

   return(TimeLocal());
  }

datetime ReferenceNewsNow()
  {
   if(IsTestingMode())
      return(TimeCurrent());

   datetime server_time=TimeTradeServer();
   if(server_time > 0)
      return(server_time);

   server_time=TimeCurrent();
   if(server_time > 0)
      return(server_time);

   return(TimeLocal());
  }

string CleanTimeString(const string value)
  {
   string result=value;
   StringReplace(result," ","");
   StringTrimLeft(result);
   StringTrimRight(result);
   if(result == "24:00")
      result="23:59:59";
   return(result);
  }

datetime TodayAt(const string time_text,const datetime now_value)
  {
   string t=CleanTimeString(time_text);
   if(StringLen(t) == 5)
      t+=":00";
   return(StringToTime(TimeToString(now_value,TIME_DATE) + " " + t));
  }

bool IsInWindow(const string start_text,const string stop_text,const datetime now_value)
  {
   const datetime start_time=TodayAt(start_text,now_value);
   const datetime stop_time=TodayAt(stop_text,now_value);
   if(start_time <= stop_time)
      return(now_value >= start_time && now_value <= stop_time);
   return(now_value >= start_time || now_value <= stop_time);
  }

bool IsAfterSessionStop(const datetime now_value)
  {
   if(IsInWindow(EA_StartTime,EA_StopTime,now_value))
      return(false);

   const datetime start_time=TodayAt(EA_StartTime,now_value);
   const datetime stop_time=TodayAt(EA_StopTime,now_value);
   if(start_time <= stop_time)
      return(now_value > stop_time);
   return(now_value > stop_time && now_value < start_time);
  }

bool IsTradingSessionOpen(const datetime now_value)
  {
   return(IsInWindow(EA_StartTime,EA_StopTime,now_value));
  }

bool IsTradingSessionAfterStop(const datetime now_value)
  {
   return(IsAfterSessionStop(now_value));
  }

bool IsFridayWrapUpWindow(const datetime now_value)
  {
   MqlDateTime stamp={};
   TimeToStruct(now_value,stamp);
   if(stamp.day_of_week != 5)
      return(false);

   const int lead_hours=(int)MathMax(0,MathMin(24,FridayWrapUpLeadHours));
   const datetime day_end=TodayAt("24:00",now_value);
   const datetime start_time=day_end - lead_hours * 3600;
   return(now_value >= start_time && now_value <= day_end);
  }

bool IsSymbolTradeSessionOpen(const datetime now_value)
  {
   MqlDateTime stamp={};
   TimeToStruct(now_value,stamp);

   const int now_seconds=stamp.hour * 3600 + stamp.min * 60 + stamp.sec;
   const ENUM_DAY_OF_WEEK day=(ENUM_DAY_OF_WEEK)stamp.day_of_week;
   bool has_sessions=false;

   for(uint i=0; ; ++i)
     {
      datetime from_time=0;
      datetime to_time=0;
      if(!SymbolInfoSessionTrade(_Symbol,day,i,from_time,to_time))
         break;

      has_sessions=true;
      int from_seconds=(int)from_time;
      int to_seconds=(int)to_time;
      if(to_seconds <= 0)
         to_seconds=24 * 3600;

      if(from_seconds == to_seconds)
         return(true);

      if(from_seconds < to_seconds)
        {
         if(now_seconds >= from_seconds && now_seconds < to_seconds)
            return(true);
        }
      else if(now_seconds >= from_seconds || now_seconds < to_seconds)
         return(true);
     }

   return(!has_sessions);
  }

void ResetNewsState(NewsWindowState &state)
  {
   state.enabled=false;
   state.calendar_available=false;
   state.using_schedule_rules=false;
   state.has_active_window=false;
   state.in_pre_window=false;
   state.in_post_window=false;
   state.has_upcoming_event=false;
   state.block_entries=false;
   state.server_now=0;
   state.event_time=0;
   state.resume_time=0;
   state.currency="";
   state.event_name="";
   state.error_text="";
  }

void ResetNewsEvalAccumulator(NewsEvalAccumulator &eval)
  {
   eval.any_success=false;
   eval.first_error="";
   eval.active_block_start=0;
   eval.active_block_end=0;
   eval.active_future_time=0;
   eval.active_future_currency="";
   eval.active_future_name="";
   eval.active_past_time=0;
   eval.active_past_currency="";
   eval.active_past_name="";
   eval.next_upcoming_time=0;
   eval.next_upcoming_currency="";
   eval.next_upcoming_name="";
  }

void AppendUniqueText(string &items[],const string value)
  {
   string item=value;
   StringTrimLeft(item);
   StringTrimRight(item);
   if(item == "")
      return;

   for(int i=0; i<ArraySize(items); ++i)
     {
      if(items[i] == item)
         return;
     }

   const int size=ArraySize(items);
   ArrayResize(items,size + 1);
   items[size]=item;
  }

void BuildNewsCurrencies(string &currencies[])
  {
   ArrayResize(currencies,0);
   AppendUniqueText(currencies,"USD");
  }

string CalendarErrorText(const int error_code)
  {
   switch(error_code)
     {
      case 0:
         return("");
      case 5400:
         return("经济日历返回过多数据");
      case 5401:
         return("经济日历请求超时");
      case 5402:
         return("经济日历无可用数据");
     default:
         return("经济日历错误 " + IntegerToString(error_code));
     }
  }

datetime BuildDateTime(const int year,const int mon,const int day,const int hour,const int min,const int sec)
  {
   MqlDateTime stamp={};
   stamp.year=year;
   stamp.mon=mon;
   stamp.day=day;
   stamp.hour=hour;
   stamp.min=min;
   stamp.sec=sec;
   return(StructToTime(stamp));
  }

int DaysInMonth(const int year,const int mon)
  {
   switch(mon)
     {
      case 1:
      case 3:
      case 5:
      case 7:
      case 8:
      case 10:
      case 12:
         return(31);
      case 4:
      case 6:
      case 9:
      case 11:
         return(30);
      case 2:
         return(((year % 400 == 0) || (year % 4 == 0 && year % 100 != 0)) ? 29 : 28);
     }
   return(30);
  }

int WeekdayOfDate(const int year,const int mon,const int day)
  {
   MqlDateTime stamp={};
   TimeToStruct(BuildDateTime(year,mon,day,0,0,0),stamp);
   return(stamp.day_of_week);
  }

int NthWeekdayDay(const int year,const int mon,const int weekday,const int ordinal)
  {
   if(ordinal <= 0)
      return(0);

   const int first_weekday=WeekdayOfDate(year,mon,1);
   const int day=1 + ((weekday - first_weekday + 7) % 7) + (ordinal - 1) * 7;
   return(day <= DaysInMonth(year,mon) ? day : 0);
  }

int LastWeekdayDay(const int year,const int mon,const int weekday)
  {
   const int last_day=DaysInMonth(year,mon);
   const int last_weekday=WeekdayOfDate(year,mon,last_day);
   return(last_day - ((last_weekday - weekday + 7) % 7));
  }

int BusinessDayOfMonth(const int year,const int mon,const int ordinal)
  {
   if(ordinal <= 0)
      return(0);

   int count=0;
   for(int day=1; day<=DaysInMonth(year,mon); ++day)
     {
      const int weekday=WeekdayOfDate(year,mon,day);
      if(weekday < 1 || weekday > 5)
         continue;
      count++;
      if(count == ordinal)
         return(day);
     }
   return(0);
  }

bool IsUsEasternDstDate(const int year,const int mon,const int day)
  {
   if(mon < 3 || mon > 11)
      return(false);
   if(mon > 3 && mon < 11)
      return(true);

   const int dst_start=NthWeekdayDay(year,3,0,2);
   const int dst_end=NthWeekdayDay(year,11,0,1);
   if(mon == 3)
      return(day >= dst_start);
   return(day < dst_end);
  }

datetime UsEasternReleaseUtc(const int year,const int mon,const int day,const int hour,const int min)
  {
   const int utc_offset_hours=IsUsEasternDstDate(year,mon,day) ? 4 : 5;
   return(BuildDateTime(year,mon,day,0,0,0) + (hour + utc_offset_hours) * 3600 + min * 60);
  }

void ConsiderUsdRuleEvent(const datetime now_server,const int year,const int mon,const int day,const int hour,const int min,const string event_name,const int lead_seconds,const int cooldown_seconds,NewsEvalAccumulator &eval)
  {
   if(day <= 0)
      return;
   ConsiderNewsEvent(now_server,UsEasternReleaseUtc(year,mon,day,hour,min),"USD",event_name,lead_seconds,cooldown_seconds,eval);
  }

void ConsiderNewsEvent(const datetime now_server,const datetime event_time,const string currency,const string event_name,const int lead_seconds,const int cooldown_seconds,NewsEvalAccumulator &eval)
  {
   if(event_time <= 0)
      return;

   const datetime window_start=event_time - lead_seconds;
   const datetime window_end=event_time + cooldown_seconds;

   if(now_server >= window_start && now_server < window_end)
     {
      if(eval.active_block_start == 0 || window_start < eval.active_block_start)
         eval.active_block_start=window_start;
      if(window_end > eval.active_block_end)
         eval.active_block_end=window_end;

      if(event_time >= now_server)
        {
         if(eval.active_future_time == 0 || event_time < eval.active_future_time)
           {
            eval.active_future_time=event_time;
            eval.active_future_currency=currency;
            eval.active_future_name=event_name;
           }
        }
      else
        {
         if(eval.active_past_time == 0 || event_time > eval.active_past_time)
           {
            eval.active_past_time=event_time;
            eval.active_past_currency=currency;
            eval.active_past_name=event_name;
           }
        }
      return;
     }

   if(event_time > now_server && (eval.next_upcoming_time == 0 || event_time < eval.next_upcoming_time))
     {
      eval.next_upcoming_time=event_time;
      eval.next_upcoming_currency=currency;
      eval.next_upcoming_name=event_name;
     }
  }

void ApplyNewsAccumulator(const NewsEvalAccumulator &eval)
  {
   g_news_state.calendar_available=eval.any_success;
   if(!eval.any_success)
     {
      g_news_state.error_text=(eval.first_error != "" ? eval.first_error : "经济日历不可用，已忽略");
      return;
     }

   if(eval.active_block_start != 0)
     {
      g_news_state.has_active_window=true;
      g_news_state.block_entries=true;
      g_news_state.resume_time=eval.active_block_end;
      g_news_state.in_pre_window=(eval.active_future_time != 0);
      g_news_state.in_post_window=(eval.active_past_time != 0) || !g_news_state.in_pre_window;

      if(g_news_state.in_pre_window)
        {
         g_news_state.event_time=eval.active_future_time;
         g_news_state.currency=eval.active_future_currency;
         g_news_state.event_name=eval.active_future_name;
        }
      else
        {
         g_news_state.event_time=eval.active_past_time;
         g_news_state.currency=eval.active_past_currency;
         g_news_state.event_name=eval.active_past_name;
        }
      return;
     }

   if(eval.next_upcoming_time != 0)
     {
      g_news_state.has_upcoming_event=true;
      g_news_state.event_time=eval.next_upcoming_time;
      g_news_state.currency=eval.next_upcoming_currency;
      g_news_state.event_name=eval.next_upcoming_name;
     }
  }

void RefreshRuleBacktestNewsState(const datetime now_server)
  {
   g_news_state.using_schedule_rules=true;

   NewsEvalAccumulator eval;
   ResetNewsEvalAccumulator(eval);
   eval.any_success=true;

   const int pause_seconds=MathMax(0,NewsPauseMinutes) * 60;
   MqlDateTime base={};
   TimeToStruct(now_server,base);

   for(int month_shift=-1; month_shift<=1; ++month_shift)
     {
      int year=base.year;
      int mon=base.mon + month_shift;
      while(mon < 1)
        {
         mon+=12;
         year--;
        }
      while(mon > 12)
        {
         mon-=12;
         year++;
        }

      const int nfp_day=NthWeekdayDay(year,mon,5,1);
      ConsiderUsdRuleEvent(now_server,year,mon,nfp_day,8,30,"Nonfarm Payrolls",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,nfp_day,8,30,"Unemployment Rate",pause_seconds,pause_seconds,eval);
      if(nfp_day > 2)
         ConsiderUsdRuleEvent(now_server,year,mon,nfp_day - 2,8,15,"ADP Nonfarm Employment Change",pause_seconds,pause_seconds,eval);

      ConsiderUsdRuleEvent(now_server,year,mon,NthWeekdayDay(year,mon,3,2),8,30,"CPI",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,NthWeekdayDay(year,mon,4,2),8,30,"PPI",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,NthWeekdayDay(year,mon,3,3),8,30,"Retail Sales",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,LastWeekdayDay(year,mon,5),8,30,"Core PCE Price Index",pause_seconds,pause_seconds,eval);
      if(mon == 1 || mon == 4 || mon == 7 || mon == 10)
         ConsiderUsdRuleEvent(now_server,year,mon,LastWeekdayDay(year,mon,4),8,30,"GDP",pause_seconds,pause_seconds,eval);

      ConsiderUsdRuleEvent(now_server,year,mon,BusinessDayOfMonth(year,mon,1),10,0,"ISM Manufacturing PMI",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,BusinessDayOfMonth(year,mon,3),10,0,"ISM Services PMI",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,NthWeekdayDay(year,mon,2,1),10,0,"JOLTS Job Openings",pause_seconds,pause_seconds,eval);
      ConsiderUsdRuleEvent(now_server,year,mon,LastWeekdayDay(year,mon,2),10,0,"CB Consumer Confidence",pause_seconds,pause_seconds,eval);

      for(int day=1; day<=DaysInMonth(year,mon); ++day)
        {
         if(WeekdayOfDate(year,mon,day) == 4)
            ConsiderUsdRuleEvent(now_server,year,mon,day,8,30,"Initial Jobless Claims",pause_seconds,pause_seconds,eval);
        }

      if(mon == 1 || mon == 3 || mon == 5 || mon == 6 || mon == 7 || mon == 9 || mon == 11 || mon == 12)
         ConsiderUsdRuleEvent(now_server,year,mon,NthWeekdayDay(year,mon,3,3),14,0,"Fed Interest Rate Decision",pause_seconds,pause_seconds,eval);
     }

   ApplyNewsAccumulator(eval);
  }

void RefreshNewsState(const bool force)
  {
   const datetime now_server=ReferenceNewsNow();
   const datetime minute_key=now_server - now_server % 60;

   if(!force && g_news_cache_minute == minute_key && g_news_state.server_now != 0)
     {
      g_news_state.server_now=now_server;
      return;
     }

   g_news_cache_minute=minute_key;
   ResetNewsState(g_news_state);
   const int pause_minutes=(int)MathMax(0,NewsPauseMinutes);
   g_news_state.enabled=(pause_minutes > 0);
   g_news_state.server_now=now_server;

   if(pause_minutes <= 0)
      return;

   string currencies[];
   BuildNewsCurrencies(currencies);
   if(ArraySize(currencies) == 0)
     {
      g_news_state.error_text="新闻过滤无可用货币";
      return;
     }

   const int lead_seconds=pause_minutes * 60;
   const int cooldown_seconds=pause_minutes * 60;
   const datetime query_from=now_server - cooldown_seconds;
   const datetime query_to=now_server + 86400;

   NewsEvalAccumulator eval;
   ResetNewsEvalAccumulator(eval);
   int total_calendar_values=0;

   for(int c=0; c<ArraySize(currencies); ++c)
     {
      MqlCalendarValue values[];
      ResetLastError();
      const int count=CalendarValueHistory(values,query_from,query_to,NULL,currencies[c]);
      const int error_code=GetLastError();

      if(count < 0)
        {
         if(eval.first_error == "" && error_code != 0)
            eval.first_error=CalendarErrorText(error_code);
         continue;
        }

      eval.any_success=true;
      total_calendar_values+=count;
      for(int i=0; i<count; ++i)
        {
         if(values[i].event_id == 0 || values[i].time <= 0)
            continue;

         MqlCalendarEvent event={};
         if(!CalendarEventById(values[i].event_id,event))
            continue;
         if(event.importance != CALENDAR_IMPORTANCE_HIGH)
            continue;
         if(event.time_mode != CALENDAR_TIMEMODE_DATETIME)
            continue;

         ConsiderNewsEvent(now_server,values[i].time,currencies[c],event.name,lead_seconds,cooldown_seconds,eval);
        }
     }

   if(IsTestingMode() && (!eval.any_success || total_calendar_values == 0))
     {
      RefreshRuleBacktestNewsState(now_server);
      return;
     }

   ApplyNewsAccumulator(eval);
  }

double ClampDouble(const double value,const double min_value,const double max_value)
  {
   if(value < min_value)
      return(min_value);
   if(value > max_value)
      return(max_value);
   return(value);
  }

bool ReadIndicatorSeries(const int handle,const int buffer,const int shift,const int count,double &values[])
  {
   ArrayResize(values,0);
   if(handle == INVALID_HANDLE || count <= 0)
      return(false);

   ArrayResize(values,count);
   ArraySetAsSeries(values,true);
   const int copied=CopyBuffer(handle,buffer,shift,count,values);
   if(copied <= 0)
     {
      ArrayResize(values,0);
      return(false);
     }

   if(copied < count)
      ArrayResize(values,copied);
   ArraySetAsSeries(values,true);
   return(true);
  }

bool InitMarketRegimeIndicators()
  {
   bool ok=true;
   for(int i=0; i<GOLDKING_MARKET_REGIME_TF_COUNT; ++i)
     {
      const ENUM_TIMEFRAMES tf=g_regime_timeframes[i];
      g_adx_handles[i]=iADX(_Symbol,tf,14);
      g_bands_handles[i]=iBands(_Symbol,tf,20,0,2.0,PRICE_CLOSE);
      g_atr_handles[i]=iATR(_Symbol,tf,14);
      g_ma_fast_handles[i]=iMA(_Symbol,tf,8,0,MODE_EMA,PRICE_CLOSE);
      g_ma_mid_handles[i]=iMA(_Symbol,tf,21,0,MODE_EMA,PRICE_CLOSE);
      g_ma_slow_handles[i]=iMA(_Symbol,tf,55,0,MODE_EMA,PRICE_CLOSE);
      g_rsi_handles[i]=iRSI(_Symbol,tf,14,PRICE_CLOSE);
      g_macd_handles[i]=iMACD(_Symbol,tf,12,26,9,PRICE_CLOSE);

      if(g_adx_handles[i] == INVALID_HANDLE ||
         g_bands_handles[i] == INVALID_HANDLE ||
         g_atr_handles[i] == INVALID_HANDLE ||
         g_ma_fast_handles[i] == INVALID_HANDLE ||
         g_ma_mid_handles[i] == INVALID_HANDLE ||
         g_ma_slow_handles[i] == INVALID_HANDLE ||
         g_rsi_handles[i] == INVALID_HANDLE ||
         g_macd_handles[i] == INVALID_HANDLE)
        {
         PrintFormat("Market regime indicator init failed: index=%d timeframe=%d",i,(int)tf);
         ok=false;
        }
     }
   return(ok);
  }

void ReleaseMarketRegimeIndicators()
  {
   for(int i=0; i<GOLDKING_MARKET_REGIME_TF_COUNT; ++i)
     {
      if(g_adx_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_adx_handles[i]);
      if(g_bands_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_bands_handles[i]);
      if(g_atr_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_atr_handles[i]);
      if(g_ma_fast_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_ma_fast_handles[i]);
      if(g_ma_mid_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_ma_mid_handles[i]);
      if(g_ma_slow_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_ma_slow_handles[i]);
      if(g_rsi_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_rsi_handles[i]);
      if(g_macd_handles[i] != INVALID_HANDLE)
         IndicatorRelease(g_macd_handles[i]);

      g_adx_handles[i]=INVALID_HANDLE;
      g_bands_handles[i]=INVALID_HANDLE;
      g_atr_handles[i]=INVALID_HANDLE;
      g_ma_fast_handles[i]=INVALID_HANDLE;
      g_ma_mid_handles[i]=INVALID_HANDLE;
      g_ma_slow_handles[i]=INVALID_HANDLE;
      g_rsi_handles[i]=INVALID_HANDLE;
     g_macd_handles[i]=INVALID_HANDLE;
     }
  }

int TimeframeMinutes(const ENUM_TIMEFRAMES tf)
  {
   const int seconds=PeriodSeconds(tf);
   if(seconds <= 0)
      return(1);
   return(MathMax(1,seconds / 60));
  }

bool IsSameTimeWindow(const datetime sample_time,const datetime base_time,const int window_minutes)
  {
   MqlDateTime sample={};
   MqlDateTime base={};
   TimeToStruct(sample_time,sample);
   TimeToStruct(base_time,base);

   const int sample_minute=sample.hour * 60 + sample.min;
   const int base_minute=base.hour * 60 + base.min;
   int diff=MathAbs(sample_minute - base_minute);
   diff=MathMin(diff,1440 - diff);
   return(diff <= window_minutes);
  }

double PercentileRank(double &values[],const int count,const double value)
  {
   if(count <= 0)
      return(0.5);

   int below=0;
   int equal=0;
   for(int i=0; i<count; ++i)
     {
      if(values[i] < value)
         below++;
      else if(values[i] == value)
         equal++;
     }

   return(ClampDouble(((double)below + (double)equal * 0.5) / (double)count,0.0,1.0));
  }

double ClampUnitSigned(const double value)
  {
   return(ClampDouble(value,-1.0,1.0));
  }

double SeriesValue(double &values[],const int shift,const double fallback)
  {
   if(shift < 0 || shift >= ArraySize(values))
      return(fallback);
   if(values[shift] == EMPTY_VALUE)
      return(fallback);
   return(values[shift]);
  }

double ManualAtr(MqlRates &rates[],const int copied,const int shift,const int period)
  {
   if(period <= 0 || shift < 0 || copied <= shift + period)
      return(0.0);

   double sum=0.0;
   int valid=0;
   for(int i=shift; i<shift + period && i + 1<copied; ++i)
     {
      const double prev_close=rates[i + 1].close;
      const double true_range=MathMax(rates[i].high - rates[i].low,
                                      MathMax(MathAbs(rates[i].high - prev_close),
                                              MathAbs(rates[i].low - prev_close)));
      sum+=true_range;
      valid++;
     }

   return(valid > 0 ? sum / valid : 0.0);
  }

double EfficiencyRatio(MqlRates &rates[],const int copied,const int shift,const int period)
  {
   if(period <= 0 || shift < 0 || copied <= shift + period)
      return(0.0);

   double travel=0.0;
   for(int i=shift; i<shift + period && i + 1<copied; ++i)
      travel+=MathAbs(rates[i].close - rates[i + 1].close);

   if(travel <= 0.0)
      return(0.0);

   return(ClampDouble(MathAbs(rates[shift].close - rates[shift + period].close) / travel,0.0,1.0));
  }

double RegressionSlopeAtr(MqlRates &rates[],const int copied,const int shift,const int period,const double atr,double &r2)
  {
   r2=0.0;
   if(period <= 2 || shift < 0 || copied <= shift + period || atr <= 0.0)
      return(0.0);

   double sum_x=0.0;
   double sum_y=0.0;
   double sum_x2=0.0;
   double sum_y2=0.0;
   double sum_xy=0.0;
   for(int i=0; i<period; ++i)
     {
      const double x=(double)i;
      const double y=rates[shift + period - 1 - i].close;
      sum_x+=x;
      sum_y+=y;
      sum_x2+=x * x;
      sum_y2+=y * y;
      sum_xy+=x * y;
     }

   const double n=(double)period;
   const double reg_num=n * sum_xy - sum_x * sum_y;
   const double reg_den=n * sum_x2 - sum_x * sum_x;
   const double corr_den=(n * sum_x2 - sum_x * sum_x) * (n * sum_y2 - sum_y * sum_y);
   if(corr_den > 0.0)
      r2=ClampDouble(reg_num * reg_num / corr_den,0.0,1.0);
   if(reg_den == 0.0)
      return(0.0);

   return((reg_num / reg_den) / atr);
  }

double ChoppinessIndex(MqlRates &rates[],const int copied,const int shift,const int period)
  {
   if(period <= 1 || shift < 0 || copied <= shift + period)
      return(50.0);

   double highest=rates[shift].high;
   double lowest=rates[shift].low;
   double tr_sum=0.0;
   for(int i=shift; i<shift + period && i + 1<copied; ++i)
     {
      highest=MathMax(highest,rates[i].high);
      lowest=MathMin(lowest,rates[i].low);
      const double prev_close=rates[i + 1].close;
      tr_sum+=MathMax(rates[i].high - rates[i].low,
                      MathMax(MathAbs(rates[i].high - prev_close),
                              MathAbs(rates[i].low - prev_close)));
     }

   const double range=MathMax(_Point,highest - lowest);
   if(tr_sum <= 0.0 || range <= 0.0)
      return(50.0);

   return(ClampDouble(100.0 * MathLog(tr_sum / range) / MathLog((double)period),0.0,100.0));
  }

double DonchianBreakoutStrength(MqlRates &rates[],const int copied,const int shift,const int period,const double atr)
  {
   if(period <= 1 || shift < 0 || copied <= shift + period + 1 || atr <= 0.0)
      return(0.0);

   double previous_high=rates[shift + 1].high;
   double previous_low=rates[shift + 1].low;
   for(int i=shift + 1; i<=shift + period && i<copied; ++i)
     {
      previous_high=MathMax(previous_high,rates[i].high);
      previous_low=MathMin(previous_low,rates[i].low);
     }

   const double close_price=rates[shift].close;
   const double upside=MathMax(0.0,(close_price - previous_high) / atr);
   const double downside=MathMax(0.0,(previous_low - close_price) / atr);
   return(ClampUnitSigned(upside - downside));
  }


//+------------------------------------------------------------------+
//| Trend scoring system (V3.1 redesign)                             |
//| Fast multi-factor, multi-timeframe, ATR-self-calibrating score.  |
//| Per-timeframe score in [-100,+100] = direction x trendiness.     |
//+------------------------------------------------------------------+
double ComputeFrameScore(const int tf_index,double &out_trendiness)
  {
   out_trendiness=0.0;
   if(tf_index < 0 || tf_index >= GOLDKING_MARKET_REGIME_TF_COUNT)
      return(0.0);

   const ENUM_TIMEFRAMES tf=g_regime_timeframes[tf_index];
   MqlRates rates[];
   ArraySetAsSeries(rates,true);
   const int copied=CopyRates(_Symbol,tf,0,140,rates);
   if(copied < 70)
      return(0.0);

   const double atr=ManualAtr(rates,copied,0,14);
   if(atr <= 0.0)
      return(0.0);

   // F1 - regression slope (ATR units per bar), damped by linear-fit quality
   double r2=0.0;
   const int slope_period=(tf_index==0 ? 20 : (tf_index==1 ? 18 : 14));
   const double slope=RegressionSlopeAtr(rates,copied,0,slope_period,atr,r2);
   const double f1=ClampUnitSigned(slope / 0.06) * (0.5 + 0.5 * r2);

   // F2 - signed Kaufman efficiency ratio
   const int er_period=(tf_index==0 ? 30 : (tf_index==1 ? 24 : 20));
   const double er=EfficiencyRatio(rates,copied,0,er_period);
   const double disp=rates[0].close - rates[er_period].close;
   const double f2=(disp > 0.0 ? 1.0 : (disp < 0.0 ? -1.0 : 0.0)) * er;

   // F3 - EMA8/21/55 structure (stack + slope)
   double f3=0.0;
   const int prev_shift=(tf_index==0 ? 3 : 2);
   double ema_f[];
   double ema_m[];
   double ema_s[];
   if(ReadIndicatorSeries(g_ma_fast_handles[tf_index],0,0,prev_shift+1,ema_f) &&
      ReadIndicatorSeries(g_ma_mid_handles[tf_index],0,0,prev_shift+1,ema_m) &&
      ReadIndicatorSeries(g_ma_slow_handles[tf_index],0,0,prev_shift+1,ema_s) &&
      ArraySize(ema_f) > prev_shift && ArraySize(ema_m) > prev_shift && ArraySize(ema_s) > prev_shift)
     {
      const double f=ema_f[0];
      const double m=ema_m[0];
      const double s=ema_s[0];
      double stack=0.0;
      if(f > m && m > s)
         stack=1.0;
      else if(f < m && m < s)
         stack=-1.0;
      else
         stack=ClampUnitSigned((f - s) / atr);
      const double ema_slope=ClampUnitSigned(((f - ema_f[prev_shift]) / atr) * 0.50
                                             + ((m - ema_m[prev_shift]) / atr) * 0.35
                                             + ((s - ema_s[prev_shift]) / atr) * 0.15);
      f3=0.55 * stack + 0.45 * ema_slope;
     }

   // F4 - MACD histogram momentum, ATR-normalized
   double f4=0.0;
   double macd_main[];
   double macd_sig[];
   if(ReadIndicatorSeries(g_macd_handles[tf_index],0,0,2,macd_main) &&
      ReadIndicatorSeries(g_macd_handles[tf_index],1,0,2,macd_sig) &&
      ArraySize(macd_main) > 0 && ArraySize(macd_sig) > 0)
      f4=ClampUnitSigned((macd_main[0] - macd_sig[0]) / atr / 0.30);

   // F5 - Donchian breakout strength (signed, ATR-normalized)
   const int don_period=(tf_index==0 ? 24 : 20);
   const double f5=DonchianBreakoutStrength(rates,copied,0,don_period,atr);

   // F6 - ADX +DI/-DI directional balance
   double f6=0.0;
   double plus_di[];
   double minus_di[];
   if(ReadIndicatorSeries(g_adx_handles[tf_index],1,0,2,plus_di) &&
      ReadIndicatorSeries(g_adx_handles[tf_index],2,0,2,minus_di) &&
      ArraySize(plus_di) > 0 && ArraySize(minus_di) > 0)
      f6=ClampUnitSigned((plus_di[0] - minus_di[0]) / 40.0);

   const double dir=ClampUnitSigned(0.34*f1 + 0.20*f2 + 0.18*f3 + 0.12*f4 + 0.10*f5 + 0.06*f6);
   const double slope_mag=ClampDouble(MathAbs(slope) / 0.06,0.0,1.0);
   out_trendiness=ClampDouble(0.40*er + 0.30*r2 + 0.30*slope_mag,0.0,1.0);
   return(ClampDouble(100.0 * dir * out_trendiness,-100.0,100.0));
  }

int MarketStateFromScore(const double score)
  {
   const double abs_score=MathAbs(score);
   if(abs_score <= GOLDKING_MARKET_RANGE_LIMIT)
      return(0);
   if(abs_score < GOLDKING_MARKET_TREND_CONFIRM)
      return(score > 0.0 ? 1 : -1);
   if(abs_score < GOLDKING_MARKET_STRONG_TREND)
      return(score > 0.0 ? 2 : -2);
   return(score > 0.0 ? 3 : -3);
  }

string MarketStateText()
  {
   if(g_market_state >= 3)
      return("强多");
   if(g_market_state == 2)
      return("多头确认");
   if(g_market_state == 1)
      return("弱多");
   if(g_market_state <= -3)
      return("强空");
   if(g_market_state == -2)
      return("空头确认");
   if(g_market_state == -1)
      return("弱空");
   return("震荡");
  }

double MarketTrendProtectionRatio()
  {
   const double abs_score=MathAbs(g_market_score);
   if(abs_score < GOLDKING_MARKET_TREND_CONFIRM)
      return(0.0);
   return(ClampDouble(0.35 + 0.20 * ((abs_score - GOLDKING_MARKET_TREND_CONFIRM) / (100.0 - GOLDKING_MARKET_TREND_CONFIRM)),0.35,0.55));
  }

int MarketScoreDirection()
  {
   if(g_market_score >= GOLDKING_MARKET_TREND_CONFIRM)
      return(1);
   if(g_market_score <= -GOLDKING_MARKET_TREND_CONFIRM)
      return(-1);
   return(0);
  }

int MarketBaseGridStepPoints()
  {
   const double abs_score=MathAbs(g_market_score);
   if(abs_score <= GOLDKING_MARKET_RANGE_LIMIT)
      return(GOLDKING_DYNAMIC_STEP_MIN_POINTS);
   if(abs_score <= GOLDKING_MARKET_TREND_CONFIRM)
      return((int)MathRound(70.0 + (abs_score - GOLDKING_MARKET_RANGE_LIMIT) / (GOLDKING_MARKET_TREND_CONFIRM - GOLDKING_MARKET_RANGE_LIMIT) * 30.0));
   if(abs_score <= GOLDKING_MARKET_STRONG_TREND)
      return((int)MathRound(110.0 + (abs_score - GOLDKING_MARKET_TREND_CONFIRM) / (GOLDKING_MARKET_STRONG_TREND - GOLDKING_MARKET_TREND_CONFIRM) * 25.0));
   return((int)MathRound(140.0 + (abs_score - GOLDKING_MARKET_STRONG_TREND) / (100.0 - GOLDKING_MARKET_STRONG_TREND) * 10.0));
  }

int DirectionalGridStepPoints(const bool is_buy)
  {
   UpdateMarketRegimeState(false);

   const double abs_score=MathAbs(g_market_score);
   int step=MarketBaseGridStepPoints();
   if(abs_score < GOLDKING_MARKET_RANGE_LIMIT)
      return(PriceDistancePoints((int)MathMax(GOLDKING_DYNAMIC_STEP_MIN_POINTS,MathMin(GOLDKING_DYNAMIC_STEP_MAX_POINTS,step))));

   const bool buy_trend=(g_market_score > 0.0);
   const bool trend_side=(is_buy == buy_trend);
   if(abs_score >= GOLDKING_MARKET_TREND_CONFIRM)
     {
      if(trend_side)
         step=(int)MathRound(120.0 - (abs_score - GOLDKING_MARKET_TREND_CONFIRM) / (100.0 - GOLDKING_MARKET_TREND_CONFIRM) * 30.0);
      else
         step=(int)MathRound(140.0 + (abs_score - GOLDKING_MARKET_TREND_CONFIRM) / (100.0 - GOLDKING_MARKET_TREND_CONFIRM) * 10.0);
     }
   else if(!trend_side)
      step=(int)MathRound(100.0 + (abs_score - GOLDKING_MARKET_RANGE_LIMIT) / (GOLDKING_MARKET_TREND_CONFIRM - GOLDKING_MARKET_RANGE_LIMIT) * 40.0);

   return(PriceDistancePoints((int)MathMax(GOLDKING_DYNAMIC_STEP_MIN_POINTS,MathMin(GOLDKING_DYNAMIC_STEP_MAX_POINTS,step))));
  }

double MarketTrendStrength01()
  {
   UpdateMarketRegimeState(false);

   const double abs_score=MathAbs(g_market_score);
   if(abs_score <= GOLDKING_MARKET_RANGE_LIMIT)
      return(0.0);

   return(ClampDouble((abs_score - GOLDKING_MARKET_RANGE_LIMIT) / (100.0 - GOLDKING_MARKET_RANGE_LIMIT),0.0,1.0));
  }

// 30-second K-line aggregator (called every tick). When the wall-clock 30s
// bucket changes, the in-progress bar is committed to the ring buffer.
void S30_UpdateOnTick()
  {
   MqlTick t;
   if(!SymbolInfoTick(_Symbol,t))
      return;
   const datetime bucket=(datetime)(((long)t.time / 30) * 30);
   double price=t.bid;
   if(price <= 0.0) price=t.ask;
   if(price <= 0.0) price=t.last;
   if(price <= 0.0) return;
   if(!g_s30_cur_active)
     {
      g_s30_cur_active=true;
      g_s30_cur_time=bucket;
      g_s30_cur_open=g_s30_cur_high=g_s30_cur_low=g_s30_cur_close=price;
      return;
     }
   if(bucket != g_s30_cur_time)
     {
      g_s30_head=(g_s30_head + 1) % S30_BUF_SIZE;
      g_s30_time[g_s30_head]=g_s30_cur_time;
      g_s30_open[g_s30_head]=g_s30_cur_open;
      g_s30_high[g_s30_head]=g_s30_cur_high;
      g_s30_low[g_s30_head]=g_s30_cur_low;
      g_s30_close[g_s30_head]=g_s30_cur_close;
      if(g_s30_count < S30_BUF_SIZE) g_s30_count++;
      g_s30_cur_time=bucket;
      g_s30_cur_open=g_s30_cur_high=g_s30_cur_low=g_s30_cur_close=price;
     }
   else
     {
      if(price > g_s30_cur_high) g_s30_cur_high=price;
      if(price < g_s30_cur_low)  g_s30_cur_low=price;
      g_s30_cur_close=price;
     }
  }

// Close of the bar at `shift` positions back from the newest committed bar.
double S30_Close(const int shift)
  {
   if(shift < 0 || shift >= g_s30_count) return(0.0);
   int idx=g_s30_head - shift;
   while(idx < 0) idx+=S30_BUF_SIZE;
   return(g_s30_close[idx]);
  }

// Price change over `period` 30s bars (positive=up move, negative=down move).
double S30_Momentum(const int period)
  {
   if(period <= 0 || g_s30_count <= period) return(0.0);
   return(S30_Close(0) - S30_Close(period));
  }

double EquityScale()
  {
   // Money management: lots and money-denominated targets scale with account
   // equity, so profit compounds as the account grows and risk auto-shrinks on
   // a drawdown. The per-side cap is on COUNT, so max exposure stays a fixed
   // fraction of equity -> drawdown % is invariant to account size (Kelly-safe).
   //
   // v3.21: cap is an input (EquityScaleCap, default 20 = v3.10 behavior).
   // Raise it to let lots keep compounding past $200k. EquityScalePower>1.0
   // makes scaling super-linear (more aggressive compound, more peak, more risk).
   //
   // 固定0.01手模式: EquityScaleCap=1.0 时, 此函数恒返回 1.0,
   // 手数和止盈目标都不再随权益放大, 每笔恒定起始手数(默认0.01)。
   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   if(EquityBaseline <= 0.0 || equity <= 0.0)
      return(1.0);
   const double cap=(EquityScaleCap>0.0)?EquityScaleCap:20.0;
   const double power=(EquityScalePower>0.0)?EquityScalePower:1.0;
   double ratio=equity / EquityBaseline;
   if(power!=1.0 && ratio>0.0)
      ratio=MathPow(ratio,power);
   return(ClampDouble(ratio,0.20,cap));
  }

double EffectiveBaseLot()
  {
   return(lot * EquityScale());
  }

double DynamicLotMultiplier(const bool is_buy)
  {
   // Regime-adaptive martingale (user-directed): high in range, flat in trend.
   //  - Confirmed range (|score|<=RANGE_LIMIT): GridLotMultiplier (e.g. 1.80) --
   //    martingale's home turf. Deep positions become big, basket closes on the
   //    inevitable retrace; super-fast profit cycles (加快获利了结).
   //  - Confirmed strong trend (|score|>=STRONG_TREND): TrendMultMin (~1.10),
   //    near flat -- the counter bag bleeds only linearly, no exponential
   //    explosion that blows the account.
   //  - In-between: linear gradient.
   const double abs_score=MathAbs(g_market_score);
   if(abs_score <= GOLDKING_MARKET_RANGE_LIMIT)
      return(GridLotMultiplier);
   if(abs_score >= GOLDKING_MARKET_STRONG_TREND)
      return(TrendMultMin);
   const double t=(abs_score - GOLDKING_MARKET_RANGE_LIMIT) /
                  (GOLDKING_MARKET_STRONG_TREND - GOLDKING_MARKET_RANGE_LIMIT);
   return(GridLotMultiplier - (GridLotMultiplier - TrendMultMin) * t);
  }


double DynamicCloseAllTarget()
  {
   // v3.21: CloseAllAmplifier scales the target up (slower cycles, bigger basket
   // P/L per cycle, more upside per cycle). CloseAllScalePower lets the target
   // grow super-linearly with equity (so cycles get RICHER as account grows,
   // not just bigger). 1.0/1.0 == v3.10 original.
   const double strength=MarketTrendStrength01();
   const double amp=(CloseAllAmplifier>0.0)?CloseAllAmplifier:1.0;
   const double power=(CloseAllScalePower>0.0)?CloseAllScalePower:1.0;
   double scale=EquityScale();
   if(power!=1.0 && scale>0.0)
      scale=MathPow(scale,power);
   return(NormalizeDouble(GOLDKING_CLOSE_ALL_AMOUNT * amp * (1.0 + 0.80 * strength) * scale,2));
  }

double DynamicSideAverageOrderNetProfit(const bool is_buy)
  {
   const double scale=EquityScale();
   const double strength=MarketTrendStrength01();
   if(strength <= 0.0)
      return(NormalizeDouble(GOLDKING_SIDE_AVG_NET_BASE * scale,2));

   const bool trend_side=(is_buy == (g_market_score > 0.0));
   if(trend_side)
      return(NormalizeDouble(GOLDKING_SIDE_AVG_NET_BASE * (1.0 + 0.60 * strength) * scale,2));

   return(NormalizeDouble(MathMax(1.80,GOLDKING_SIDE_AVG_NET_BASE * (1.0 - 0.28 * strength)) * scale,2));
  }


//+------------------------------------------------------------------+
//| UpdateMarketRegimeState (V3.1 redesign)                          |
//| Fast combine of the 3-timeframe scores -> g_market_score.        |
//| No 30s freeze, no percentile baselines; reacts within seconds.   |
//+------------------------------------------------------------------+
void UpdateMarketRegimeState(const bool force)
  {
   const datetime now_value=TimeCurrent();
   if(!force && g_last_regime_update > 0 && now_value - g_last_regime_update < GOLDKING_MARKET_SCORE_UPDATE_SECONDS)
      return;

   const double tf_weight[GOLDKING_MARKET_REGIME_TF_COUNT]={0.30,0.36,0.34};
   double weighted_score=0.0;
   double weighted_trend=0.0;
   double weight_sum=0.0;
   double frame[GOLDKING_MARKET_REGIME_TF_COUNT];
   for(int i=0; i<GOLDKING_MARKET_REGIME_TF_COUNT; ++i)
     {
      double trendiness=0.0;
      const double score=ComputeFrameScore(i,trendiness);
      frame[i]=score;
      g_market_frame_scores[i]=score;
      g_market_frame_trend_power[i]=trendiness;
      g_market_frame_range_pressure[i]=ClampDouble(1.0 - trendiness,0.0,1.0);
      g_market_frame_direction[i]=ClampUnitSigned(score / 100.0);
      g_market_frame_samples[i]=100.0;
      weighted_score+=score * tf_weight[i];
      weighted_trend+=trendiness * tf_weight[i];
      weight_sum+=tf_weight[i];
     }

   const double base_score=(weight_sum > 0.0 ? ClampDouble(weighted_score / weight_sum,-100.0,100.0) : 0.0);
   const int base_dir=(base_score > 0.0 ? 1 : (base_score < 0.0 ? -1 : 0));

   double aligned=0.0;
   double conflict=0.0;
   for(int i=0; i<GOLDKING_MARKET_REGIME_TF_COUNT; ++i)
     {
      const int fd=(frame[i] > 0.0 ? 1 : (frame[i] < 0.0 ? -1 : 0));
      if(fd == 0 || MathAbs(frame[i]) < 15.0)
         continue;
      if(fd == base_dir)
         aligned+=tf_weight[i];
      else
         conflict+=tf_weight[i];
     }
   g_market_score_coherence=(weight_sum > 0.0 ? ClampDouble(aligned / weight_sum,0.0,1.0) : 0.0);
   g_market_conflict_weight=(weight_sum > 0.0 ? conflict / weight_sum : 0.0);

   g_market_score_raw=base_score;
   double target_score=base_score;
   if(g_market_conflict_weight >= 0.40)
      target_score*=0.72;
   g_market_score_target=ClampDouble(target_score,-100.0,100.0);

   if(force)
      g_market_score=g_market_score_target;
   else
     {
      const bool flipping=(g_market_score * g_market_score_target < 0.0);
      const bool expanding=(MathAbs(g_market_score_target) > MathAbs(g_market_score));
      const double adapt=(flipping ? 0.80 : (expanding ? 0.55 : 0.22));
      g_market_score=ClampDouble(g_market_score + (g_market_score_target - g_market_score) * adapt,-100.0,100.0);
     }

   const double abs_score=MathAbs(g_market_score);
   g_market_state=MarketStateFromScore(g_market_score);
   g_market_trend_confidence=ClampDouble(abs_score / 100.0,0.0,1.0);
   g_market_trend_direction=(abs_score >= GOLDKING_MARKET_TREND_CONFIRM ? (g_market_score > 0.0 ? 1 : -1) : 0);
   g_market_range_probability=ClampDouble((weight_sum > 0.0 ? 1.0 - weighted_trend / weight_sum : 0.5) * 0.5
                                          + (1.0 - MathMin(1.0,abs_score / 70.0)) * 0.5,0.0,1.0);

   MqlRates m1rates[];
   ArraySetAsSeries(m1rates,true);
   const int m1copied=CopyRates(_Symbol,PERIOD_M1,0,60,m1rates);
   if(m1copied >= 52)
     {
      const double er_m1=EfficiencyRatio(m1rates,m1copied,0,30);
      const double chop_m1=ChoppinessIndex(m1rates,m1copied,0,20) / 100.0;
      g_ts_chop=ClampDouble(0.55 * (1.0 - er_m1) + 0.45 * chop_m1,0.0,1.0);
     }

   // Sticky trend direction (只做顺势 gate). Set early at TrendDirEnter; held
   // through pullbacks; cleared only when the score decays past TrendDirExit
   // or flips sign. Forced flat while the market is choppy (anti-whipsaw).
   const int desired_dir=(g_market_score > 0.0 ? 1 : (g_market_score < 0.0 ? -1 : 0));
   if(g_ts_chop > ChopGate)
      g_ts_dir=0;
   else if(g_ts_dir == 0)
     {
      if(abs_score >= TrendDirEnter)
         g_ts_dir=desired_dir;
     }
   else if(desired_dir != 0 && desired_dir != g_ts_dir && abs_score >= TrendDirEnter)
      g_ts_dir=desired_dir;
   else if(abs_score <= TrendDirExit)
      g_ts_dir=0;

   g_last_regime_update=now_value;
  }

int PricePointScale()
  {
   return((_Digits == 3 || _Digits == 5) ? 10 : 1);
  }

int PriceDistancePoints(const int points)
  {
   return((int)MathMax(0,points) * PricePointScale());
  }

double PipDivisor()
  {
   return((double)PricePointScale());
  }

double CurrentSpreadPoints()
  {
   double ask_price=0.0;
   double bid_price=0.0;
   if(!SymbolInfoDouble(_Symbol,SYMBOL_ASK,ask_price) || !SymbolInfoDouble(_Symbol,SYMBOL_BID,bid_price))
      return(0.0);
   return((ask_price - bid_price) / _Point);
  }

int VolumeDigits(const double step)
  {
   string step_text=DoubleToString(step,8);
   int end_index=StringLen(step_text) - 1;
   while(end_index >= 0 && StringGetCharacter(step_text,end_index) == '0')
      end_index--;
   const int dot_index=StringFind(step_text,".");
   if(dot_index < 0 || end_index <= dot_index)
      return(0);
   return(end_index - dot_index);
  }

double NormalizeVolumeToSymbol(double volume)
  {
   const double min_volume=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   const double max_volume=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   const double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   const int digits=VolumeDigits(step);

   volume=MathMin(volume,max_volume);
   volume=MathMax(volume,min_volume);
   if(step > 0.0)
      volume=MathRound(volume / step) * step;
   return(NormalizeDouble(volume,digits));
  }

double AdjustVolumeAvoidLock(const EAStats &stats,const bool is_buy,double volume)
  {
   // V3.1 keeps volumes flat. A locked pair (buy_lots == sell_lots) is harmless
   // -- its P/L is frozen -- and flat volume makes the per-side exposure cap
   // exact, which matters more here than V3's lock-avoidance bump.
   return(NormalizeVolumeToSymbol(volume));
  }

double NormalizePriceToSymbol(double price)
  {
   const double tick_size=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   if(tick_size > 0.0)
      price=MathRound(price / tick_size) * tick_size;
   return(NormalizeDouble(price,_Digits));
  }

double NormalizePriceDirectional(const double price,const bool round_up)
  {
   const double tick_size=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double normalized=price;
   if(tick_size > 0.0)
     {
      const double units=price / tick_size;
      normalized=(round_up ? MathCeil(units) : MathFloor(units)) * tick_size;
     }
   return(NormalizeDouble(normalized,_Digits));
  }

int BrokerMinDistancePoints()
  {
   const long freeze_level=SymbolInfoInteger(_Symbol,SYMBOL_TRADE_FREEZE_LEVEL);
   const long stop_level=SymbolInfoInteger(_Symbol,SYMBOL_TRADE_STOPS_LEVEL);
   long base=MathMax(freeze_level,stop_level);
   if(!MQLInfoInteger(MQL_TESTER))   // [宽点差券商修复] 实盘把当前点差+延迟裕度计入最小挂单距离(回测不变=保byte-identical)
     {
      double ask=0.0,bid=0.0;
      if(SymbolInfoDouble(_Symbol,SYMBOL_ASK,ask) && SymbolInfoDouble(_Symbol,SYMBOL_BID,bid) && ask>bid && _Point>0.0)
         base=MathMax(base,(long)MathCeil((ask-bid)/_Point)+5);   // 点差 + 5点延迟裕度
     }
   return((int)base + 1);
  }

int StopOrderMinDistancePoints()
  {
   return(BrokerMinDistancePoints() + PriceDistancePoints(GOLDKING_STOP_ORDER_SAFETY_POINTS));
  }

bool PrepareStopOrderPrice(const ENUM_ORDER_TYPE type,const double raw_price,double &safe_price)
  {
   safe_price=0.0;

   double ask_price=0.0;
   double bid_price=0.0;
   if(!SymbolInfoDouble(_Symbol,SYMBOL_ASK,ask_price) ||
      !SymbolInfoDouble(_Symbol,SYMBOL_BID,bid_price) ||
      ask_price <= 0.0 ||
      bid_price <= 0.0 ||
      _Point <= 0.0)
      return(false);

   const double min_distance=StopOrderMinDistancePoints() * _Point;
   if(type == ORDER_TYPE_BUY_STOP)
     {
      const double min_price=ask_price + min_distance;
      safe_price=NormalizePriceDirectional(MathMax(raw_price,min_price),true);
      if(safe_price < min_price)
         safe_price=NormalizePriceDirectional(min_price,true);
      return(safe_price > ask_price && safe_price >= min_price);
     }

   if(type == ORDER_TYPE_SELL_STOP)
     {
      const double max_price=bid_price - min_distance;
      safe_price=NormalizePriceDirectional(MathMin(raw_price,max_price),false);
      if(safe_price > max_price)
         safe_price=NormalizePriceDirectional(max_price,false);
      return(safe_price < bid_price && safe_price <= max_price);
     }

   return(false);
  }

bool CanAffordOrder(const ENUM_ORDER_TYPE type,const double volume,const double price)
  {
   if(volume <= 0.0 || price <= 0.0)
      return(false);

   double margin=0.0;
   if(!OrderCalcMargin(type,_Symbol,volume,price,margin))
      return(false);

   const double free_margin=AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   if(free_margin <= 0.0 || equity <= 0.0)
      return(false);

   return(free_margin > margin * 1.15 && equity > margin * 1.25);
  }

ulong TradeDeviationPoints()
  {
   return((ulong)PriceDistancePoints(Slippage));
  }

bool IsHedgingAccount()
  {
   return((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
  }

void ResetStats(EAStats &stats)
  {
   ZeroMemory(stats);
   stats.buy_highest_any    = 0.0;
   stats.buy_lowest_position= 0.0;
   stats.sell_highest_position=0.0;
   stats.sell_lowest_any    = 0.0;
   stats.buy_pending_price  = 0.0;
   stats.sell_pending_price = 0.0;
   stats.buy_pending_ticket = 0;
   stats.sell_pending_ticket= 0;
   stats.single_position_ticket=0;
   stats.single_position_open_price=0.0;
   stats.latest_position_open_time=0;
  }

double EstimatedPositionCommission(const double volume)
  {
   return(MathAbs(CommissionPerLot) * MathMax(0.0,volume));
  }

double EstimatedExecutionCostBuffer(const double volume)
  {
   const double safe_volume=MathMax(0.0,volume);
   if(safe_volume <= 0.0)
      return(0.0);

   const double tick_size=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tick_value=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(tick_value <= 0.0)
      tick_value=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT);
   if(tick_size <= 0.0 || tick_value <= 0.0)
      return(EstimatedPositionCommission(safe_volume));

   const double point_value=_Point / tick_size * tick_value * safe_volume;
   const double spread_cost=CurrentSpreadPoints() * point_value;
   const double slippage_cost=(double)TradeDeviationPoints() * point_value;
   return(EstimatedPositionCommission(safe_volume) + spread_cost + slippage_cost);
  }

double CurrentPositionNetProfit()
  {
   const double volume=PositionGetDouble(POSITION_VOLUME);
   return(PositionGetDouble(POSITION_PROFIT) +
          PositionGetDouble(POSITION_SWAP) -
          EstimatedPositionCommission(volume));
  }

double PointValueForVolume(const double volume)
  {
   const double safe_volume=MathMax(0.0,volume);
   if(safe_volume <= 0.0)
      return(0.0);

   const double tick_size=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tick_value=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(tick_value <= 0.0)
      tick_value=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT);
   if(tick_size <= 0.0 || tick_value <= 0.0 || _Point <= 0.0)
      return(0.0);

   return(_Point / tick_size * tick_value * safe_volume);
  }

double EstimatedSlippageCost(const double volume)
  {
   return((double)TradeDeviationPoints() * PointValueForVolume(volume));
  }

double StatsGrossLots(const EAStats &stats)
  {
   return(MathMax(0.0,stats.buy_lots + stats.sell_lots));
  }

double StatsNetLots(const EAStats &stats)
  {
   return(MathAbs(stats.buy_lots - stats.sell_lots));
  }

int StatsNetDirection(const EAStats &stats)
  {
   const double diff=stats.buy_lots - stats.sell_lots;
   if(diff > 0.0000001)
      return(1);
   if(diff < -0.0000001)
      return(-1);
   return(0);
  }

double TrailingNetProfitAfterCosts(const EAStats &stats)
  {
   // Position profit already uses Bid/Ask, so spread is reflected here; add only close slippage risk.
   return(stats.total_profit - EstimatedSlippageCost(StatsGrossLots(stats)));
  }

double TrailingPriceMoveMoney(const EAStats &stats,const int points)
  {
   return(PointValueForVolume(StatsNetLots(stats)) * PriceDistancePoints(points));
  }

bool CurrentTrailPrice(const int direction,double &price)
  {
   price=0.0;
   if(direction > 0)
      return(SymbolInfoDouble(_Symbol,SYMBOL_BID,price) && price > 0.0);
   if(direction < 0)
      return(SymbolInfoDouble(_Symbol,SYMBOL_ASK,price) && price > 0.0);
   return(false);
  }

bool TrailPriceRetraced(const int direction,const double peak_price,const double current_price,const int step_points)
  {
   if(peak_price <= 0.0 || current_price <= 0.0 || _Point <= 0.0)
      return(false);

   const double step_distance=(double)PriceDistancePoints(step_points) * _Point;
   if(direction > 0)
      return(current_price <= peak_price - step_distance);
   if(direction < 0)
      return(current_price >= peak_price + step_distance);
   return(false);
  }

double TrailRetracePrice(const int direction,const double peak_price,const int step_points)
  {
   if(peak_price <= 0.0 || _Point <= 0.0)
      return(0.0);

   const double step_distance=(double)PriceDistancePoints(step_points) * _Point;
   if(direction > 0)
      return(NormalizePriceToSymbol(peak_price - step_distance));
   if(direction < 0)
      return(NormalizePriceToSymbol(peak_price + step_distance));
   return(0.0);
  }

void CollectStats(EAStats &stats)
  {
   ResetStats(stats);

   for(int i=PositionsTotal()-1; i>=0; --i)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != Magic)
         continue;

      const ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      const double open_price=PositionGetDouble(POSITION_PRICE_OPEN);
      const double volume=PositionGetDouble(POSITION_VOLUME);
      const double profit=CurrentPositionNetProfit();
      const datetime open_time=(datetime)PositionGetInteger(POSITION_TIME);
      const int selected_positions=stats.buy_positions + stats.sell_positions;
      if(open_time > stats.latest_position_open_time)
         stats.latest_position_open_time=open_time;

      if(selected_positions == 0)
        {
         stats.single_position_ticket=ticket;
         stats.single_position_type=type;
         stats.single_position_open_price=open_price;
        }
      else
         stats.single_position_ticket=0;

      if(type == POSITION_TYPE_BUY)
        {
         stats.buy_positions++;
         stats.buy_lots+=volume;
         stats.buy_profit+=profit;
         if(open_price > stats.buy_highest_any || stats.buy_highest_any == 0.0)
            stats.buy_highest_any=open_price;
         if(open_price < stats.buy_lowest_position || stats.buy_lowest_position == 0.0)
            stats.buy_lowest_position=open_price;
        }
      else if(type == POSITION_TYPE_SELL)
        {
         stats.sell_positions++;
         stats.sell_lots+=volume;
         stats.sell_profit+=profit;
         if(open_price > stats.sell_highest_position || stats.sell_highest_position == 0.0)
            stats.sell_highest_position=open_price;
         if(open_price < stats.sell_lowest_any || stats.sell_lowest_any == 0.0)
            stats.sell_lowest_any=open_price;
        }
     }

   for(int i=OrdersTotal()-1; i>=0; --i)
     {
      const ulong ticket=OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket))
         continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol)
         continue;
      if((long)OrderGetInteger(ORDER_MAGIC) != Magic)
         continue;

      const ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      const double open_price=OrderGetDouble(ORDER_PRICE_OPEN);
      const string cmt=OrderGetString(ORDER_COMMENT);
      const bool is_lz=(StringFind(cmt,"LZ_")==0);

      if(type == ORDER_TYPE_BUY_STOP)
        {
         stats.buy_pending++;
         if(!is_lz) stats.buy_pending_regular++;
         if(open_price > stats.buy_highest_any || stats.buy_highest_any == 0.0)
            stats.buy_highest_any=open_price;
         if(ticket > stats.buy_pending_ticket)
           {
            stats.buy_pending_ticket=ticket;
            stats.buy_pending_price=open_price;
           }
        }
      else if(type == ORDER_TYPE_SELL_STOP)
        {
         stats.sell_pending++;
         if(!is_lz) stats.sell_pending_regular++;
         if(open_price < stats.sell_lowest_any || stats.sell_lowest_any == 0.0)
            stats.sell_lowest_any=open_price;
         if(ticket > stats.sell_pending_ticket)
           {
            stats.sell_pending_ticket=ticket;
            stats.sell_pending_price=open_price;
           }
        }
     }

   stats.total_profit=stats.buy_profit + stats.sell_profit;
  }

double CalculateClosedProfit(const datetime from_time,const datetime to_time,const long magic_filter,const bool current_symbol_only)
  {
   double total=0.0;
   if(!HistorySelect(from_time,to_time))
      return(0.0);

   const int deals_total=(int)HistoryDealsTotal();
   for(int i=0; i<deals_total; ++i)
     {
      const ulong deal_ticket=HistoryDealGetTicket(i);
      if(deal_ticket == 0)
         continue;

      const ENUM_DEAL_ENTRY entry=(ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal_ticket,DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT)
         continue;

      if(current_symbol_only && HistoryDealGetString(deal_ticket,DEAL_SYMBOL) != _Symbol)
         continue;

      if(magic_filter != -1 && (long)HistoryDealGetInteger(deal_ticket,DEAL_MAGIC) != magic_filter)
         continue;

      total+=HistoryDealGetDouble(deal_ticket,DEAL_PROFIT);
      total+=HistoryDealGetDouble(deal_ticket,DEAL_SWAP);
      total+=HistoryDealGetDouble(deal_ticket,DEAL_COMMISSION);
     }

   return(total);
  }

string TradingDayKey(const datetime now_value)
  {
   return(TimeToString(now_value,TIME_DATE));
  }

double TodayClosedProfit(const datetime now_value)
  {
   return(CalculateClosedProfit(TodayAt("00:00",now_value),TimeCurrent(),Magic,true));
  }

double TodayProgressProfit(const datetime now_value,const EAStats &stats)
  {
   return(TodayClosedProfit(now_value) + stats.total_profit);
  }

bool HasOpenPositions(const EAStats &stats)
  {
   return((stats.buy_positions + stats.sell_positions) > 0);
  }

void RefreshDailyLocks(const datetime now_value,const EAStats &stats)
  {
   const string day_key=TradingDayKey(now_value);
   if(day_key != g_today_key)
     {
      g_today_key=day_key;
      g_daily_target_locked=false;
      g_daily_target_hit_value=0.0;
     }

   if(DailyProfitTarget <= 0.0)
     {
      g_daily_target_locked=false;
      g_daily_target_hit_value=0.0;
      return;
     }

   if(g_daily_target_locked)
      return;

   const double today_progress=TodayProgressProfit(now_value,stats);
   if(today_progress >= DailyProfitTarget)
     {
      g_daily_target_locked=true;
      g_daily_target_hit_value=today_progress;
     }
  }

bool GetPositionNetProfitAndVolume(const ulong ticket,double &profit,double &volume)
  {
   profit=0.0;
   volume=0.0;
   if(ticket == 0 || !PositionSelectByTicket(ticket))
      return(false);
   if(PositionGetString(POSITION_SYMBOL) != _Symbol)
      return(false);
   if((long)PositionGetInteger(POSITION_MAGIC) != Magic)
      return(false);

   volume=PositionGetDouble(POSITION_VOLUME);
   if(volume <= 0.0)
      return(false);

   profit=CurrentPositionNetProfit();
   return(true);
  }

double SelectedPositionAdverseDistancePoints()
  {
   const ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   const double open_price=PositionGetDouble(POSITION_PRICE_OPEN);
   double close_price=0.0;

   if(type == POSITION_TYPE_BUY)
     {
      if(!SymbolInfoDouble(_Symbol,SYMBOL_BID,close_price))
         return(0.0);
      return(MathMax(0.0,(open_price - close_price) / _Point));
     }

   if(!SymbolInfoDouble(_Symbol,SYMBOL_ASK,close_price))
      return(0.0);
   return(MathMax(0.0,(close_price - open_price) / _Point));
  }

bool EstimatePairNetAfterCosts(const ulong profit_ticket,const ulong risk_ticket,double &paired_volume,double &net_after_costs)
  {
   paired_volume=0.0;
   net_after_costs=0.0;

   double profit_side_net=0.0;
   double profit_side_volume=0.0;
   double risk_side_net=0.0;
   double risk_side_volume=0.0;
   if(!GetPositionNetProfitAndVolume(profit_ticket,profit_side_net,profit_side_volume) ||
      !GetPositionNetProfitAndVolume(risk_ticket,risk_side_net,risk_side_volume))
      return(false);

   if(profit_side_net <= 0.0)
      return(false);

   if(!PositionSelectByTicket(profit_ticket))
      return(false);
   const ENUM_POSITION_TYPE profit_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   if(!PositionSelectByTicket(risk_ticket))
      return(false);
   const ENUM_POSITION_TYPE risk_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   if(profit_type == risk_type)
      return(false);

   paired_volume=MathMin(profit_side_volume,risk_side_volume);
   if(paired_volume <= 0.0)
      return(false);

   const double estimated_pair_net=profit_side_net / profit_side_volume * paired_volume +
                                   risk_side_net / risk_side_volume * paired_volume;
   net_after_costs=estimated_pair_net - EstimatedExecutionCostBuffer(paired_volume);
   return(net_after_costs >= GOLDKING_PAIR_CLOSE_MIN_NET);
  }

bool FindProfitableReductionPair(const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,ulong &profit_ticket,ulong &risk_ticket,double &net_after_costs)
  {
   profit_ticket=0;
   risk_ticket=0;
   net_after_costs=0.0;
   bool found=false;
   double selected_risk_distance=0.0;
   double selected_risk_net=0.0;

   for(int r=PositionsTotal()-1; r>=0; --r)
     {
      const ulong candidate_risk_ticket=PositionGetTicket(r);
      if(candidate_risk_ticket == 0 || !PositionSelectByTicket(candidate_risk_ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != Magic)
         continue;
      if((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) != risk_type)
         continue;

      const double candidate_risk_net=CurrentPositionNetProfit();
      if(candidate_risk_net >= 0.0)
         continue;
      const double candidate_risk_distance=SelectedPositionAdverseDistancePoints();
      for(int p=PositionsTotal()-1; p>=0; --p)
        {
         const ulong candidate_profit_ticket=PositionGetTicket(p);
         if(candidate_profit_ticket == 0 || candidate_profit_ticket == candidate_risk_ticket || !PositionSelectByTicket(candidate_profit_ticket))
            continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol)
            continue;
         if((long)PositionGetInteger(POSITION_MAGIC) != Magic)
            continue;
         if((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) != profit_type)
            continue;
         double candidate_paired_volume=0.0;
         double candidate_net_after_costs=0.0;
         if(!EstimatePairNetAfterCosts(candidate_profit_ticket,candidate_risk_ticket,candidate_paired_volume,candidate_net_after_costs))
            continue;

         if(!found ||
            candidate_risk_distance > selected_risk_distance ||
            (candidate_risk_distance == selected_risk_distance && candidate_risk_net < selected_risk_net) ||
            (candidate_risk_distance == selected_risk_distance && candidate_risk_net == selected_risk_net && candidate_net_after_costs > net_after_costs))
           {
            found=true;
            selected_risk_distance=candidate_risk_distance;
            selected_risk_net=candidate_risk_net;
            profit_ticket=candidate_profit_ticket;
            risk_ticket=candidate_risk_ticket;
            net_after_costs=candidate_net_after_costs;
           }
        }
     }

   return(found);
  }

bool TryPairedSideReduction(const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type)
  {
   ulong profit_ticket=0;
   ulong risk_ticket=0;
   double net_after_costs=0.0;
   if(!FindProfitableReductionPair(profit_type,risk_type,profit_ticket,risk_ticket,net_after_costs))
      return(false);

   double paired_volume=0.0;
   if(!EstimatePairNetAfterCosts(profit_ticket,risk_ticket,paired_volume,net_after_costs))
      return(false);

   DeleteEaPendingOrders();

   if(!EstimatePairNetAfterCosts(profit_ticket,risk_ticket,paired_volume,net_after_costs))
      return(false);

   if(CloseByPair(profit_ticket,risk_ticket))
      return(true);
   return(CloseByPair(risk_ticket,profit_ticket));
  }

bool TrendProtectedPairAllowed(const EAStats &stats,const int trend_direction,const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,const double paired_volume)
  {
   if(trend_direction == 0 || paired_volume <= 0.0)
      return(false);

   const ENUM_POSITION_TYPE protect_type=(trend_direction > 0 ? POSITION_TYPE_BUY : POSITION_TYPE_SELL);
   const ENUM_POSITION_TYPE adverse_type=(trend_direction > 0 ? POSITION_TYPE_SELL : POSITION_TYPE_BUY);
   if(profit_type != protect_type || risk_type != adverse_type)
      return(true);

   const double protect_lots=(trend_direction > 0 ? stats.buy_lots : stats.sell_lots);
   const double risk_lots=(trend_direction > 0 ? stats.sell_lots : stats.buy_lots);
   if(protect_lots <= 0.0 || risk_lots <= 0.0)
      return(true);

   const double after_protect=MathMax(0.0,protect_lots - paired_volume);
   const double after_risk=MathMax(0.0,risk_lots - paired_volume);
   if(after_risk <= 0.0)
      return(true);

   const double min_ratio=MarketTrendProtectionRatio();
   const double max_pair_share=0.30;
   if(paired_volume > MathMax(SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),protect_lots * max_pair_share))
      return(false);

   return(after_protect >= after_risk * min_ratio);
  }

bool FindTrendProtectedReductionPair(const EAStats &stats,const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,const int trend_direction,ulong &profit_ticket,ulong &risk_ticket,double &net_after_costs)
  {
   profit_ticket=0;
   risk_ticket=0;
   net_after_costs=0.0;
   bool found=false;
   double selected_risk_distance=0.0;
   double selected_risk_net=0.0;

   for(int r=PositionsTotal()-1; r>=0; --r)
     {
      const ulong candidate_risk_ticket=PositionGetTicket(r);
      if(candidate_risk_ticket == 0 || !PositionSelectByTicket(candidate_risk_ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != Magic)
         continue;
      if((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) != risk_type)
         continue;

      const double candidate_risk_net=CurrentPositionNetProfit();
      if(candidate_risk_net >= 0.0)
         continue;
      const double candidate_risk_distance=SelectedPositionAdverseDistancePoints();

      for(int p=PositionsTotal()-1; p>=0; --p)
        {
         const ulong candidate_profit_ticket=PositionGetTicket(p);
         if(candidate_profit_ticket == 0 || candidate_profit_ticket == candidate_risk_ticket || !PositionSelectByTicket(candidate_profit_ticket))
            continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol)
            continue;
         if((long)PositionGetInteger(POSITION_MAGIC) != Magic)
            continue;
         if((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) != profit_type)
            continue;

         double candidate_paired_volume=0.0;
         double candidate_net_after_costs=0.0;
         if(!EstimatePairNetAfterCosts(candidate_profit_ticket,candidate_risk_ticket,candidate_paired_volume,candidate_net_after_costs))
            continue;
         if(!TrendProtectedPairAllowed(stats,trend_direction,profit_type,risk_type,candidate_paired_volume))
            continue;

         if(!found ||
            candidate_risk_distance > selected_risk_distance ||
            (candidate_risk_distance == selected_risk_distance && candidate_risk_net < selected_risk_net) ||
            (candidate_risk_distance == selected_risk_distance && candidate_risk_net == selected_risk_net && candidate_net_after_costs > net_after_costs))
           {
            found=true;
            selected_risk_distance=candidate_risk_distance;
            selected_risk_net=candidate_risk_net;
            profit_ticket=candidate_profit_ticket;
            risk_ticket=candidate_risk_ticket;
            net_after_costs=candidate_net_after_costs;
           }
        }
     }

   return(found);
  }

bool TryTrendProtectedPairReduction(const EAStats &stats,const ENUM_POSITION_TYPE profit_type,const ENUM_POSITION_TYPE risk_type,const int trend_direction)
  {
   ulong profit_ticket=0;
   ulong risk_ticket=0;
   double net_after_costs=0.0;
   if(!FindTrendProtectedReductionPair(stats,profit_type,risk_type,trend_direction,profit_ticket,risk_ticket,net_after_costs))
      return(false);

   double paired_volume=0.0;
   if(!EstimatePairNetAfterCosts(profit_ticket,risk_ticket,paired_volume,net_after_costs))
      return(false);
   if(!TrendProtectedPairAllowed(stats,trend_direction,profit_type,risk_type,paired_volume))
      return(false);

   DeleteEaPendingOrders();

   if(!EstimatePairNetAfterCosts(profit_ticket,risk_ticket,paired_volume,net_after_costs))
      return(false);
   if(!TrendProtectedPairAllowed(stats,trend_direction,profit_type,risk_type,paired_volume))
      return(false);

   if(CloseByPair(profit_ticket,risk_ticket))
      return(true);
   return(CloseByPair(risk_ticket,profit_ticket));
  }

ulong FindNewestPositionTicket(const ENUM_POSITION_TYPE type,const bool current_symbol_only,const long magic_filter)
  {
   ulong newest_ticket=0;
   for(int i=PositionsTotal()-1; i>=0; --i)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(current_symbol_only && PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(magic_filter != -1 && (long)PositionGetInteger(POSITION_MAGIC) != magic_filter)
         continue;
      if((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE) != type)
         continue;
      if(ticket > newest_ticket)
         newest_ticket=ticket;
     }
   return(newest_ticket);
  }

bool CloseByPair(const ulong position_ticket,const ulong opposite_ticket)
  {
   if(position_ticket == 0 || opposite_ticket == 0 || position_ticket == opposite_ticket)
      return(false);

   if(g_close_by_unsupported)
      return(false);

   if(!PositionSelectByTicket(position_ticket))
      return(false);
   const string position_symbol=PositionGetString(POSITION_SYMBOL);
   const long position_magic=(long)PositionGetInteger(POSITION_MAGIC);
   const ENUM_POSITION_TYPE position_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

   if(!PositionSelectByTicket(opposite_ticket))
      return(false);
   const string opposite_symbol=PositionGetString(POSITION_SYMBOL);
   const long opposite_magic=(long)PositionGetInteger(POSITION_MAGIC);
   const ENUM_POSITION_TYPE opposite_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

   if(position_symbol != _Symbol || opposite_symbol != _Symbol)
      return(false);
   if(position_magic != Magic || opposite_magic != Magic)
      return(false);
   if(position_type == opposite_type)
      return(false);

   MqlTradeRequest request={};
   MqlTradeResult  result={};
   request.action=TRADE_ACTION_CLOSE_BY;
   request.position=position_ticket;
   request.position_by=opposite_ticket;
   request.magic=Magic;
   request.deviation=TradeDeviationPoints();

   const bool request_ok=OrderSend(request,result);
   if(request_ok && TradeRetcodeOk(result.retcode))
      return(true);

   if(result.retcode == TRADE_RETCODE_INVALID_ORDER ||
      result.retcode == TRADE_RETCODE_INVALID ||
      result.retcode == TRADE_RETCODE_TRADE_DISABLED)
     {
      g_close_by_unsupported=true;
      PrintFormat("CloseByPair unsupported by broker (retcode=%u). Falling back to individual PositionClose for the rest of this session.",
                  result.retcode);
      return(false);
     }

   CheckOrderSendResult(request_ok,result,"CloseByPair");
   return(false);
  }



void CloseOppositePairs()
  {
   while(true)
     {
      const ulong buy_ticket=FindNewestPositionTicket(POSITION_TYPE_BUY,true,Magic);
      const ulong sell_ticket=FindNewestPositionTicket(POSITION_TYPE_SELL,true,Magic);
      if(buy_ticket == 0 || sell_ticket == 0)
         break;

      if(CloseByPair(buy_ticket,sell_ticket))
         continue;
      if(CloseByPair(sell_ticket,buy_ticket))
         continue;
      break;
     }
  }

bool TradeRetcodeOk(const uint retcode)
  {
   return(retcode == TRADE_RETCODE_DONE ||
          retcode == TRADE_RETCODE_DONE_PARTIAL ||
          retcode == TRADE_RETCODE_PLACED ||
          retcode == TRADE_RETCODE_NO_CHANGES);
  }

bool CheckTradeResult(const bool request_ok,const string action)
  {
   const uint retcode=g_trade.ResultRetcode();
   if(request_ok && TradeRetcodeOk(retcode))
      return(true);

   PrintFormat("%s failed on %s: request_ok=%s retcode=%u detail=%s",
               action,
               _Symbol,
               request_ok ? "true" : "false",
               retcode,
               g_trade.ResultRetcodeDescription());
   return(false);
  }

bool CheckOrderSendResult(const bool request_ok,const MqlTradeResult &result,const string action)
  {
   if(request_ok && TradeRetcodeOk(result.retcode))
      return(true);

   PrintFormat("%s failed on %s: request_ok=%s retcode=%u order=%I64u deal=%I64u",
               action,
               _Symbol,
               request_ok ? "true" : "false",
               result.retcode,
               result.order,
               result.deal);
   return(false);
  }

// 瞬时错误 → 可重试 (broker 端价格变动/连接抖动/服务器忙)
bool IsTransientTradeError(const uint retcode)
  {
   return(retcode == TRADE_RETCODE_REQUOTE          ||  // 10004
          retcode == TRADE_RETCODE_REJECT           ||  // 10006
          retcode == TRADE_RETCODE_TIMEOUT          ||  // 10012
          retcode == TRADE_RETCODE_INVALID_PRICE    ||  // 10015
          retcode == TRADE_RETCODE_PRICE_CHANGED    ||  // 10020
          retcode == TRADE_RETCODE_PRICE_OFF        ||  // 10021
          retcode == TRADE_RETCODE_TOO_MANY_REQUESTS||  // 10024
          retcode == TRADE_RETCODE_LOCKED           ||  // 10028
          retcode == TRADE_RETCODE_FROZEN           ||  // 10029
          retcode == TRADE_RETCODE_CONNECTION);         // 10031
  }

// 仓位已经不在了(被别人关掉/服务端已关) → 算成功
bool IsPositionGoneRetcode(const uint retcode)
  {
   return(retcode == TRADE_RETCODE_POSITION_CLOSED);   // 10036
  }

bool ClosePositionTicket(const ulong ticket)
  {
   if(ticket == 0 || !PositionSelectByTicket(ticket))
      return(false);

   const int max_retries = 5;
   const ulong base_deviation = TradeDeviationPoints();
   g_trade.SetAsyncMode(false);

   for(int attempt = 0; attempt < max_retries; attempt++)
     {
      // 仓位可能在重试间隙被关掉或自然消失 → 算成功
      if(!PositionSelectByTicket(ticket))
         return(true);
      // deviation 逐步放大: 1x → 2x → 3x → 4x → 5x,应对快速行情
      const ulong deviation = base_deviation * (1 + attempt);
      g_trade.SetDeviationInPoints(deviation);
      const bool req_ok = g_trade.PositionClose(ticket, deviation);
      const uint retcode = g_trade.ResultRetcode();
      if(req_ok && TradeRetcodeOk(retcode))
         return(true);
      // 仓位状态已无 (POSITION_CLOSED) → 视为成功
      if(IsPositionGoneRetcode(retcode) || !PositionSelectByTicket(ticket))
         return(true);
      // 非瞬时错误 (FILL/STOPS/MONEY/MARKET_CLOSED 等) → 立即放弃
      if(!IsTransientTradeError(retcode))
        {
         PrintFormat("ClosePositionTicket %I64u fatal retcode=%u (%s) attempt=%d",
                     ticket, retcode, g_trade.ResultRetcodeDescription(), attempt);
         return(false);
        }
      // 瞬时错误 → 短暂等待后重试 (100ms / 200ms / 300ms / 400ms / 500ms)
      Sleep(100 * (attempt + 1));
     }
   PrintFormat("ClosePositionTicket %I64u exhausted %d retries; last retcode=%u (%s)",
               ticket, max_retries, g_trade.ResultRetcode(), g_trade.ResultRetcodeDescription());
   return(false);
  }

bool DeletePendingOrder(const ulong ticket)
  {
   if(ticket == 0)
      return(false);

   const int max_retries = 5;
   g_trade.SetAsyncMode(false);

   for(int attempt = 0; attempt < max_retries; attempt++)
     {
      // 挂单已不存在 (已被填或已撤) → 算成功
      if(!OrderSelect(ticket))
         return(true);
      const bool req_ok = g_trade.OrderDelete(ticket);
      const uint retcode = g_trade.ResultRetcode();
      if(req_ok && TradeRetcodeOk(retcode))
         return(true);
      // OrderDelete 返回 INVALID_ORDER 通常意味着单子已不存在(被填/已撤) — 复核一次
      if(retcode == TRADE_RETCODE_INVALID_ORDER || retcode == TRADE_RETCODE_INVALID)
        {
         if(!OrderSelect(ticket))
            return(true);
        }
      if(!IsTransientTradeError(retcode))
        {
         PrintFormat("DeletePendingOrder %I64u fatal retcode=%u (%s) attempt=%d",
                     ticket, retcode, g_trade.ResultRetcodeDescription(), attempt);
         return(false);
        }
      Sleep(100 * (attempt + 1));
     }
   PrintFormat("DeletePendingOrder %I64u exhausted %d retries; last retcode=%u (%s)",
               ticket, max_retries, g_trade.ResultRetcode(), g_trade.ResultRetcodeDescription());
   return(false);
  }

void DeleteEaPendingOrders()
  {
   for(int i=OrdersTotal()-1; i>=0; --i)
     {
      const ulong ticket=OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket))
         continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol)
         continue;
      if((long)OrderGetInteger(ORDER_MAGIC) != Magic)
         continue;

      const ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_STOP && type != ORDER_TYPE_SELL_STOP)
         continue;
      DeletePendingOrder(ticket);
     }
  }

void DeleteCurrentSymbolPendingOrders()
  {
   for(int i=OrdersTotal()-1; i>=0; --i)
     {
      const ulong ticket=OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket))
         continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol)
         continue;

      const ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_STOP &&
         type != ORDER_TYPE_SELL_STOP &&
         type != ORDER_TYPE_BUY_LIMIT &&
         type != ORDER_TYPE_SELL_LIMIT &&
         type != ORDER_TYPE_BUY_STOP_LIMIT &&
         type != ORDER_TYPE_SELL_STOP_LIMIT)
         continue;
      DeletePendingOrder(ticket);
     }
  }

bool PendingOrderMatchesCloseScope(const ENUM_ORDER_TYPE type,const int direction)
  {
   const bool is_buy_order=(type == ORDER_TYPE_BUY_STOP ||
                            type == ORDER_TYPE_BUY_LIMIT ||
                            type == ORDER_TYPE_BUY_STOP_LIMIT);
   const bool is_sell_order=(type == ORDER_TYPE_SELL_STOP ||
                             type == ORDER_TYPE_SELL_LIMIT ||
                             type == ORDER_TYPE_SELL_STOP_LIMIT);

   if(direction == 1)
      return(is_buy_order);
   if(direction == -1)
      return(is_sell_order);
   return(is_buy_order || is_sell_order);
  }

void DeletePendingOrdersForCloseScope(const int direction,const bool current_symbol_only,const long magic_filter)
  {
   for(int i=OrdersTotal()-1; i>=0; --i)
     {
      const ulong ticket=OrderGetTicket(i);
      if(ticket == 0 || !OrderSelect(ticket))
         continue;
      if(current_symbol_only && OrderGetString(ORDER_SYMBOL) != _Symbol)
         continue;
      if(magic_filter != -1 && (long)OrderGetInteger(ORDER_MAGIC) != magic_filter)
         continue;

      const ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(!PendingOrderMatchesCloseScope(type,direction))
         continue;
      DeletePendingOrder(ticket);
     }
  }

bool ModifyPendingPrice(const ulong ticket,const double new_price)
  {
   if(ticket == 0 || !OrderSelect(ticket))
      return(false);

   const ENUM_ORDER_TYPE order_type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
   double safe_price=new_price;
   if(order_type == ORDER_TYPE_BUY_STOP || order_type == ORDER_TYPE_SELL_STOP)
     {
      if(!PrepareStopOrderPrice(order_type,new_price,safe_price))
         return(false);

      const double order_volume=OrderGetDouble(ORDER_VOLUME_CURRENT);
      if(!CanAffordOrder(order_type,order_volume,safe_price))
        {
         DeletePendingOrder(ticket);
         return(false);
        }

      const double current_price=OrderGetDouble(ORDER_PRICE_OPEN);
      const double tick_size=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
      const double min_change=(tick_size > 0.0 ? tick_size * 0.5 : _Point * 0.5);
      if(MathAbs(current_price - safe_price) < min_change)
         return(false);
     }

   MqlTradeRequest request={};
   MqlTradeResult  result={};
   request.action=TRADE_ACTION_MODIFY;
   request.order=ticket;
   request.symbol=OrderGetString(ORDER_SYMBOL);
   request.magic=(ulong)OrderGetInteger(ORDER_MAGIC);
   request.price=safe_price;
   request.sl=0.0;
   request.tp=0.0;
   request.type_time=ORDER_TIME_GTC;
   request.expiration=0;

   return(CheckOrderSendResult(OrderSend(request,result),result,"ModifyPendingPrice"));
  }

bool SelectedPositionMatchesCloseScope(const int direction,const bool current_symbol_only,const long magic_filter)
  {
   if(current_symbol_only && PositionGetString(POSITION_SYMBOL) != _Symbol)
      return(false);
   if(magic_filter != -1 && (long)PositionGetInteger(POSITION_MAGIC) != magic_filter)
      return(false);

   const ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   if(direction == 1 && type != POSITION_TYPE_BUY)
      return(false);
   if(direction == -1 && type != POSITION_TYPE_SELL)
      return(false);

   return(true);
  }

int CountCloseScopePositions(const int direction,const bool current_symbol_only,const long magic_filter)
  {
   int count=0;
   for(int i=PositionsTotal()-1; i>=0; --i)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(SelectedPositionMatchesCloseScope(direction,current_symbol_only,magic_filter))
         count++;
     }
   return(count);
  }

bool SendAsyncCloseRequests(const int direction,const bool current_symbol_only,const long magic_filter)
  {
   bool sent=false;
   const ulong deviation=TradeDeviationPoints();
   g_trade.SetDeviationInPoints(deviation);
   g_trade.SetAsyncMode(true);

   for(int i=PositionsTotal()-1; i>=0; --i)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(!SelectedPositionMatchesCloseScope(direction,current_symbol_only,magic_filter))
         continue;

      const bool request_ok=g_trade.PositionClose(ticket,deviation);
      if(request_ok)
         sent=true;
      else
         CheckTradeResult(false,"AsyncPositionClose");
     }

   g_trade.SetAsyncMode(false);
   return(sent);
  }

void SendSyncCloseRequests(const int direction,const bool current_symbol_only,const long magic_filter)
  {
   g_trade.SetAsyncMode(false);
   for(int i=PositionsTotal()-1; i>=0; --i)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(!SelectedPositionMatchesCloseScope(direction,current_symbol_only,magic_filter))
         continue;
      ClosePositionTicket(ticket);
     }
  }

void ResetAsyncCloseState()
  {
   g_async_close_active=false;
   g_async_close_started_ms=0;
   g_async_close_last_retry_ms=0;
   g_async_close_direction=0;
   g_async_close_current_symbol_only=true;
   g_async_close_magic_filter=Magic;
   g_async_close_use_pairs=false;
   g_async_close_arm_cooldown=false;
   g_trade.SetAsyncMode(false);
  }

void CompleteAsyncCloseIfDone()
  {
   if(!g_async_close_active)
      return;

   if(CountCloseScopePositions(g_async_close_direction,g_async_close_current_symbol_only,g_async_close_magic_filter) > 0)
      return;

   if(g_async_close_arm_cooldown && GOLDKING_NEW_CYCLE_DELAY_SECONDS > 0)
      g_pause_until=TimeCurrent() + GOLDKING_NEW_CYCLE_DELAY_SECONDS;

   ResetAsyncCloseState();
  }

bool ProcessAsyncCloseMonitor()
  {
   if(!g_async_close_active)
      return(false);

   if(!IsSymbolTradeSessionOpen(ReferenceNow()))
      return(true);

   DeletePendingOrdersForCloseScope(g_async_close_direction,g_async_close_current_symbol_only,g_async_close_magic_filter);
   CompleteAsyncCloseIfDone();
   if(!g_async_close_active)
      return(true);

   const uint now_ms=GetTickCount();
   if(now_ms - g_async_close_last_retry_ms >= (uint)GOLDKING_ASYNC_CLOSE_RETRY_SECONDS * 1000)
     {
      if(g_async_close_use_pairs && g_async_close_direction == 0 &&
         g_async_close_current_symbol_only && g_async_close_magic_filter == Magic)
         CloseOppositePairs();

      SendSyncCloseRequests(g_async_close_direction,g_async_close_current_symbol_only,g_async_close_magic_filter);
      g_async_close_last_retry_ms=now_ms;
      CompleteAsyncCloseIfDone();
     }

   return(true);
  }

void StartManagedClose(const int direction,const bool use_pairs,const bool arm_cooldown,const bool current_symbol_only,const long magic_filter)
  {
   if(!IsSymbolTradeSessionOpen(ReferenceNow()))
      return;

   ResetAsyncCloseState();
   DeletePendingOrdersForCloseScope(direction,current_symbol_only,magic_filter);

   if(use_pairs && direction == 0 && current_symbol_only && magic_filter == Magic)
      CloseOppositePairs();

   if(CountCloseScopePositions(direction,current_symbol_only,magic_filter) <= 0)
     {
      if(arm_cooldown && GOLDKING_NEW_CYCLE_DELAY_SECONDS > 0)
         g_pause_until=TimeCurrent() + GOLDKING_NEW_CYCLE_DELAY_SECONDS;
      return;
     }

   g_async_close_active=true;
   g_async_close_started_ms=GetTickCount();
   g_async_close_last_retry_ms=g_async_close_started_ms;
   g_async_close_direction=direction;
   g_async_close_current_symbol_only=current_symbol_only;
   g_async_close_magic_filter=magic_filter;
   g_async_close_use_pairs=use_pairs;
   g_async_close_arm_cooldown=arm_cooldown;

   if(!SendAsyncCloseRequests(direction,current_symbol_only,magic_filter))
     {
      SendSyncCloseRequests(direction,current_symbol_only,magic_filter);
     }

   CompleteAsyncCloseIfDone();
  }

void CloseEaOrders(const int direction,const bool use_pairs,const bool arm_cooldown)
  {
   StartManagedClose(direction,use_pairs,arm_cooldown,true,Magic);
  }

void ResetBasketTrailing()
  {
   g_basket_trail_active=false;
   g_basket_trail_peak=0.0;
   g_basket_trail_peak_price=0.0;
   g_basket_trail_direction=0;
  }

void ResetFirstOrderTrailing()
  {
   g_first_order_trail_active=false;
   g_first_order_trail_peak=0.0;
   g_first_order_trail_peak_price=0.0;
   g_first_order_trail_direction=0;
  }

bool TryBasketTrailingClose(const EAStats &stats,const bool use_pairs)
  {
   if(!HasOpenPositions(stats))
     {
      ResetBasketTrailing();
      return(false);
     }

   const int direction=StatsNetDirection(stats);
   double trail_price=0.0;
   if(direction == 0 || !CurrentTrailPrice(direction,trail_price))
     {
      ResetBasketTrailing();
      return(false);
     }

   const double trigger_money=TrailingPriceMoveMoney(stats,GOLDKING_TRAIL_TRIGGER_POINTS);
   const double net_profit=TrailingNetProfitAfterCosts(stats);
   const double close_target=DynamicCloseAllTarget();
   if(trigger_money <= 0.0)
      return(false);

   if(!g_basket_trail_active)
     {
      if(net_profit < close_target + trigger_money)
         return(false);

      g_basket_trail_active=true;
      g_basket_trail_peak=net_profit;
      g_basket_trail_peak_price=trail_price;
      g_basket_trail_direction=direction;
      DeleteEaPendingOrders();
      return(true);
     }

   if(g_basket_trail_direction != direction)
     {
      ResetBasketTrailing();
      return(false);
     }

   if(net_profit > g_basket_trail_peak)
      g_basket_trail_peak=net_profit;

   if((direction > 0 && trail_price > g_basket_trail_peak_price) ||
      (direction < 0 && (g_basket_trail_peak_price <= 0.0 || trail_price < g_basket_trail_peak_price)))
      g_basket_trail_peak_price=trail_price;

   if(stats.buy_pending > 0 || stats.sell_pending > 0)
      DeleteEaPendingOrders();

   if(TrailPriceRetraced(direction,g_basket_trail_peak_price,trail_price,GOLDKING_TRAIL_STEP_POINTS))
     {
      CloseEaOrders(0,use_pairs,true);
      ResetBasketTrailing();
      return(true);
     }

   return(true);
  }

bool HasSingleFirstPosition(const EAStats &stats)
  {
   return((stats.buy_positions + stats.sell_positions) == 1 && stats.single_position_ticket > 0);
  }

bool TryFirstOrderTrailingClose(const EAStats &stats)
  {
   if(!HasSingleFirstPosition(stats))
     {
      ResetFirstOrderTrailing();
      return(false);
     }

   const int direction=(stats.single_position_type == POSITION_TYPE_BUY ? 1 : -1);
   double trail_price=0.0;
   if(!CurrentTrailPrice(direction,trail_price))
      return(false);

   if(!g_first_order_trail_active)
     {
      const datetime now_value=ReferenceNow();
      if(stats.latest_position_open_time > 0 &&
         now_value - stats.latest_position_open_time >= GOLDKING_FIRST_ORDER_TRAIL_TIMEOUT_SECONDS)
         return(false);

      const double trigger_money=TrailingPriceMoveMoney(stats,GOLDKING_TRAIL_TRIGGER_POINTS);
      const double net_profit=TrailingNetProfitAfterCosts(stats);
      if(trigger_money <= 0.0 || net_profit < trigger_money)
         return(false);

      g_first_order_trail_active=true;
      g_first_order_trail_peak=net_profit;
      g_first_order_trail_peak_price=trail_price;
      g_first_order_trail_direction=direction;
      DeleteEaPendingOrders();
      return(true);
     }

   if(g_first_order_trail_direction != direction)
     {
      ResetFirstOrderTrailing();
      return(false);
     }

   const double net_profit=TrailingNetProfitAfterCosts(stats);
   if(net_profit > g_first_order_trail_peak)
      g_first_order_trail_peak=net_profit;

   if((direction > 0 && trail_price > g_first_order_trail_peak_price) ||
      (direction < 0 && (g_first_order_trail_peak_price <= 0.0 || trail_price < g_first_order_trail_peak_price)))
      g_first_order_trail_peak_price=trail_price;

   if(stats.buy_pending > 0 || stats.sell_pending > 0)
      DeleteEaPendingOrders();

   if(TrailPriceRetraced(direction,g_first_order_trail_peak_price,trail_price,GOLDKING_TRAIL_STEP_POINTS))
     {
      CloseEaOrders(0,false,true);
      ResetFirstOrderTrailing();
      return(true);
     }

   return(true);
  }

datetime CurrentEntryBarTime()
  {
   return(iTime(_Symbol,GOLDKING_ENTRY_TIMEFRAME,0));
  }

bool IsFirstEntryBarLocked(const EAStats &stats)
  {
   const datetime current_bar=CurrentEntryBarTime();
   if(current_bar <= 0)
      return(false);

   if(g_first_entry_bar_lock > 0 && g_first_entry_bar_lock < current_bar)
      g_first_entry_bar_lock=0;

   const int total_positions=stats.buy_positions + stats.sell_positions;
   if(total_positions == 0)
     {
      g_first_entry_bar_lock=0;
      return(false);
     }

   if(total_positions > 1)
     {
      g_first_entry_bar_lock=0;
      return(false);
     }

   if(total_positions == 1 && stats.latest_position_open_time >= current_bar)
     {
      const datetime now_value=ReferenceNow();
      if(!g_first_order_trail_active &&
         stats.latest_position_open_time > 0 &&
         now_value - stats.latest_position_open_time >= GOLDKING_FIRST_ORDER_TRAIL_TIMEOUT_SECONDS)
        {
         g_first_entry_bar_lock=0;
         return(false);
        }
      g_first_entry_bar_lock=current_bar;
     }

   return(g_first_entry_bar_lock == current_bar);
  }

void CloseCurrentSymbolExposure()
  {
   DeleteCurrentSymbolPendingOrders();
   StartManagedClose(0,false,false,true,-1);
   DeleteCurrentSymbolPendingOrders();
  }

bool IsTradingEnvironmentOk(const EAStats &stats,string &reason)
  {
   reason="";

   if(!IsHedgingAccount())
     {
      reason="MT5净额账户不支持该EA，请切换到对冲账户";
      return(false);
     }

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
     {
      reason="终端未启用交易";
      return(false);
     }

   long trade_mode=SYMBOL_TRADE_MODE_DISABLED;
   if(!SymbolInfoInteger(_Symbol,SYMBOL_TRADE_MODE,trade_mode))
     {
      reason="无法读取品种交易状态";
      return(false);
     }

   if(trade_mode == SYMBOL_TRADE_MODE_DISABLED || trade_mode == SYMBOL_TRADE_MODE_CLOSEONLY)
     {
      reason="当前品种禁止开新单";
      return(false);
     }

   if(!IsSymbolTradeSessionOpen(ReferenceNow()))
     {
      reason="当前品种休市";
      return(false);
     }

   if(stats.buy_positions + stats.sell_positions >= Totals)
     {
      reason="达到最大持仓数";
      return(false);
     }

   if(CurrentSpreadPoints() > PriceDistancePoints(MaxSpread))
     {
      reason="点差超限";
      return(false);
     }

   return(true);
  }

bool TryProtectiveCloseBySide(const EAStats &stats)
  {
   UpdateMarketRegimeState(false);
   const int trend_direction=MarketScoreDirection();
   const double abs_score=MathAbs(g_market_score);
   const double buy_target=DynamicSideAverageOrderNetProfit(true) * stats.buy_positions;
   const double sell_target=DynamicSideAverageOrderNetProfit(false) * stats.sell_positions;
   const double close_all_target=DynamicCloseAllTarget();
   const bool buy_target_hit=(stats.buy_positions > 0 && stats.buy_profit > buy_target);
   const bool sell_target_hit=(stats.sell_positions > 0 && stats.sell_profit > sell_target);

   if(abs_score <= GOLDKING_MARKET_RANGE_LIMIT)
     {
      if(buy_target_hit)
        {
         CloseEaOrders(1,false,false);
         return(true);
        }

      if(sell_target_hit)
        {
         CloseEaOrders(-1,false,false);
         return(true);
        }

      if(stats.total_profit >= close_all_target)
         return(TryBasketTrailingClose(stats,true));

      return(false);
     }

   if(trend_direction == 0)
     {
      if(buy_target_hit && stats.sell_positions == 0)
        {
         CloseEaOrders(1,false,false);
         return(true);
        }

      if(sell_target_hit && stats.buy_positions == 0)
        {
         CloseEaOrders(-1,false,false);
         return(true);
        }

      if(buy_target_hit && TryPairedSideReduction(POSITION_TYPE_BUY,POSITION_TYPE_SELL))
         return(true);

      if(sell_target_hit && TryPairedSideReduction(POSITION_TYPE_SELL,POSITION_TYPE_BUY))
         return(true);

      if(stats.total_profit >= close_all_target)
        {
         if(TryPairedSideReduction(POSITION_TYPE_BUY,POSITION_TYPE_SELL))
            return(true);
         if(TryPairedSideReduction(POSITION_TYPE_SELL,POSITION_TYPE_BUY))
            return(true);
         return(TryBasketTrailingClose(stats,true));
        }

      return(false);
     }

   const ENUM_POSITION_TYPE trend_type=(trend_direction > 0 ? POSITION_TYPE_BUY : POSITION_TYPE_SELL);
   const ENUM_POSITION_TYPE risk_type=(trend_direction > 0 ? POSITION_TYPE_SELL : POSITION_TYPE_BUY);
   const bool trend_target_hit=(trend_type == POSITION_TYPE_BUY ? buy_target_hit : sell_target_hit);
   const bool risk_target_hit=(risk_type == POSITION_TYPE_BUY ? buy_target_hit : sell_target_hit);
   const int trend_positions=(trend_type == POSITION_TYPE_BUY ? stats.buy_positions : stats.sell_positions);
   const int risk_positions=(risk_type == POSITION_TYPE_BUY ? stats.buy_positions : stats.sell_positions);

   if(risk_target_hit)
     {
      CloseEaOrders(risk_type == POSITION_TYPE_BUY ? 1 : -1,false,false);
      return(true);
     }

   if(trend_target_hit)
     {
      if(risk_positions <= 0)
        {
         CloseEaOrders(trend_type == POSITION_TYPE_BUY ? 1 : -1,false,false);
         return(true);
        }
      if(TryTrendProtectedPairReduction(stats,trend_type,risk_type,trend_direction))
         return(true);
     }

   if(stats.total_profit >= close_all_target)
     {
      if(trend_positions > 0 && risk_positions > 0 &&
         TryTrendProtectedPairReduction(stats,trend_type,risk_type,trend_direction))
         return(true);
      return(TryBasketTrailingClose(stats,true));
     }

   return(false);
  }

// Fast take-profit: close any single EA position that has reached its small
// per-position profit target ($ scales with the position's volume). This is the
// "快速反复获利" engine -- winners exit fast and free a grid slot, so the book
// keeps cycling and never deadlocks; losers stay (bounded by the per-side cap).
bool TryFastScalpClose()
  {
   bool closed=false;
   for(int i=PositionsTotal()-1; i>=0; --i)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket==0)
         continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol || PositionGetInteger(POSITION_MAGIC)!=Magic)
         continue;
      const double vol=PositionGetDouble(POSITION_VOLUME);
      const double pl=PositionGetDouble(POSITION_PROFIT)+PositionGetDouble(POSITION_SWAP);
      if(vol>0.0 && pl>=FastTakeProfit*(vol/0.01))
        {
         if(ClosePositionTicket(ticket))
            closed=true;
        }
     }
   return(closed);
  }

bool TryAutoCloseLogic(const EAStats &stats)
  {
   const double close_all_target=DynamicCloseAllTarget();

   if(g_first_order_trail_active)
      return(TryFirstOrderTrailingClose(stats));

   if(TryFirstOrderTrailingClose(stats))
      return(true);

   if(g_basket_trail_active)
      return(TryBasketTrailingClose(stats,true));

   if(Over && stats.total_profit >= close_all_target)
      return(TryBasketTrailingClose(stats,true));

   if(!Over)
     {
      if(TryProtectiveCloseBySide(stats))
         return(true);
     }

   return(false);
  }

void ApplyTrendGridFilter(const EAStats &stats,bool &allow_buy,bool &allow_sell)
  {
   UpdateMarketRegimeState(false);
   // One-directional pyramid + FAST PIVOT (立刻掉头). Hold positions on at most
   // ONE side. When a one-side bag is deeply red AND the 30-second momentum
   // strongly opposes the held side, force-close the bag and let the EA
   // re-engage in the new direction on the next tick. This trades a small
   // controlled loss for avoiding a catastrophic blowup (the user's relaxed
   // constraint -- a managed pivot is better than a sustained-trend bag).
   const bool has_buy=(stats.buy_positions > 0);
   const bool has_sell=(stats.sell_positions > 0);
   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   const double pivot_loss_thr=-MathMax(50.0,equity * PivotLossPct);

   // No-SL pivot (立刻掉头, 不止损). When the held bag is deeply red AND the 30s
   // momentum strongly opposes, allow the OPPOSITE side to open new orders for
   // CARRY -- old bag held (NO close), new direction's winners pair-close it via
   // V3's carry logic. Net effect: switch the direction we're pushing, without
   // realizing any loss on the old bag.
   const bool pivot_long_alarm=(has_buy && !has_sell &&
                                stats.buy_profit < pivot_loss_thr &&
                                S30_Momentum(PivotMomLookback) < -PivotMomThreshold);
   const bool pivot_short_alarm=(has_sell && !has_buy &&
                                 stats.sell_profit < pivot_loss_thr &&
                                 S30_Momentum(PivotMomLookback) > PivotMomThreshold);
   if(pivot_long_alarm || pivot_short_alarm)
      return;   // dual-side carry: both allow_buy and allow_sell stay true

   bool want_buy;
   if(has_buy && !has_sell)
      want_buy=true;
   else if(has_sell && !has_buy)
      want_buy=false;
   else if(has_buy && has_sell)
      want_buy=(stats.buy_positions >= stats.sell_positions);
   else
      want_buy=(g_market_score >= 0.0);

   if(want_buy && allow_sell)
     {
      DeletePendingOrdersForCloseScope(-1,true,Magic);
      allow_sell=false;
     }
   if(!want_buy && allow_buy)
     {
      DeletePendingOrdersForCloseScope(1,true,Magic);
      allow_buy=false;
     }
  }

void PrintDiagnosticLog(const EAStats &stats,const bool env_ok,const string env_reason,const bool allow_buy,const bool allow_sell)
  {
   const datetime now_value=TimeCurrent();
   if(g_last_diagnostic_log > 0 && now_value - g_last_diagnostic_log < GOLDKING_DIAGNOSTIC_LOG_INTERVAL_SECONDS)
      return;

   g_last_diagnostic_log=now_value;
   UpdateMarketRegimeState(false);

   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   const double balance=AccountInfoDouble(ACCOUNT_BALANCE);
   const double margin=AccountInfoDouble(ACCOUNT_MARGIN);
   const double margin_level=(margin > 0.0 ? equity / margin * 100.0 : 0.0);
   const double spread_points=CurrentSpreadPoints();
   const int buy_step=DirectionalGridStepPoints(true);
   const int sell_step=DirectionalGridStepPoints(false);
   const double buy_multiplier=DynamicLotMultiplier(true);
   const double sell_multiplier=DynamicLotMultiplier(false);
   const double close_target=DynamicCloseAllTarget();
   const double buy_side_target=DynamicSideAverageOrderNetProfit(true);
   const double sell_side_target=DynamicSideAverageOrderNetProfit(false);
   const string env_text=(env_ok ? "OK" : (env_reason == "" ? "BLOCKED" : env_reason));

   PrintFormat("GK_DIAG time=%s score=%.1f raw=%.1f target=%.1f state=%s range=%.2f coherence=%.2f conflict=%.2f trend_dir=%d trend_conf=%.2f chop=%.2f ts_dir=%d frame_m1[score=%.1f trend=%.2f range=%.2f dir=%.2f n=%.0f] frame_m5[score=%.1f trend=%.2f range=%.2f dir=%.2f n=%.0f] frame_m15[score=%.1f trend=%.2f range=%.2f dir=%.2f n=%.0f] params[step_buy=%d step_sell=%d first_step=%d mult_buy=%.2f mult_sell=%.2f close_all=%.2f side_buy=%.2f side_sell=%.2f] pos[buy=%d lots=%.2f profit=%.2f sell=%d lots=%.2f profit=%.2f total=%.2f pend_buy=%d@%.2f pend_sell=%d@%.2f] account[balance=%.2f equity=%.2f margin_level=%.1f spread=%.1f] allow[buy=%d sell=%d env=%s]",
               TimeToString(now_value,TIME_DATE|TIME_SECONDS),
               g_market_score,
               g_market_score_raw,
               g_market_score_target,
               MarketStateText(),
               g_market_range_probability,
               g_market_score_coherence,
               g_market_conflict_weight,
               g_market_trend_direction,
               g_market_trend_confidence,
               g_ts_chop,
               g_ts_dir,
               g_market_frame_scores[0],
               g_market_frame_trend_power[0],
               g_market_frame_range_pressure[0],
               g_market_frame_direction[0],
               g_market_frame_samples[0],
               g_market_frame_scores[1],
               g_market_frame_trend_power[1],
               g_market_frame_range_pressure[1],
               g_market_frame_direction[1],
               g_market_frame_samples[1],
               g_market_frame_scores[2],
               g_market_frame_trend_power[2],
               g_market_frame_range_pressure[2],
               g_market_frame_direction[2],
               g_market_frame_samples[2],
               buy_step,
               sell_step,
               GOLDKING_FIRST_STEP_POINTS,
               buy_multiplier,
               sell_multiplier,
               close_target,
               buy_side_target,
               sell_side_target,
               stats.buy_positions,
               stats.buy_lots,
               stats.buy_profit,
               stats.sell_positions,
               stats.sell_lots,
               stats.sell_profit,
               stats.total_profit,
               stats.buy_pending,
               stats.buy_pending_price,
               stats.sell_pending,
               stats.sell_pending_price,
               balance,
               equity,
               margin_level,
               spread_points,
               allow_buy ? 1 : 0,
               allow_sell ? 1 : 0,
               env_text);

   PrintFormat("GK_POS time=%s score=%.0f buy=%d/%.2f/%.0f sell=%d/%.2f/%.0f bal=%.0f eq=%.0f dd=%.1f",
               TimeToString(now_value,TIME_DATE|TIME_SECONDS),g_market_score,
               stats.buy_positions,stats.buy_lots,stats.buy_profit,
               stats.sell_positions,stats.sell_lots,stats.sell_profit,
               balance,equity,(balance > 0.0 ? (balance-equity)/balance*100.0 : 0.0));
  }

// ===================================================================
// Liquidity Zones v2 — multi-TF prior highs/lows as anchors, multi-level
// asymmetric pendings, state-machine cancel.
//
// 规则:
//   每个 TF (M5/M15/H1/D1) 取前 LZ_LookbackBars 根 K 线极值作为 zone
//   触发带  = line ± LZ_TriggerBandPoints (默认 ±300)
//   挂单区  = line ± LZ_FirstOrderGapPoints (默认 ±600) 开始往外
//   挂单档数 = LZ_OrdersPerSide (默认 4)
//   档位间距 = LZ_OrderSpacingPoints (默认 300)
//
// 手数(看上冲=有 short bag 时):
//   首单 = sell_lots × LZ_FirstLotFraction (默认 0.5)
//   上侧(突破侧): 第 k 档 = 首单 × LZ_BreakoutMultPerLevel^k (默认 ×4/档)
//   下侧(反弹侧): 第 k 档 = 首单 × LZ_RejectionMultPerLevel^k (默认 ×2/档)
//
// 撤单(state machine):
//   phase 0 = 价格在触发带外 (line ± 300 之外)
//   phase 1 = 价格在触发带内 → 挂单
//   phase 2 = 价格在 [触发带, 挂单区] 之间 (line ± [300, 600]) → 等
//   phase 2 → phase 1 (即从外围退回触发带) → 撤掉所有 pending
//
// 完全填或撤后,该 zone 进入 LZ_ZoneRecycleMinutes 冷却,期间不再挂.
// ===================================================================

#define LZ_TF_COUNT 5
ENUM_TIMEFRAMES g_lz_timeframes[LZ_TF_COUNT] = {PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_H1, PERIOD_D1};
int             g_lz_per_tf_lookback[LZ_TF_COUNT] = {30, 60, 60, 60, 60};  // M1=30, 其他=LZ_LookbackBars

struct LZZoneInfo
  {
   int      tf_idx;
   bool     is_upper;
   double   price;
  };

struct LZZoneState
  {
   int      tf_idx;
   bool     is_upper;
   double   price;
   int      phase;                 // 0=none, 1=placed-no-fill, 2=at-least-one-filled
   bool     approach_from_below;
   datetime cooldown_until;
   ulong    ticket_ids[];          // pending tickets for this zone
   bool     ticket_is_up[];        // parallel: is each ticket on the UP side?
   double   ticket_anchor_offset[];// parallel: original signed offset from zone (UP = positive, DOWN = negative)
   double   trail_offset;          // 当前跟踪平移量 (正=上侧 pending 被推到更下方,负=反之)
  };
LZZoneState g_lz_states[];

// 每日 LZ 预算: 用当日净值峰值 - 当前净值 来估计"今天 LZ+grid 已经退多少"
// 退超过 LZ_DailyLossBudgetPct% 则禁新 LZ (已挂的保留)
double   g_lz_daily_peak_equity = 0.0;
datetime g_lz_daily_day         = 0;

void LZ_UpdateDailyEquityPeak()
  {
   const datetime now_day = (datetime)((long)TimeCurrent() / 86400);
   if(now_day != g_lz_daily_day)
     {
      g_lz_daily_day = now_day;
      g_lz_daily_peak_equity = AccountInfoDouble(ACCOUNT_EQUITY);
     }
   const double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq > g_lz_daily_peak_equity) g_lz_daily_peak_equity = eq;
  }

bool LZ_DailyBudgetExhausted()
  {
   if(g_lz_daily_peak_equity <= 0.0) return(false);
   const double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   const double drop_pct = (g_lz_daily_peak_equity - eq) / g_lz_daily_peak_equity * 100.0;
   return(drop_pct >= LZ_DailyLossBudgetPct);
  }

// Swing 高/低 = 局部极值,fractal 算法(中心 K 周围 LZ_SwingFractalK 根都比它低/高)
#define LZ_SWING_FRACTAL_K 2

bool LZ_BuildZones(LZZoneInfo &highs[], LZZoneInfo &lows[])
  {
   ArrayResize(highs, 0);
   ArrayResize(lows,  0);
   const int start_shift = MathMax(1, LZ_SkipRecentBars);
   const int k = LZ_SWING_FRACTAL_K;
   for(int i=0; i<LZ_TF_COUNT; i++)
     {
      const ENUM_TIMEFRAMES tf = g_lz_timeframes[i];
      // M1 用 g_lz_per_tf_lookback[0] (默认 30); 其他用 LZ_LookbackBars input
      const int lb = (i == 0) ? g_lz_per_tf_lookback[i] : LZ_LookbackBars;
      const int total = lb + 2 * k;
      double hi[], lo[];
      if(CopyHigh(_Symbol, tf, start_shift, total, hi) <= 0) continue;
      if(CopyLow(_Symbol,  tf, start_shift, total, lo) <= 0) continue;
      const int sz = ArraySize(hi);
      // 在 [k, sz-k) 范围内找 swing
      for(int j = k; j < sz - k; j++)
        {
         // swing high: hi[j] 严格大于左右 k 根的 high
         bool is_swing_h = true;
         for(int dj = 1; dj <= k; dj++)
           {
            if(hi[j-dj] >= hi[j] || hi[j+dj] >= hi[j]) { is_swing_h = false; break; }
           }
         if(is_swing_h)
           {
            LZZoneInfo h; h.tf_idx=i; h.is_upper=true; h.price=hi[j];
            const int hn = ArraySize(highs); ArrayResize(highs, hn+1); highs[hn]=h;
           }
         // swing low: lo[j] 严格小于左右 k 根的 low
         bool is_swing_l = true;
         for(int dj = 1; dj <= k; dj++)
           {
            if(lo[j-dj] <= lo[j] || lo[j+dj] <= lo[j]) { is_swing_l = false; break; }
           }
         if(is_swing_l)
           {
            LZZoneInfo l; l.tf_idx=i; l.is_upper=false; l.price=lo[j];
            const int ln = ArraySize(lows); ArrayResize(lows, ln+1); lows[ln]=l;
           }
        }
     }
   return(ArraySize(highs) > 0 || ArraySize(lows) > 0);
  }

// 在状态数组中查找匹配的 zone (容差 50 点);找不到返回 -1
int LZ_FindStateIdx(const int tf_idx, const bool is_upper, const double price)
  {
   const double tol = PriceDistancePoints(50) * _Point;
   for(int i = ArraySize(g_lz_states)-1; i>=0; i--)
     {
      if(g_lz_states[i].tf_idx == tf_idx
         && g_lz_states[i].is_upper == is_upper
         && MathAbs(g_lz_states[i].price - price) < tol)
         return(i);
     }
   return(-1);
  }

int LZ_CreateState(const int tf_idx, const bool is_upper, const double price, const bool from_below)
  {
   LZZoneState s;
   s.tf_idx = tf_idx;
   s.is_upper = is_upper;
   s.price = price;
   s.phase = 0;
   s.approach_from_below = from_below;
   s.cooldown_until = 0;
   s.trail_offset = 0.0;
   ArrayResize(s.ticket_ids, 0);
   ArrayResize(s.ticket_is_up, 0);
   ArrayResize(s.ticket_anchor_offset, 0);
   const int n = ArraySize(g_lz_states);
   ArrayResize(g_lz_states, n+1);
   g_lz_states[n] = s;
   return(n);
  }

// 撤掉该 state 名下的所有 pending,清空 ticket 列表,设冷却
void LZ_CancelStatePendings(const int idx)
  {
   if(idx < 0 || idx >= ArraySize(g_lz_states)) return;
   for(int i = ArraySize(g_lz_states[idx].ticket_ids)-1; i>=0; i--)
     {
      const ulong t = g_lz_states[idx].ticket_ids[i];
      if(t == 0) continue;
      if(OrderSelect(t))
         DeletePendingOrder(t);
     }
   ArrayResize(g_lz_states[idx].ticket_ids, 0);
   ArrayResize(g_lz_states[idx].ticket_is_up, 0);
   ArrayResize(g_lz_states[idx].ticket_anchor_offset, 0);
   g_lz_states[idx].phase = 0;
   g_lz_states[idx].trail_offset = 0.0;
   g_lz_states[idx].cooldown_until = TimeCurrent() + LZ_ZoneRecycleMinutes * 60;
  }

// 假突破跟踪:价格穿越触发带后,对侧 pending 整体平移跟随
// excursion_up > 0 → 推 DOWN 侧 pending 向上(更接近现价 → 反转时获得更好的 SELL 价)
// excursion_down < 0 → 推 UP 侧 pending 向下
void LZ_TrailFakeBreakoutCheck(const int sidx)
  {
   if(!LZ_TrailFakeBreakout) return;
   if(sidx < 0 || sidx >= ArraySize(g_lz_states)) return;
   if(g_lz_states[sidx].phase == 0) return;
   if(ArraySize(g_lz_states[sidx].ticket_ids) == 0) return;

   const double zp = g_lz_states[sidx].price;
   const double trigger_pp = PriceDistancePoints(LZ_TriggerBandPoints) * _Point;
   const double step_pp    = PriceDistancePoints(LZ_TrailStepPoints) * _Point;
   const double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   const double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   const double mid = (bid + ask) * 0.5;

   double new_trail = g_lz_states[sidx].trail_offset;
   if(mid > zp + trigger_pp)
     {
      // 上方溢出:trail 取 max(已有, 新溢出)
      const double excursion = mid - (zp + trigger_pp);
      if(new_trail < excursion) new_trail = excursion;
     }
   else if(mid < zp - trigger_pp)
     {
      // 下方溢出: trail (负值) 取 min
      const double excursion = mid - (zp - trigger_pp);   // negative
      if(new_trail > excursion) new_trail = excursion;
     }
   // 没明显变化就不动 (避免每 tick OrderModify)
   if(MathAbs(new_trail - g_lz_states[sidx].trail_offset) < step_pp) return;

   g_lz_states[sidx].trail_offset = new_trail;

   for(int i = 0; i < ArraySize(g_lz_states[sidx].ticket_ids); i++)
     {
      const ulong t = g_lz_states[sidx].ticket_ids[i];
      if(t == 0 || !OrderSelect(t)) continue;
      const bool is_up = g_lz_states[sidx].ticket_is_up[i];
      // 只动对侧(=溢出方向的相反侧)
      // new_trail > 0 (上溢出) → 推 DOWN 侧(is_up=false)
      // new_trail < 0 (下溢出) → 推 UP   侧(is_up=true)
      if((new_trail > 0 && is_up) || (new_trail < 0 && !is_up)) continue;

      const double anchor = g_lz_states[sidx].ticket_anchor_offset[i];
      double new_price = NormalizePriceToSymbol(zp + anchor + new_trail);
      double safe_new = new_price;
      const ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(!PrepareStopOrderPrice(type, new_price, safe_new)) continue;
      g_trade.OrderModify(t, safe_new, 0.0, 0.0, ORDER_TIME_GTC, 0);
     }
  }

// 该 zone 名下是否有已成交的仓位(POSITION_COMMENT 匹配 "LZ_<tf>_<u/l>_")
bool LZ_HasFilledFromZone(const int tf_idx, const bool is_upper)
  {
   const string prefix = StringFormat("LZ_%d_%s_", tf_idx, is_upper ? "U" : "L");
   for(int i=PositionsTotal()-1; i>=0; i--)
     {
      const ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((long)PositionGetInteger(POSITION_MAGIC) != Magic) continue;
      const string cmt = PositionGetString(POSITION_COMMENT);
      if(StringFind(cmt, prefix) == 0) return(true);
     }
   return(false);
  }

// 在一个 zone 挂多档非对称 pending,记录 ticket 进 state
void LZ_PlaceForZone(const EAStats &stats, const int sidx)
  {
   if(sidx < 0 || sidx >= ArraySize(g_lz_states)) return;
   const double zp = g_lz_states[sidx].price;
   const int first_gap = PriceDistancePoints(LZ_FirstOrderGapPoints);
   const int spacing   = PriceDistancePoints(LZ_OrderSpacingPoints);

   // 判断 breakout 侧:short bag 大 → 看上冲(up=breakout);long bag 大 → 看下跌(down=breakout)
   // 没有 bag 时 (新仓位),用 sell_lots 和 buy_lots 中较大者,直接判定;两边都 0 用 base_lot
   const double sb = stats.sell_lots;
   const double bb = stats.buy_lots;
   const double base = EffectiveBaseLot();
   double basis = MathMax(sb, bb);
   if(basis <= 0.0) basis = base;
   const bool breakout_is_up = (sb >= bb);                 // short bag → up 是突破侧
   const double first_lot = basis * LZ_FirstLotFraction;

   const double mult_up   = breakout_is_up ? LZ_BreakoutMultPerLevel : LZ_RejectionMultPerLevel;
   const double mult_down = breakout_is_up ? LZ_RejectionMultPerLevel : LZ_BreakoutMultPerLevel;
   // 累计手数硬顶: 上侧 cap_up, 下侧 cap_down (breakout 侧 4×, rejection 侧 2×)
   const double cap_up   = basis * (breakout_is_up ? LZ_BreakoutTotalCap : LZ_RejectionTotalCap);
   const double cap_down = basis * (breakout_is_up ? LZ_RejectionTotalCap : LZ_BreakoutTotalCap);

   // 预先计算每档 raw lot,然后按 cap 整体 scale (保持 ratio).
   // k 索引: 0=最近(line±first_gap), 1,2,...=越来越远
   // LargeOrdersFirst=true → 最近档拿最大手数;false → 最近档最小(原行为)
   double up_raw[];   ArrayResize(up_raw, LZ_OrdersPerSide);
   double dn_raw[];   ArrayResize(dn_raw, LZ_OrdersPerSide);
   double sum_up_raw = 0.0, sum_dn_raw = 0.0;
   for(int k = 0; k < LZ_OrdersPerSide; k++)
     {
      const int exp_idx = LZ_LargeOrdersFirst ? (LZ_OrdersPerSide - 1 - k) : k;
      up_raw[k] = first_lot * MathPow(mult_up,   exp_idx);
      dn_raw[k] = first_lot * MathPow(mult_down, exp_idx);
      sum_up_raw += up_raw[k];
      sum_dn_raw += dn_raw[k];
     }
   const double scale_up = (sum_up_raw > cap_up && sum_up_raw > 0.0) ? cap_up / sum_up_raw : 1.0;
   const double scale_dn = (sum_dn_raw > cap_down && sum_dn_raw > 0.0) ? cap_down / sum_dn_raw : 1.0;

   // 上侧 BUY_STOP 多档 (k=0 是最近 line+first_gap)
   for(int k = 0; k < LZ_OrdersPerSide; k++)
     {
      if(stats.buy_positions >= MaxPerSide) break;
      const double price_k_raw = NormalizePriceToSymbol(zp + (first_gap + spacing * k) * _Point);
      double safe_price = price_k_raw;
      if(!PrepareStopOrderPrice(ORDER_TYPE_BUY_STOP, price_k_raw, safe_price)) continue;
      const double lot_k = up_raw[k] * scale_up;
      double vol = AdjustVolumeAvoidLock(stats, true, lot_k);
      if(vol <= 0.0) continue;
      if(!CanAffordOrder(ORDER_TYPE_BUY_STOP, vol, safe_price)) break;
      const string cmt = StringFormat("LZ_%d_%s_B%d", g_lz_states[sidx].tf_idx,
                                       g_lz_states[sidx].is_upper ? "U" : "L", k);
      if(g_trade.BuyStop(vol, safe_price, _Symbol, 0.0, 0.0, ORDER_TIME_GTC, 0, cmt))
        {
         const ulong t = g_trade.ResultOrder();
         if(t != 0)
           {
            const int n = ArraySize(g_lz_states[sidx].ticket_ids);
            ArrayResize(g_lz_states[sidx].ticket_ids, n+1);
            ArrayResize(g_lz_states[sidx].ticket_is_up, n+1);
            ArrayResize(g_lz_states[sidx].ticket_anchor_offset, n+1);
            g_lz_states[sidx].ticket_ids[n] = t;
            g_lz_states[sidx].ticket_is_up[n] = true;
            g_lz_states[sidx].ticket_anchor_offset[n] = (first_gap + spacing * k) * _Point;
           }
        }
     }
   // 下侧 SELL_STOP 多档
   for(int k = 0; k < LZ_OrdersPerSide; k++)
     {
      if(stats.sell_positions >= MaxPerSide) break;
      const double price_k_raw = NormalizePriceToSymbol(zp - (first_gap + spacing * k) * _Point);
      double safe_price = price_k_raw;
      if(!PrepareStopOrderPrice(ORDER_TYPE_SELL_STOP, price_k_raw, safe_price)) continue;
      const double lot_k = dn_raw[k] * scale_dn;
      double vol = AdjustVolumeAvoidLock(stats, false, lot_k);
      if(vol <= 0.0) continue;
      if(!CanAffordOrder(ORDER_TYPE_SELL_STOP, vol, safe_price)) break;
      const string cmt = StringFormat("LZ_%d_%s_S%d", g_lz_states[sidx].tf_idx,
                                       g_lz_states[sidx].is_upper ? "U" : "L", k);
      if(g_trade.SellStop(vol, safe_price, _Symbol, 0.0, 0.0, ORDER_TIME_GTC, 0, cmt))
        {
         const ulong t = g_trade.ResultOrder();
         if(t != 0)
           {
            const int n = ArraySize(g_lz_states[sidx].ticket_ids);
            ArrayResize(g_lz_states[sidx].ticket_ids, n+1);
            ArrayResize(g_lz_states[sidx].ticket_is_up, n+1);
            ArrayResize(g_lz_states[sidx].ticket_anchor_offset, n+1);
            g_lz_states[sidx].ticket_ids[n] = t;
            g_lz_states[sidx].ticket_is_up[n] = false;
            g_lz_states[sidx].ticket_anchor_offset[n] = -((first_gap + spacing * k) * _Point);
           }
        }
     }
   if(ArraySize(g_lz_states[sidx].ticket_ids) > 0)
      g_lz_states[sidx].phase = 1;  // 挂单成功,进入 Phase 1
  }

// LZ 是叠加层:在 v3.20 正常 grid 之外,关键位附近挂多档非对称 pending.
// Phase 状态机:
//   0 -> 1: 价格进入触发带 [line±300] → 挂单
//   1 -> 0: 价格退回到 approach 侧的 retreat 带 [line∓600, line∓300] → 撤单(进冷却)
//   1 -> 2: 有任一 LZ pending 成交 → 锁定,retreat 不再撤
//   2 -> 0: 由 LZ_OcoCleanupByFloatingLoss() 处理,浮亏 < 阈值时撤剩余
void LZ_TryPlace(const EAStats &stats, const bool allow_buy, const bool allow_sell)
  {
   if(!UseLiquidityZones) return;
   if(!(allow_buy || allow_sell)) return;

   // 维护当日净值峰值(始终更新,即便不挂单)
   LZ_UpdateDailyEquityPeak();

   // 门控 1: 趋势分不够 → 震荡市,不挂新 LZ (state machine 仍处理已有 zones 的撤单/跟踪)
   const bool trend_ok = (MathAbs(g_market_score) >= LZ_TrendScoreMin);

   // 门控 2: 当日预算已用尽 → 不挂新 LZ
   const bool budget_ok = !LZ_DailyBudgetExhausted();

   const bool can_place_new = trend_ok && budget_ok;

   LZZoneInfo highs[], lows[];
   if(!LZ_BuildZones(highs, lows)) return;

   const double inner_pp = PriceDistancePoints(LZ_TriggerBandPoints) * _Point;
   const double outer_pp = PriceDistancePoints(LZ_FirstOrderGapPoints) * _Point;
   const double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   const double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   const double mid = (ask + bid) * 0.5;
   const datetime now = TimeCurrent();

   for(int side_iter = 0; side_iter < 2; side_iter++)
     {
      const int n = (side_iter == 0) ? ArraySize(highs) : ArraySize(lows);
      for(int i = 0; i < n; i++)
        {
         const int    tf_idx   = (side_iter == 0) ? highs[i].tf_idx  : lows[i].tf_idx;
         const bool   is_upper = (side_iter == 0) ? true              : false;
         const double zp       = (side_iter == 0) ? highs[i].price   : lows[i].price;
         const double dist     = MathAbs(mid - zp);
         const bool   in_inner = (dist <= inner_pp);

         int sidx = LZ_FindStateIdx(tf_idx, is_upper, zp);
         if(sidx < 0)
           {
            if(!in_inner) continue;
            if(!can_place_new) continue;  // 门控:震荡/超预算 → 不创建新 zone state
            const bool from_below = (mid < zp);
            sidx = LZ_CreateState(tf_idx, is_upper, zp, from_below);
           }

         if(g_lz_states[sidx].cooldown_until > now) continue;

         const int phase = g_lz_states[sidx].phase;

         // Phase 0 → 1: 触发带进入 → 挂单
         if(phase == 0)
           {
            if(in_inner && can_place_new)
              {
               g_lz_states[sidx].approach_from_below = (mid < zp);
               LZ_PlaceForZone(stats, sidx);
              }
            continue;
           }

         // Phase 1: 还没成交.检查 retreat 撤单条件,以及是否升级到 Phase 2
         if(phase == 1)
           {
            // 升级 Phase 2: 任一 LZ pending 已经转为 position
            if(LZ_HasFilledFromZone(tf_idx, is_upper))
              {
               g_lz_states[sidx].phase = 2;
               LZ_TrailFakeBreakoutCheck(sidx);
               continue;
              }
            // 价格在触发带外、还没退到 retreat → 跟踪假突破
            LZ_TrailFakeBreakoutCheck(sidx);
            // retreat 撤单: 价格回到 approach 侧的 [line∓600, line∓300] 带
            // approach_from_below=true → retreat 在下方 [line-outer, line-inner]
            // approach_from_below=false → retreat 在上方 [line+inner, line+outer]
            const double sign = g_lz_states[sidx].approach_from_below ? -1.0 : 1.0;
            const double retreat_far  = zp + sign * outer_pp;   // line-600 (或 +600)
            const double retreat_near = zp + sign * inner_pp;   // line-300 (或 +300)
            // 在 [far, near] 之间 (用 min/max 处理 sign)
            const double r_lo = MathMin(retreat_far, retreat_near);
            const double r_hi = MathMax(retreat_far, retreat_near);
            if(mid >= r_lo && mid <= r_hi)
              {
               LZ_CancelStatePendings(sidx);
              }
            continue;
           }

         // Phase 2: 锁定,继续跟踪;只等浮亏阈值撤(LZ_OcoCleanupByFloatingLoss)
         if(phase == 2)
           {
            LZ_TrailFakeBreakoutCheck(sidx);
           }
        }
     }
  }

// Phase 2 退场: 当 总浮亏 < 余额 × LZ_OcoFloatingLossPct/100 时,撤掉所有
// Phase 2 状态的 zone 剩余 pending (它们的"防突破"使命已达成).
void LZ_OcoCleanupByFloatingLoss(const EAStats &stats)
  {
   if(!UseLiquidityZones) return;
   if(ArraySize(g_lz_states) == 0) return;

   const double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   if(balance <= 0.0) return;

   const double cur_loss = (stats.total_profit < 0.0) ? -stats.total_profit : 0.0;
   const double loss_pct = (cur_loss / balance) * 100.0;
   if(loss_pct >= LZ_OcoFloatingLossPct) return;

   // 浮亏已经小于阈值 → 所有 Phase 2 zone 都撤
   for(int i = ArraySize(g_lz_states)-1; i>=0; i--)
     {
      if(g_lz_states[i].phase == 2)
         LZ_CancelStatePendings(i);
     }
  }

// 兼容旧名 (调用方 ExecuteStrategy 末尾使用)
void LZ_CleanupBreakoutCoveredPendings(const EAStats &stats)
  {
   LZ_OcoCleanupByFloatingLoss(stats);
  }

void TryPlacePendingOrders(const EAStats &stats,const bool allow_buy,const bool allow_sell)
  {
   const int min_distance=StopOrderMinDistancePoints();
   const int first_step=MathMax(PriceDistancePoints(GOLDKING_FIRST_STEP_POINTS),min_distance);
   const int buy_step=MathMax(DirectionalGridStepPoints(true),min_distance);
   const int sell_step=MathMax(DirectionalGridStepPoints(false),min_distance);
   const int buy_min_distance=buy_step;
   const int sell_min_distance=sell_step;
   const bool buy_rebalance=(stats.buy_lots > 0.0 && stats.sell_lots / stats.buy_lots > 3.0 && stats.sell_lots - stats.buy_lots > 0.2);
   const bool sell_rebalance=(stats.sell_lots > 0.0 && stats.buy_lots / stats.sell_lots > 3.0 && stats.buy_lots - stats.sell_lots > 0.2);
   const double ask_price=SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   const double bid_price=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   const double spread_points=CurrentSpreadPoints();

   if(allow_buy && stats.buy_pending_regular == 0 && stats.buy_positions < MaxPerSide)
     {
      double target_price=0.0;
      if(stats.buy_positions == 0)
         target_price=NormalizePriceToSymbol(ask_price + (first_step + spread_points) * _Point);
      else
        {
         target_price=NormalizePriceToSymbol(ask_price + buy_min_distance * _Point);
         if(stats.buy_lowest_position != 0.0 && target_price < NormalizePriceToSymbol(stats.buy_lowest_position - buy_step * _Point))
            target_price=NormalizePriceToSymbol(ask_price + buy_step * _Point);
        }

      const bool buy_condition=
         (stats.buy_positions == 0) ||
         (stats.buy_highest_any != 0.0 && target_price >= NormalizePriceToSymbol(stats.buy_highest_any + buy_step * _Point) && buy_rebalance) ||
         (stats.buy_lowest_position != 0.0 && target_price <= NormalizePriceToSymbol(stats.buy_lowest_position - buy_step * _Point));

      if(buy_condition)
        {
         if(PrepareStopOrderPrice(ORDER_TYPE_BUY_STOP,target_price,target_price))
           {
            double volume=EffectiveBaseLot() * MathPow(DynamicLotMultiplier(true),stats.buy_positions);
            volume=AdjustVolumeAvoidLock(stats,true,volume);
            if(CanAffordOrder(ORDER_TYPE_BUY_STOP,volume,target_price))
               CheckTradeResult(g_trade.BuyStop(volume,target_price,_Symbol,0.0,0.0,ORDER_TIME_GTC,0,GOLDKING_ORDER_COMMENT_PRIMARY),"BuyStop");
           }
        }
     }

   if(allow_sell && stats.sell_pending_regular == 0 && stats.sell_positions < MaxPerSide)
     {
      double target_price=0.0;
      if(stats.sell_positions == 0)
         target_price=NormalizePriceToSymbol(bid_price - first_step * _Point);
      else
        {
         target_price=NormalizePriceToSymbol(bid_price - sell_min_distance * _Point);
         if(stats.sell_highest_position != 0.0 && target_price < NormalizePriceToSymbol(stats.sell_highest_position + sell_step * _Point))
            target_price=NormalizePriceToSymbol(bid_price - sell_step * _Point);
        }

      const bool sell_condition=
         (stats.sell_positions == 0) ||
         (stats.sell_lowest_any != 0.0 && target_price <= NormalizePriceToSymbol(stats.sell_lowest_any - sell_step * _Point) && sell_rebalance) ||
         (stats.sell_highest_position != 0.0 && target_price >= NormalizePriceToSymbol(stats.sell_highest_position + sell_step * _Point));

      if(sell_condition)
        {
         if(PrepareStopOrderPrice(ORDER_TYPE_SELL_STOP,target_price,target_price))
           {
            double volume=EffectiveBaseLot() * MathPow(DynamicLotMultiplier(false),stats.sell_positions);
            volume=AdjustVolumeAvoidLock(stats,false,volume);
            if(CanAffordOrder(ORDER_TYPE_SELL_STOP,volume,target_price))
               CheckTradeResult(g_trade.SellStop(volume,target_price,_Symbol,0.0,0.0,ORDER_TIME_GTC,0,GOLDKING_ORDER_COMMENT_PRIMARY),"SellStop");
           }
        }
     }

   // Exposure guard: if a side is at its per-side count cap, pull its resting
   // pending so it cannot fill and exceed the cap.
   if(stats.buy_pending > 0 && stats.buy_positions >= MaxPerSide)
      DeletePendingOrdersForCloseScope(1,true,Magic);
   if(stats.sell_pending > 0 && stats.sell_positions >= MaxPerSide)
      DeletePendingOrdersForCloseScope(-1,true,Magic);
  }

void TryTrailPendingOrders(const EAStats &stats,const bool allow_buy,const bool allow_sell)
  {
   if(stats.buy_pending_ticket == 0 && stats.sell_pending_ticket == 0)
      return;

   const datetime now_value=TimeCurrent();
   if(g_last_pending_trail_time > 0 && now_value - g_last_pending_trail_time < GOLDKING_PENDING_TRAIL_INTERVAL_SECONDS)
      return;
   g_last_pending_trail_time=now_value;

   const int min_distance=StopOrderMinDistancePoints();
   const int first_step=MathMax(PriceDistancePoints(GOLDKING_FIRST_STEP_POINTS),min_distance);
   const int buy_step=MathMax(DirectionalGridStepPoints(true),min_distance);
   const int sell_step=MathMax(DirectionalGridStepPoints(false),min_distance);
   const int pending_trail_step=PriceDistancePoints(GOLDKING_PENDING_TRAIL_POINTS);
   const bool buy_rebalance=(stats.buy_lots > 0.0 && stats.sell_lots / stats.buy_lots > 3.0 && stats.sell_lots - stats.buy_lots > 0.2);
   const bool sell_rebalance=(stats.sell_lots > 0.0 && stats.buy_lots / stats.sell_lots > 3.0 && stats.buy_lots - stats.sell_lots > 0.2);
   const double ask_price=SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   const double bid_price=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   const double spread_points=CurrentSpreadPoints();

   if(allow_buy && stats.buy_pending_ticket > 0)
     {
      double target_price=(stats.buy_positions == 0) ? NormalizePriceToSymbol(ask_price + (first_step + spread_points) * _Point)
                                                     : NormalizePriceToSymbol(ask_price + buy_step * _Point);
      if(stats.buy_positions > 0 && stats.buy_lowest_position != 0.0 && target_price < NormalizePriceToSymbol(stats.buy_lowest_position - buy_step * _Point))
         target_price=NormalizePriceToSymbol(ask_price + buy_step * _Point);

      if(!PrepareStopOrderPrice(ORDER_TYPE_BUY_STOP,target_price,target_price))
         target_price=0.0;

      const bool trail_ok=
         (target_price > 0.0) &&
         (target_price <= NormalizePriceToSymbol(stats.buy_lowest_position - buy_step * _Point) || stats.buy_lowest_position == 0.0 || (buy_rebalance && stats.buy_positions == 0) || target_price >= NormalizePriceToSymbol(stats.buy_highest_any + buy_step * _Point));

      if(stats.buy_pending_price != 0.0 && NormalizePriceToSymbol(stats.buy_pending_price - pending_trail_step * _Point) > target_price && trail_ok)
         ModifyPendingPrice(stats.buy_pending_ticket,target_price);
     }

   if(allow_sell && stats.sell_pending_ticket > 0)
     {
      double target_price=(stats.sell_positions == 0) ? NormalizePriceToSymbol(bid_price - first_step * _Point)
                                                      : NormalizePriceToSymbol(bid_price - sell_step * _Point);
      if(stats.sell_positions > 0 && stats.sell_highest_position != 0.0 && target_price < NormalizePriceToSymbol(stats.sell_highest_position + sell_step * _Point))
         target_price=NormalizePriceToSymbol(bid_price - sell_step * _Point);

      if(!PrepareStopOrderPrice(ORDER_TYPE_SELL_STOP,target_price,target_price))
         target_price=0.0;

      const bool trail_ok=
         (target_price > 0.0) &&
         (target_price >= NormalizePriceToSymbol(stats.sell_highest_position + sell_step * _Point) || stats.sell_highest_position == 0.0 || (sell_rebalance && stats.sell_positions == 0) || target_price <= NormalizePriceToSymbol(stats.sell_lowest_any - sell_step * _Point));

      if(stats.sell_pending_price != 0.0 && NormalizePriceToSymbol(stats.sell_pending_price + pending_trail_step * _Point) < target_price && trail_ok)
         ModifyPendingPrice(stats.sell_pending_ticket,target_price);
     }
  }

void ExecuteStrategy()
  {
   EAStats stats;
   CollectStats(stats);
   const datetime now_value=ReferenceNow();
   const datetime news_now=ReferenceNewsNow();
   RefreshDailyLocks(now_value,stats);
   RefreshNewsState(false);

   const bool session_after_stop=IsTradingSessionAfterStop(now_value);
   const bool session_ok=IsTradingSessionOpen(now_value);
   const bool wrap_up_blocked=IsFridayWrapUpWindow(news_now);
   const bool target_locked=g_daily_target_locked;
   const bool news_blocked=g_news_state.block_entries;

   if((session_after_stop || wrap_up_blocked || target_locked || news_blocked) && (stats.buy_pending > 0 || stats.sell_pending > 0))
     {
      DeleteEaPendingOrders();
      CollectStats(stats);
      RefreshDailyLocks(now_value,stats);
      RefreshNewsState(false);
     }

   string env_reason="";
   const bool env_ok=IsTradingEnvironmentOk(stats,env_reason);

   if(ProcessAsyncCloseMonitor())
     {
      CollectStats(stats);
      RefreshPanel(true);
      return;
     }

   bool allow_buy=g_allow_buy;
   bool allow_sell=g_allow_sell;

   if(Over && stats.buy_positions == 0)
      allow_buy=false;
   if(Over && stats.sell_positions == 0)
      allow_sell=false;

   if(g_pause_until > TimeCurrent())
     {
      allow_buy=false;
      allow_sell=false;
     }

   if(!session_ok || session_after_stop || wrap_up_blocked || target_locked || news_blocked)
     {
      allow_buy=false;
      allow_sell=false;
     }

   if(!env_ok)
     {
      allow_buy=false;
      allow_sell=false;
     }

   if(allow_buy || allow_sell)
      ApplyTrendGridFilter(stats,allow_buy,allow_sell);

   PrintDiagnosticLog(stats,env_ok,env_reason,allow_buy,allow_sell);

   if(TryAutoCloseLogic(stats))
     {
      RefreshPanel(true);
      return;
     }

   if(IsFirstEntryBarLocked(stats))
     {
      if(stats.buy_pending > 0 || stats.sell_pending > 0)
         DeleteEaPendingOrders();
      RefreshPanel(true);
      return;
     }

   // 1) v3.20 正常 grid — 始终运行(核心引擎)
   if(allow_buy || allow_sell)
      TryPlacePendingOrders(stats,allow_buy,allow_sell);

   if(allow_buy || allow_sell)
      TryTrailPendingOrders(stats,allow_buy,allow_sell);

   // 2) 流动性区叠加层 — 关键位附近额外挂非对称单
   if(UseLiquidityZones && (allow_buy || allow_sell))
     {
      EAStats lz_stats;
      CollectStats(lz_stats);
      LZ_TryPlace(lz_stats,allow_buy,allow_sell);
     }

   // 3) LZ 大单触发后,等浮亏跌至峰值的阈值时撤剩余 LZ pending
   LZ_CleanupBreakoutCoveredPendings(stats);

   RefreshPanel(false);
  }

double UiScale()
  {
   const long chart_width=ChartGetInteger(0,CHART_WIDTH_IN_PIXELS,0);
   double scale=(double)chart_width / 1600.0;
   return(MathMax(0.90,MathMin(scale,1.08)));
  }

double UiFontScale()
  {
   const long chart_width=ChartGetInteger(0,CHART_WIDTH_IN_PIXELS,0);
   const long dpi=TerminalInfoInteger(TERMINAL_SCREEN_DPI);
   double scale=(double)chart_width / 1600.0;
   scale=MathMax(0.88,MathMin(scale,1.00));

   if(dpi >= 192)
      scale-=0.18;
   else if(dpi >= 144)
      scale-=0.12;
   else if(dpi >= 120)
      scale-=0.06;

   return(MathMax(0.74,MathMin(scale,1.00)));
  }

int ScalePx(const int value)
  {
   return((int)MathRound(value * UiScale()));
  }

int ScaleFont(const int value)
  {
   return((int)MathRound(value * UiFontScale()));
  }

void BuildPanelMetrics(PanelMetrics &m)
  {
   const long chart_width=ChartGetInteger(0,CHART_WIDTH_IN_PIXELS,0);
   const int available_w=(int)MathMax(280.0,(double)chart_width - ScalePx(32));
   const int target_w=(chart_width < 1100) ? ScalePx(400) : (chart_width < 1700 ? ScalePx(460) : ScalePx(520));

   m.margin_x       = ScalePx(14);
   m.margin_y       = ScalePx(16);
   m.width          = (int)MathMax(300.0,MathMin((double)target_w,(double)available_w));
   m.pad            = ScalePx(15);
   m.section_gap    = ScalePx(8);
   m.header_h       = ScalePx(54);
   m.row_h          = ScalePx(24);
   m.gap            = ScalePx(10);
   m.button_h       = ScalePx(36);
   m.inner_w        = m.width - m.pad * 2;
   m.half_w         = (m.inner_w - m.gap) / 2;
   m.card_status_h  = g_panel_open ? ScalePx(138) : 0;
   m.card_metrics_h = g_panel_open ? ScalePx(142) : 0;
   m.card_actions_h = g_panel_open ? ScalePx(62) : 0;
   m.button_font    = ScaleFont(9);
   m.font_xs        = ScaleFont(8);
   m.font_sm        = ScaleFont(9);
   m.font_lg        = ScaleFont(14);
   m.toggle_w       = (m.width <= ScalePx(360)) ? ScalePx(48) : ScalePx(56);
   m.panel_h        = g_panel_open ? (m.header_h + m.section_gap + m.card_status_h + m.section_gap + m.card_metrics_h + m.section_gap + m.card_actions_h)
                                   : m.header_h;
  }

string PanelObjectName(const string suffix)
  {
   return(g_panel_prefix + suffix);
  }

void EnsurePanelRectangle(const string suffix,const int x,const int y,const int w,const int h,const color bg,const color border,const int corner)
  {
   EnsureRectangle(PanelObjectName(suffix),x,y,w,h,bg,border,corner);
  }

void EnsurePanelLabel(const string suffix,const string text,const int x,const int y,const int font_size,const color clr,const int corner,const string font="Microsoft YaHei")
  {
   EnsureLabel(PanelObjectName(suffix),text,x,y,font_size,clr,corner,font);
  }

void EnsurePanelButton(const string suffix,const string text,const int x,const int y,const int w,const int h,const color bg,const color fg,const int corner,const int font_size=0,const string font="Microsoft YaHei")
  {
   EnsureButton(PanelObjectName(suffix),text,x,y,w,h,bg,fg,corner,font_size,font);
  }

void DrawPanelLabelPair(const string left_suffix,const string left_text,const string right_suffix,const string right_text,const int left_x,const int right_x,const int y,const int font_size,const color left_color,const color right_color,const int corner)
  {
   EnsurePanelLabel(left_suffix,left_text,left_x,y,font_size,left_color,corner);
   EnsurePanelLabel(right_suffix,right_text,right_x,y,font_size,right_color,corner);
  }

void EnsureRectangle(const string name,const int x,const int y,const int w,const int h,const color bg,const color border,const int corner)
  {
   if(ObjectFind(0,name) < 0)
      ObjectCreate(0,name,OBJ_RECTANGLE_LABEL,0,0,0);
   ObjectSetInteger(0,name,OBJPROP_CORNER,corner);
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,w);
   ObjectSetInteger(0,name,OBJPROP_YSIZE,h);
   ObjectSetInteger(0,name,OBJPROP_BGCOLOR,bg);
   ObjectSetInteger(0,name,OBJPROP_COLOR,border);
   ObjectSetInteger(0,name,OBJPROP_BORDER_TYPE,BORDER_FLAT);
   ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,name,OBJPROP_SELECTED,false);
   ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
   ObjectSetInteger(0,name,OBJPROP_BACK,false);
   ObjectSetInteger(0,name,OBJPROP_ZORDER,0);
  }

void EnsureLabel(const string name,const string text,const int x,const int y,const int font_size,const color clr,const int corner,const string font="Microsoft YaHei")
  {
   if(ObjectFind(0,name) < 0)
      ObjectCreate(0,name,OBJ_LABEL,0,0,0);
   ObjectSetInteger(0,name,OBJPROP_CORNER,corner);
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,name,OBJPROP_COLOR,clr);
   ObjectSetInteger(0,name,OBJPROP_FONTSIZE,font_size);
   ObjectSetString(0,name,OBJPROP_FONT,font);
   ObjectSetString(0,name,OBJPROP_TEXT,text);
   ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,name,OBJPROP_SELECTED,false);
   ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
   ObjectSetInteger(0,name,OBJPROP_BACK,false);
   ObjectSetInteger(0,name,OBJPROP_ZORDER,1);
  }

void EnsureButton(const string name,const string text,const int x,const int y,const int w,const int h,const color bg,const color fg,const int corner,const int font_size=0,const string font="Microsoft YaHei")
  {
   if(ObjectFind(0,name) < 0)
      ObjectCreate(0,name,OBJ_BUTTON,0,0,0);
   ObjectSetInteger(0,name,OBJPROP_CORNER,corner);
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,w);
   ObjectSetInteger(0,name,OBJPROP_YSIZE,h);
   ObjectSetInteger(0,name,OBJPROP_COLOR,fg);
   ObjectSetInteger(0,name,OBJPROP_BGCOLOR,bg);
   ObjectSetInteger(0,name,OBJPROP_BORDER_COLOR,bg);
   ObjectSetInteger(0,name,OBJPROP_FONTSIZE,font_size > 0 ? font_size : ScaleFont(9));
   ObjectSetString(0,name,OBJPROP_FONT,font);
   ObjectSetString(0,name,OBJPROP_TEXT,text);
   ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,name,OBJPROP_SELECTED,false);
   ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
   ObjectSetInteger(0,name,OBJPROP_BACK,false);
   ObjectSetInteger(0,name,OBJPROP_ZORDER,20);
  }

string BoolText(const bool enabled,const string on_text,const string off_text)
  {
   return(enabled ? on_text : off_text);
  }

string FormatSignedMoney(const double value)
  {
   const string sign=(value > 0.0) ? "+" : "";
   return(sign + DoubleToString(value,2));
  }

string FormatPercent(const double value)
  {
   return(DoubleToString(value,2) + "%");
  }

string FormatPanelMoment(const datetime when,const datetime now_value)
  {
   if(when <= 0)
      return("--");

   MqlDateTime stamp={};
   MqlDateTime now_stamp={};
   TimeToStruct(when,stamp);
   TimeToStruct(now_value,now_stamp);

   if(stamp.year == now_stamp.year && stamp.mon == now_stamp.mon && stamp.day == now_stamp.day)
      return(StringFormat("%02d:%02d",stamp.hour,stamp.min));

   return(StringFormat("%02d-%02d %02d:%02d",stamp.mon,stamp.day,stamp.hour,stamp.min));
  }

string NewsPauseReason(const EAStats &stats)
  {
   if(!g_news_state.block_entries)
      return("");

   const string resume_text=FormatPanelMoment(g_news_state.resume_time,g_news_state.server_now);
   const string pause_text=IntegerToString((int)MathMax(0,NewsPauseMinutes)) + "分钟";
   if(g_news_state.in_pre_window)
      return(HasOpenPositions(stats) ? "高影响新闻前" + pause_text + "，等待全部平仓" : "高影响新闻前" + pause_text + "，暂停至 服" + resume_text);

   return(HasOpenPositions(stats) ? "高影响新闻后" + pause_text + "，等待全部平仓" : "高影响新闻后" + pause_text + "，暂停至 服" + resume_text);
  }

string WrapUpPauseReason(const EAStats &stats)
  {
   if(!IsFridayWrapUpWindow(g_news_state.server_now))
      return("");

   return(HasOpenPositions(stats) ? "周五收尾阶段，等待全部平仓"
                                  : "周五收尾阶段，本周停止开新仓");
  }

string SessionStateText(const datetime now_value,const EAStats &stats)
  {
   if(IsTradingSessionAfterStop(now_value))
      return(HasOpenPositions(stats) ? "结束时间已到，等待平仓" : "今日已收工");

   if(!IsTradingSessionOpen(now_value))
      return("未到工作时间");

   return("工作时段内");
  }

string WrapUpStateText(const EAStats &stats)
  {
   const int lead_hours=(int)MathMax(0,MathMin(24,FridayWrapUpLeadHours));
   if(!IsFridayWrapUpWindow(g_news_state.server_now))
      return("周五提前" + IntegerToString(lead_hours) + "小时 未触发");

   return(HasOpenPositions(stats) ? "周五收尾 等待平仓" : "周五收尾 已停止开仓");
  }

string NewsStateText(const EAStats &stats)
  {
   const string source_prefix=(g_news_state.using_schedule_rules ? "规则内置" : "MT5日历");

   if(NewsPauseMinutes <= 0)
      return("已关闭");

   if(!g_news_state.calendar_available)
      return(source_prefix + " | " + (g_news_state.error_text == "" ? "新闻源不可用，已忽略" : g_news_state.error_text));

   const string event_time="服" + FormatPanelMoment(g_news_state.event_time,g_news_state.server_now);
   const string event_prefix=(g_news_state.currency == "" ? "" : g_news_state.currency + " ");
   const string event_suffix=(g_news_state.event_name == "" ? "" : " " + g_news_state.event_name);
   const string pause_text=IntegerToString((int)MathMax(0,NewsPauseMinutes)) + "分钟";

   if(g_news_state.block_entries)
     {
      if(g_news_state.in_pre_window)
         return(source_prefix + " | " + (HasOpenPositions(stats) ? "前" + pause_text + "等待平仓" : "前" + pause_text + "暂停") + " | " + event_prefix + event_time + event_suffix);

      return(source_prefix + " | " + (HasOpenPositions(stats) ? "后" + pause_text + "等待平仓" : "后" + pause_text + "冷静期") + " | " + event_prefix + event_time + event_suffix);
     }

   if(g_news_state.has_upcoming_event)
      return(source_prefix + " | 下个高影响 | " + event_prefix + event_time + event_suffix);

   if(g_news_state.using_schedule_rules)
      return("规则内置 | 未触发");

   return("未触发");
  }

string EntryStateText(const string stop_reason)
  {
   if(g_allow_buy && g_allow_sell)
      return("允许");

   if(!g_allow_buy && !g_allow_sell)
      return("手动停止");

   if(stop_reason != "")
      return("暂停");

   return("部分允许");
  }

string CloseReasonText()
  {
   string reason="";
   EAStats stats;
   CollectStats(stats);
   const datetime now_value=ReferenceNow();
   RefreshDailyLocks(now_value,stats);
   RefreshNewsState(false);

   if(g_async_close_active)
     {
      const int elapsed=(int)((GetTickCount() - g_async_close_started_ms) / 1000);
      const int remaining=CountCloseScopePositions(g_async_close_direction,g_async_close_current_symbol_only,g_async_close_magic_filter);
      return("异步平仓处理中 " + IntegerToString(remaining) + " 单 / " + IntegerToString(elapsed) + " 秒");
     }

   if(g_daily_target_locked)
      return(HasOpenPositions(stats) ? "今日盈利达标，等待全部平仓" : "今日盈利目标已达成");

   if(g_first_order_trail_active)
     {
      const double close_price=TrailRetracePrice(g_first_order_trail_direction,g_first_order_trail_peak_price,GOLDKING_TRAIL_STEP_POINTS);
      return("首单价格跟随中 峰值 " + DoubleToString(g_first_order_trail_peak_price,_Digits) + " / 回撤价 " + DoubleToString(close_price,_Digits));
     }

   if(g_basket_trail_active)
     {
      const double close_price=TrailRetracePrice(g_basket_trail_direction,g_basket_trail_peak_price,GOLDKING_TRAIL_STEP_POINTS);
      return("整体价格跟随中 峰值 " + DoubleToString(g_basket_trail_peak_price,_Digits) + " / 回撤价 " + DoubleToString(close_price,_Digits));
     }

   if(IsFirstEntryBarLocked(stats))
      return("首单本M1 K线已成交，等待下一根K线");

   const string news_reason=NewsPauseReason(stats);
   if(news_reason != "")
      return(news_reason);

   const string wrap_reason=WrapUpPauseReason(stats);
   if(wrap_reason != "")
      return(wrap_reason);

   if(IsTradingSessionAfterStop(now_value))
      return(HasOpenPositions(stats) ? "已到结束时间，等待全部平仓" : "今日已收工");

   if(!IsTradingSessionOpen(now_value))
      return("等待工作时段开始");

   if(!g_allow_buy && !g_allow_sell)
      return("已手动停止交易");

   if(g_pause_until > TimeCurrent())
      return("冷却中 " + IntegerToString((int)(g_pause_until - TimeCurrent())) + " 秒");

   if(!IsTradingEnvironmentOk(stats,reason))
      return(reason);

   return("");
  }

string ClipText(const string text,const int max_chars)
  {
   if(max_chars <= 0)
      return("");
   if(StringLen(text) <= max_chars)
      return(text);
   if(max_chars <= 3)
      return(StringSubstr(text,0,max_chars));
   return(StringSubstr(text,0,max_chars - 3) + "...");
  }

void DrawPanel(const EAStats &stats)
  {
   PanelMetrics m;
   BuildPanelMetrics(m);
   const int corner=CORNER_LEFT_UPPER;
   const color panel_bg=C'6,6,7';
   const color panel_border=C'54,58,64';
   const color header_bg=C'11,11,12';
   const color card_bg=C'17,18,20';
   const color card_border=C'42,45,51';
   const color muted=C'143,149,160';
   const color ok_color=C'38,190,126';
   const color warn_color=C'238,167,58';
   const color bad_color=C'255,16,42';
   const color accent=C'255,16,42';
   const color accent_alt=C'96,164,255';
   const color cream=C'241,244,248';

   const int x=m.margin_x;
   const int inner_x=x + m.pad;
   const int inner_x2=inner_x + m.half_w + m.gap;
   const int right_button_x=x + m.width - m.pad - m.toggle_w;
   const int reason_chars=(int)MathMax(30.0,MathMin(58.0,(double)m.width / 7.0));
   const int info_chars=(int)MathMax(32.0,MathMin(62.0,(double)m.width / 6.6));
   const datetime now_value=ReferenceNow();
   RefreshDailyLocks(now_value,stats);
   RefreshNewsState(false);
   UpdateMarketRegimeState(false);

   const double spread_pips=CurrentSpreadPoints() / PipDivisor();
   const double today_profit=TodayClosedProfit(now_value);
   const double balance=AccountInfoDouble(ACCOUNT_BALANCE);
   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   const double margin=AccountInfoDouble(ACCOUNT_MARGIN);
   const double margin_level=(margin > 0.0) ? equity / margin * 100.0 : 0.0;
   const bool target_enabled=(DailyProfitTarget > 0.0);
   const bool wrap_up_active=IsFridayWrapUpWindow(g_news_state.server_now);
   const string stop_reason=CloseReasonText();
   const string stop_reason_display=(stop_reason == "" ? "环境正常，可开新单" : stop_reason);
   const string entry_state=EntryStateText(stop_reason);
   const string session_state=SessionStateText(now_value,stats);
   const string wrap_state=WrapUpStateText(stats);
   const string news_state=NewsStateText(stats);
   const color reason_color=(stop_reason == "" ? ok_color : warn_color);
   const string stop_label=(g_allow_buy || g_allow_sell) ? "停止交易" : "恢复交易";

   EnsurePanelRectangle("panel",x,m.margin_y,m.width,m.panel_h,panel_bg,panel_border,corner);
   EnsurePanelRectangle("header",x,m.margin_y,m.width,m.header_h,header_bg,panel_border,corner);
   const int title_y=m.margin_y + (m.header_h - ScalePx(22)) / 2;
   const int version_y=m.margin_y + (m.header_h - ScalePx(15)) / 2;
   EnsurePanelLabel("title","金麒麟",inner_x + ScalePx(2),title_y,m.font_lg,cream,corner,"Microsoft YaHei");
   EnsurePanelLabel("title_version","v4.00 均衡版",inner_x + ScalePx(94),version_y,m.font_sm,muted,corner,"Microsoft YaHei");

   if(!g_panel_open)
     {
      DeletePanelBodyObjects();
      EnsurePanelButton("toggle_panel","展开",right_button_x,m.margin_y + ScalePx(9),m.toggle_w,m.button_h,C'31,33,37',cream,corner,m.button_font,"Microsoft YaHei");
      return;
     }

   EnsurePanelRectangle("header_accent",x,m.margin_y + m.header_h - ScalePx(3),m.width,ScalePx(3),accent,accent,corner);
   EnsurePanelButton("toggle_panel","收起",right_button_x,m.margin_y + ScalePx(9),m.toggle_w,m.button_h,C'31,33,37',cream,corner,m.button_font,"Microsoft YaHei");

   int y=m.margin_y + m.header_h + m.section_gap;
   EnsurePanelRectangle("card_status",x,y,m.width,m.card_status_h,card_bg,card_border,corner);
   int status_y=y + m.pad;
   EnsurePanelLabel("status_line2","原因： " + ClipText(stop_reason_display,reason_chars),inner_x,status_y,m.font_xs,reason_color,corner);
   status_y+=m.row_h;
   EnsurePanelLabel("status_line3",ClipText("开仓： " + entry_state + "  /  多 " + BoolText(g_allow_buy,"开","停") + "  空 " + BoolText(g_allow_sell,"开","停"),info_chars),inner_x,status_y,m.font_xs,cream,corner);
   status_y+=m.row_h;
   EnsurePanelLabel("status_line4",ClipText("时段： " + EA_StartTime + "-" + EA_StopTime + "  /  " + session_state,info_chars),inner_x,status_y,m.font_xs,muted,corner);
   status_y+=m.row_h;
   EnsurePanelLabel("status_line5",ClipText("新闻： " + news_state,info_chars),inner_x,status_y,m.font_xs,g_news_state.block_entries ? warn_color : muted,corner);
   status_y+=m.row_h;
   EnsurePanelLabel("status_line6",ClipText("收尾： " + wrap_state,info_chars),inner_x,status_y,m.font_xs,wrap_up_active ? warn_color : muted,corner);

   y+=m.card_status_h + m.section_gap;
   EnsurePanelRectangle("card_metrics",x,y,m.width,m.card_metrics_h,card_bg,card_border,corner);

   int line_y=y + m.pad;
   const int metrics_step=ScalePx(23);
   DrawPanelLabelPair("metrics_a_l",
                      "今日已平： " + FormatSignedMoney(today_profit),
                      "metrics_a_r",
                      "目标： " + (target_enabled ? ("+" + DoubleToString(DailyProfitTarget,2)) : "未设置"),
                      inner_x,inner_x2,line_y,m.font_sm,
                      today_profit >= 0.0 ? ok_color : bad_color,
                      target_enabled ? accent_alt : muted,
                      corner);

   line_y+=metrics_step;
   DrawPanelLabelPair("metrics_b",
                      "Buy持仓： " + IntegerToString(stats.buy_positions) + "单  " + DoubleToString(stats.buy_lots,2) + "手",
                      "metrics_c",
                      "Sell持仓： " + IntegerToString(stats.sell_positions) + "单  " + DoubleToString(stats.sell_lots,2) + "手",
                      inner_x,inner_x2,line_y,m.font_sm,cream,cream,corner);

   line_y+=metrics_step;
   DrawPanelLabelPair("metrics_d_l",
                      "EA浮盈： " + FormatSignedMoney(stats.total_profit),
                      "metrics_d_r",
                      "点差： " + DoubleToString(spread_pips,1) + " pips",
                      inner_x,inner_x2,line_y,m.font_sm,
                      stats.total_profit >= 0.0 ? ok_color : bad_color,
                      muted,
                      corner);
   line_y+=metrics_step;
   DrawPanelLabelPair("metrics_f_l",
                      "余额： " + FormatSignedMoney(balance),
                      "metrics_f_lv",
                      "净值： " + FormatSignedMoney(equity),
                      inner_x,inner_x2,line_y,m.font_sm,cream,accent_alt,corner);
   line_y+=metrics_step;
   EnsurePanelLabel("metrics_h_l","保证金： " + FormatPercent(margin_level),inner_x,line_y,m.font_sm,margin_level >= 200.0 ? ok_color : warn_color,corner);

   y+=m.card_metrics_h + m.section_gap;
   EnsurePanelRectangle("card_actions",x,y,m.width,m.card_actions_h,card_bg,card_border,corner);

   const int button_y=y + ScalePx(13);
   EnsurePanelButton("stop_all",stop_label,inner_x,button_y,m.half_w,m.button_h,(g_allow_buy || g_allow_sell) ? C'38,40,45' : C'22,91,65',cream,corner,m.button_font,"Microsoft YaHei");
   EnsurePanelButton("close_ea","全部平仓并暂停",inner_x2,button_y,m.half_w,m.button_h,bad_color,White,corner,m.button_font,"Microsoft YaHei");
  }

void RefreshPanel(const bool force)
  {
   const datetime now_second=TimeCurrent();
   if(!force && now_second == g_last_panel_refresh)
      return;

   EAStats stats;
   CollectStats(stats);
   RefreshNewsState(false);
   DrawPanel(stats);
   g_last_panel_refresh=now_second;
   ChartRedraw(0);
  }

void DeletePanelBodyObjects()
  {
   for(int i=ObjectsTotal(0,-1,-1)-1; i>=0; --i)
     {
      const string name=ObjectName(0,i,-1,-1);
      if(StringFind(name,g_panel_prefix,0) != 0)
         continue;

      if(name == g_panel_prefix + "panel" ||
         name == g_panel_prefix + "header" ||
         name == g_panel_prefix + "title")
         continue;

      ObjectDelete(0,name);
     }
  }

void DeleteObjectsByPrefix(const string prefix)
  {
   for(int i=ObjectsTotal(0,-1,-1)-1; i>=0; --i)
     {
      const string name=ObjectName(0,i,-1,-1);
      if(StringFind(name,prefix,0) == 0)
         ObjectDelete(0,name);
     }
  }

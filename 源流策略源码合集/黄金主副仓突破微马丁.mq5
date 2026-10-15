//+------------------------------------------------------------------+
//|                                            黄金主副仓突破微马丁EA   |
//|                           Gold Master-Sub Breakout Micro-Martingale |
//|  主仓：前N根K线突破通道开仓(Donchian) | 一单一结主仓            |
//|  副仓：主仓浮亏达30点启动逆势微马丁加仓(最多4层,单层≤0.05)       |
//|  出场：A组合止盈 / B主盈盖副亏 / C组合移动止损 / D组合硬止损      |
//|  风控：200点逆向压力测试 ≤90%净值 | 总手数≤0.15硬上限0.20         |
//|       每日亏损≤30$ | 新闻前后15分钟停 | 周五收盘前30分钟全平      |
//|  账户：美分账户 200$=20000美分 | 杠杆1:500 | XAUUSD              |
//|  所有点距 = 点数 × PricePointScale() × _Point (黄金3/5位×10)      |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, GoldMasterSubMartingale"
#property link      ""
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//+------------------------------------------------------------------+
//| 全局交易对象                                                     |
//+------------------------------------------------------------------+
CTrade trade;

//+------------------------------------------------------------------+
//| 魔术号系统                                                       |
//|  主仓 = InpMagicNumber*10 + 1                                    |
//|  副仓 = InpMagicNumber*10 + 2                                    |
//|  平仓/统计遍历 {主,副} magic 集合                               |
//+------------------------------------------------------------------+
long g_mainMagic = 0;   // 主仓 magic
long g_subMagic  = 0;   // 副仓 magic

//+------------------------------------------------------------------+
//| 输入参数 - [0] 账户与品种                                        |
//+------------------------------------------------------------------+
input string InpSep0              = "===== 账户与品种 =====";  // ---- 账户 ----
input long   InpMagicNumber       = 20260822;  // 魔术号基数(主仓=*10+1, 副仓=*10+2)
input double InpLeverage          = 500;       // 杠杆(保证金估算参考,仅日志显示)
input bool   InpIsCentAccount     = true;      // 美分账户(内部统一按美元计算)
input double InpDepositUSD        = 200.0;     // 参考初始资金(美元,仅日志/风控参考)

//+------------------------------------------------------------------+
//| 输入参数 - [1] 突破信号                                          |
//+------------------------------------------------------------------+
input string InpSep1              = "===== 突破信号 =====";    // ---- 突破信号 ----
input int    InpChannelBars       = 20;        // 突破通道前N根K线
input ENUM_TIMEFRAMES InpTF       = PERIOD_CURRENT;// 通道周期(PERIOD_CURRENT=跟随图表周期)
input bool   InpUseCloseBreak     = true;      // true=收盘价穿越通道判定; false=触价(tick突破)判定
input bool   InpNewBarOnly        = true;      // 每根K线仅评估一次突破信号

//+------------------------------------------------------------------+
//| 输入参数 - [2] 主仓                                              |
//+------------------------------------------------------------------+
input string InpSep2              = "===== 主仓 =====";        // ---- 主仓 ----
input double InpMainLot           = 0.01;      // 主仓首单手数
input int    InpMainSLPoints      = 150;       // 组合级硬止损距离(点, 对全部持仓加权成本)
input int    InpMainTPPoints      = 100;       // 主仓固定止盈(点, 仅无副仓时有效)
input bool   InpMainTPOnSub       = false;     // 副仓激活后移除主仓独立SL/TP(止损交由组合级管理)
input bool   InpEnableTrailing    = true;      // 启用组合级移动止损
input int    InpTrailActivate     = 30;        // 移动止损启动距离(组合浮盈点数)
input int    InpTrailDistance     = 50;        // 移动止损跟随距离(点)
input double InpBreakEvenBuffer   = 2.0;       // 保本缓冲(点)

//+------------------------------------------------------------------+
//| 输入参数 - [3] 副仓(微马丁)                                      |
//+------------------------------------------------------------------+
input string InpSep3              = "===== 副仓(微马丁) ====="; // ---- 副仓 ----
input double InpSubTrigger        = 30.0;      // 副仓触发距离(主仓浮亏点数, 启动第1层)
input int    InpSubGridPoints     = 20;        // 副仓加仓间距(点)
input bool   InpGridScaleByMart   = false;     // 间距是否随层数×1.3放大(默认恒定20点)
input double InpSubFactor         = 1.3;       // 手数递增系数
input double InpSubFirstLot       = 0.01;      // 副仓首层手数
input double InpSubMaxLot         = 0.05;      // 副仓单层手数上限
input int    InpSubMaxLayers      = 4;         // 副仓最大层数(代码内 MathMin(此值,5) 兜底)

//+------------------------------------------------------------------+
//| 输入参数 - [4] 组合出场                                          |
//+------------------------------------------------------------------+
input string InpSep4              = "===== 组合出场 =====";    // ---- 组合出场 ----
input double InpTakeProfitUSD     = 5.0;       // 出场A: 组合止盈金额(美元)
input double InpHardStopUSD       = 180.0;     // 出场D: 组合硬止损金额(美元)

//+------------------------------------------------------------------+
//| 输入参数 - [5] 风控                                              |
//+------------------------------------------------------------------+
input string InpSep5              = "===== 风控 =====";        // ---- 风控 ----
input double InpMaxTotalLots      = 0.15;      // 最大总手数
input double InpHardMaxLots       = 0.20;      // 总手数硬上限(不可被参数突破)
input double InpMainRiskPct       = 2.0;       // 单笔主仓风险(%账户净值)
input int    InpMaxSpread         = 50;        // 点差>此值禁止开仓(点)
input double InpDailyMaxLossUSD   = 30.0;      // 每日最大亏损(美元, 含浮动)
input bool   InpDailyLossForceClose = true;    // 达日亏损上限是否强平已有仓
input double InpStressPoints      = 200.0;     // 压力测试逆向点数
input double InpStressMarginPct   = 90.0;      // 压力测试: 浮亏+保证金 ≤ 净值×此%
input bool   InpCheckMarginOnAdd  = true;      // 加仓时是否执行压力测试

//+------------------------------------------------------------------+
//| 输入参数 - [6] 过滤                                              |
//+------------------------------------------------------------------+
input string InpSep6              = "===== 过滤 =====";        // ---- 过滤 ----
input bool   InpNewsFilterOn      = true;      // 启用新闻过滤
input string InpNewsCurrency      = "USD";     // 关注货币
input string InpNewsKeywords      = "Nonfarm,NFP,CPI,PPI,GDP,Interest Rate,FOMC"; // 关键词
input int    InpNewsStopMin       = 15;        // 重要数据前后停交易(分钟)
input bool   InpFridayExit        = true;      // 周五收盘前清仓
input int    InpFridayCloseHour   = 21;        // 周五收盘时间(服务器时间, 小时)
input int    InpFridayCloseMin    = 0;         // 周五收盘时间(分)
input int    InpFridayLeadMin     = 30;        // 收盘前提前平仓(分钟)
input bool   InpEnableTimeFilter  = false;     // 时段过滤开关
input int    InpStartHour         = 0;         // 交易开始小时
input int    InpEndHour           = 23;        // 交易结束小时

//+------------------------------------------------------------------+
//| 输入参数 - [7] 通用                                              |
//+------------------------------------------------------------------+
input string InpSep7              = "===== 通用 =====";        // ---- 通用 ----
input int    InpMaxSlippageRetries = 5;        // 下单重试次数
input int    InpMaxCloseRetries   = 15;        // 平仓重试次数
input bool   InpDebugLog          = true;      // 详细日志
input double InpPointValuePerLot  = 0.0;       // 每点每手美元价值(0=自动按券商规格; 实盘与测试器不一致时手动指定,如1.0)

//+------------------------------------------------------------------+
//| 组合篮子状态结构                                                 |
//+------------------------------------------------------------------+
struct BasketState
{
   int    direction;       // +1 多 / -1 空 / 0 无仓
   int    mainCount;       // 主仓 ticket 数
   int    subCount;        // 副仓 ticket 数
   int    subLayers;       // 副仓层数 (=subCount)
   double mainLots;        // 主仓手数合计
   double subLots;         // 副仓手数合计
   double totalLots;       // 总手数
   double mainPL;          // 主仓浮盈(美元, 含swap+commission)
   double subPL;           // 副仓浮盈(美元)
   double totalPL;         // 组合浮盈(美元)
   double weightedAvgCost; // 组合加权平均成本
   double mainWeightedCost;// 主仓加权成本
   double mainPLPoints;    // 主仓浮盈(点数)
   double totalPLPoints;   // 组合浮盈(点数)
   ulong  mainTicket;      // 主仓 ticket
   ulong  subTickets[];    // 副仓 ticket 列表
   int    subLayerNos[];   // 副仓各层号(来自注释)
   int    maxSubLayer;     // 已触发最大层号
};

//+------------------------------------------------------------------+
//| 全局状态变量                                                     |
//+------------------------------------------------------------------+
datetime g_lastBarTime      = 0;     // 新K线检测
double   g_donchianHigh     = 0.0;   // 前N根最高(不含当前K)
double   g_donchianLow      = 0.0;   // 前N根最低(不含当前K)

// 组合级移动止损状态(组合重建时清零)
bool     g_trailActivated   = false; // 移动止损已启动
double   g_basketPeakPrice  = 0.0;   // 组合峰值(多=Bid最高/空=Ask最低)
double   g_basketTrailSL    = 0.0;   // 当前移动止损线
bool     g_breakevenSet     = false; // 已移保本
bool     g_trailPlaced      = false; // 移动止损已挂到组合(多仓SL/空仓TP位)

// 每日统计
string   g_todayDate        = "";
double   g_todayRealizedPL  = 0.0;   // 当日已实现盈亏(美元)
int      g_todayDeals       = 0;
bool     g_dailyStopTriggered = false;

// 阻塞标记(每Tick刷新)
bool     g_newsBlocked      = false;
bool     g_fridayWindow     = false;
bool     g_spreadBlocked    = false;

// 参数钳制后的硬上限(OnInit 计算, input 常量不可修改)
int      g_subMaxLayers     = 4;     // 副仓层数硬上限
double   g_subMaxLot        = 0.05;  // 副仓单层手数硬上限
double   g_hardMaxLots      = 0.20;  // 总手数硬上限

//+------------------------------------------------------------------+
//| 点值系统                                                         |
//+------------------------------------------------------------------+
int PricePointScale()
  {
   return((_Digits == 3 || _Digits == 5) ? 10 : 1);
  }

int PriceDistancePoints(const int points)
  {
   return((int)MathMax(0,points) * PricePointScale());
  }

// 点数 → 价格步长
double PointsToPriceStep(const int points)
  {
   return(PriceDistancePoints(points) * _Point);
  }

// 价格 → 点数
int PriceToPoints(const double anchor, const double price)
  {
   if(_Point <= 0.0) return(0);
   return((int)MathRound(MathAbs(price - anchor) / (_Point * PricePointScale())));
  }

// 点差(点)
double CurrentSpreadPoints()
  {
   double ask_price=0.0, bid_price=0.0;
   if(!SymbolInfoDouble(_Symbol,SYMBOL_ASK,ask_price) || !SymbolInfoDouble(_Symbol,SYMBOL_BID,bid_price))
      return(0.0);
   if(_Point <= 0.0) return(0.0);
   return((ask_price - bid_price) / _Point);
  }

// 单点每手金额(美元)
double PointValuePerLot()
  {
   // 手动覆盖优先: 实盘/测试器合约规格不一致时, 用输入值保证风险数学对齐
   if(InpPointValuePerLot > 0.0)
      return InpPointValuePerLot;
   double tv=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0.0 || ts <= 0.0 || _Point <= 0.0)
      return(0.0);
   return(tv * (_Point / ts));
  }

//+------------------------------------------------------------------+
//| 手数规范化                                                       |
//+------------------------------------------------------------------+
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

//+------------------------------------------------------------------+
//| 日志 (双参数: tag + 单条消息)                                    |
//+------------------------------------------------------------------+
void LogEvent(const string tag, const string msg)
  {
   Print("[",tag,"] ",TimeToString(TimeCurrent(),TIME_DATE|TIME_SECONDS)," ",msg);
  }

//+------------------------------------------------------------------+
//| 初始化                                                           |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_mainMagic = InpMagicNumber * 10 + 1;
   g_subMagic  = InpMagicNumber * 10 + 2;

   trade.SetExpertMagicNumber(g_mainMagic);
   trade.SetDeviationInPoints(PriceDistancePoints(10));

   // 校验品种
   if(_Symbol != "XAUUSD" && _Symbol != "GOLD" && _Symbol != "XAUUSD.a")
      Print("[初始化] 注意: 当前品种 ", _Symbol, " 不是 XAUUSD, 请确认品种设置");

   // 参数合法性钳制(防无限马丁): input 为常量不能修改, 用全局变量承载
   g_subMaxLayers  = MathMin(InpSubMaxLayers, 5);    // 层数硬上限5
   g_subMaxLot     = MathMin(InpSubMaxLot, 0.20);    // 单层手数硬上限
   g_hardMaxLots   = MathMin(InpHardMaxLots, 0.50);  // 总手数最终兜底(硬上限不可超0.5, 防御极端调参)

   Print("[初始化] 主仓magic=", g_mainMagic, " 副仓magic=", g_subMagic);
   Print("[初始化] _Digits=", _Digits, " _Point=", _Point,
         " 点数倍率=", PricePointScale(),
         " 1点=", _Point * PricePointScale(),
         " 100点=", PointsToPriceStep(100));
   Print("[初始化] 每点每手金额=", DoubleToString(PointValuePerLot(),4), " USD", (InpPointValuePerLot > 0.0 ? " (手动覆盖=" + DoubleToString(InpPointValuePerLot,4) + ")" : " (券商自动)"));

   // 合约规格全量打印(便于与实盘券商核对点值口径)
   double tickSize=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tickValue=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   double contSize=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_CONTRACT_SIZE);
   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double volStep=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   Print("[初始化] 合约规格: 报价位数=", _Digits, " 最小变动=tickSize=", DoubleToString(tickSize,5),
         " tickValue=", DoubleToString(tickValue,4), "USD 合约规模=", DoubleToString(contSize,0),
         " 最小手数=", DoubleToString(minVol,2), " 手数步进=", DoubleToString(volStep,2));
   double perPointPerLot=PointValuePerLot();
   Print("[初始化] 点值换算: 1点=每手", DoubleToString(perPointPerLot,4), "USD 0.01手=", DoubleToString(perPointPerLot*0.01,6), "USD/点 | ",
         "主仓SL", IntegerToString(InpMainSLPoints), "点=", DoubleToString(perPointPerLot*InpMainSLPoints*0.01,2), "USD/0.01手 | ",
         "主仓TP", IntegerToString(InpMainTPPoints), "点=", DoubleToString(perPointPerLot*InpMainTPPoints*0.01,2), "USD/0.01手 | ",
         "组合止盈A=", DoubleToString(InpTakeProfitUSD,1), "$≈", DoubleToString(InpTakeProfitUSD/(perPointPerLot*0.01),0), "点@0.01手 | ",
         "组合硬止损D=", DoubleToString(InpHardStopUSD,0), "$≈", DoubleToString(InpHardStopUSD/(perPointPerLot*0.01),0), "点@0.01手");
   Print("[初始化] 副仓层数上限=", g_subMaxLayers, " 单层上限=", g_subMaxLot,
         " 最大总手数=", InpMaxTotalLots, " 硬上限=", g_hardMaxLots);
   Print("[初始化] 组合硬止损=", InpHardStopUSD, "$ 组合止盈=", InpTakeProfitUSD,
         "$ 每日亏损=", InpDailyMaxLossUSD, "$ 压力测试=", InpStressPoints, "点@", InpStressMarginPct, "%净值");
   Print("[初始化] 账户: 初始资金=", DoubleToString(InpDepositUSD,0), "$ 杠杆=", DoubleToString(InpLeverage,0),
         " 美分账户=", (InpIsCentAccount ? "是" : "否"),
         " | 实际余额=", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2),
         " 净值=", DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2),
         " 杠杆=", IntegerToString((int)AccountInfoInteger(ACCOUNT_LEVERAGE)));

   if(MQLInfoInteger(MQL_TESTER))
      LogEvent("初始化", "回测模式启动");
   else
      LogEvent("初始化", "实盘模式启动(请务必在模拟盘充分验证)");

   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| 反初始化                                                         |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
  }

//+------------------------------------------------------------------+
//| 每日重置                                                         |
//+------------------------------------------------------------------+
void CheckDailyReset()
  {
   string todayStr = TimeToString(TimeCurrent(), TIME_DATE);
   if(g_todayDate != todayStr)
     {
      if(g_todayDate != "")
         LogEvent("每日重置", "昨日已实现盈亏=" + StringFormat("%.2f",g_todayRealizedPL) + " 平仓笔数=" + g_todayDeals);
      g_todayDate = todayStr;
      g_todayRealizedPL = 0.0;
      g_todayDeals = 0;
      g_dailyStopTriggered = false;
      LogEvent("每日重置", "新的一天: " + todayStr);
     }
  }

//+------------------------------------------------------------------+
//| 当日已实现盈亏累计(从HistoryDeals)                                |
//+------------------------------------------------------------------+
void UpdateDailyStats()
  {
   if(!HistorySelect(0, TimeCurrent() + 3600))
      return;

   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0)
         continue;
      long dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      if(dealMagic != g_mainMagic && dealMagic != g_subMagic)
         continue;
      string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
      if(dealSymbol != _Symbol)
         continue;
      long dealEntry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if((int)dealEntry != DEAL_ENTRY_OUT)
         continue;
      datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
      if(TimeToString(dealTime, TIME_DATE) != g_todayDate)
         continue;

      double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
      g_todayRealizedPL += profit;
      g_todayDeals++;
     }
  }

//+------------------------------------------------------------------+
//| 新闻过滤 (复用一单一结 IsUpcomingNews 思路)                       |
//+------------------------------------------------------------------+
bool IsUpcomingNews()
  {
   if(!InpNewsFilterOn) return false;

   string sep = ",";
   string news_arr[];
   int k = StringSplit(InpNewsKeywords, StringGetCharacter(sep, 0), news_arr);
   if(k <= 0) return false;

   MqlCalendarValue values[];
   datetime start = TimeCurrent();
   datetime end = start + 86400 * 3;
   if(!CalendarValueHistory(values, start, end)) return false;

   for(int i = 0; i < ArraySize(values); i++)
     {
      MqlCalendarEvent event;
      if(!CalendarEventById(values[i].event_id, event))
         continue;
      MqlCalendarCountry country;
      if(!CalendarCountryById(event.country_id, country))
         continue;

      if(StringFind(InpNewsCurrency, country.currency) < 0)
         continue;

      for(int j = 0; j < k; j++)
        {
         if(StringFind(event.name, news_arr[j]) >= 0)
           {
            if(values[i].time - TimeCurrent() < InpNewsStopMin * 60)
              {
               return true;
              }
           }
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 时段过滤                                                         |
//+------------------------------------------------------------------+
bool IsWithinTradingHours()
  {
   if(!InpEnableTimeFilter)
      return true;
   MqlDateTime stamp;
   TimeToStruct(TimeCurrent(), stamp);
   int hour = stamp.hour;
   if(InpStartHour <= InpEndHour)
      return(hour >= InpStartHour && hour < InpEndHour);
   else
      return(hour >= InpStartHour || hour < InpEndHour); // 跨午夜
  }

//+------------------------------------------------------------------+
//| 周五收盘前窗口                                                    |
//+------------------------------------------------------------------+
bool IsFridayWrapUpWindow(const datetime now_value)
  {
   if(!InpFridayExit)
      return false;
   MqlDateTime stamp;
   TimeToStruct(now_value, stamp);
   if(stamp.day_of_week != 5)   // 周五
      return false;

   // 当日秒数
   int secOfDay = stamp.hour*3600 + stamp.min*60 + stamp.sec;
   int closeSec = InpFridayCloseHour*3600 + InpFridayCloseMin*60;
   int leadSec  = InpFridayLeadMin * 60;

   // 收盘窗口起点 = 收盘秒 - 提前分钟
   int startSec = closeSec - leadSec;
   if(secOfDay >= startSec && secOfDay <= closeSec)
      return true;

   // 跨午夜兜底(极少数券商周五收盘在次日0点后)
   if(closeSec < leadSec)
      return(secOfDay >= 0 || secOfDay <= closeSec);

   return false;
  }

//+------------------------------------------------------------------+
//| 组合持仓扫描                                                     |
//|  遍历全部持仓, 按 主仓magic / 副仓magic 分桶统计                 |
//+------------------------------------------------------------------+
bool ScanBasket(BasketState &st)
  {
   ZeroMemory(st);
   ArrayResize(st.subTickets, 0);
   ArrayResize(st.subLayerNos, 0);
   st.direction = 0;
   st.maxSubLayer = 0;

   double sumVol = 0.0;
   double sumCost = 0.0;
   double mainSumCost = 0.0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      long magic = PositionGetInteger(POSITION_MAGIC);
      bool isMain = (magic == g_mainMagic);
      bool isSub  = (magic == g_subMagic);
      if(!isMain && !isSub)
         continue;

      ENUM_POSITION_TYPE ptype = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      double vol  = PositionGetDouble(POSITION_VOLUME);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double prof = PositionGetDouble(POSITION_PROFIT)
                  + PositionGetDouble(POSITION_SWAP)
                  + PositionGetDouble(POSITION_COMMISSION);
      string comment = PositionGetString(POSITION_COMMENT);

      int dir = (ptype == POSITION_TYPE_BUY) ? 1 : -1;
      if(st.direction == 0)
         st.direction = dir;
      else if(st.direction != dir)
        {
         // 方向冲突(理论上不应发生), 记录并忽略外部干扰仓
         LogEvent("扫描", "发现反向持仓 ticket=" + IntegerToString(ticket) + " dir=" + IntegerToString(dir) + " 与组合方向 " + IntegerToString(st.direction) + " 冲突, 忽略统计");
         continue;
        }

      sumVol  += vol;
      sumCost += vol * open;
      if(isMain)
        {
         st.mainCount++;
         st.mainLots  += vol;
         st.mainPL    += prof;
         st.mainTicket = ticket;
         mainSumCost  += vol * open;
        }
      else
        {
         st.subCount++;
         st.subLots  += vol;
         st.subPL    += prof;
         int n = ArraySize(st.subTickets);
         ArrayResize(st.subTickets, n + 1);
         st.subTickets[n] = ticket;

         int layerNo = SubLayerFromComment(comment);
         if(layerNo > 0)
           {
            int m = ArraySize(st.subLayerNos);
            ArrayResize(st.subLayerNos, m + 1);
            st.subLayerNos[m] = layerNo;
            if(layerNo > st.maxSubLayer)
               st.maxSubLayer = layerNo;
           }
        }
     }

   st.totalLots = st.mainLots + st.subLots;
   st.totalPL   = st.mainPL + st.subPL;

   if(sumVol > 0.0)
     {
      st.weightedAvgCost   = sumCost / sumVol;
      st.subLayers = st.subCount;
     }
   if(st.mainLots > 0.0)
      st.mainWeightedCost = mainSumCost / st.mainLots;

   // 浮盈点数
   MqlTick tick;
   if(SymbolInfoTick(_Symbol, tick))
     {
      double pps = _Point * PricePointScale();
      if(pps > 0.0)
        {
         if(st.direction == 1)
           {
            if(st.weightedAvgCost > 0.0)
               st.totalPLPoints = (tick.bid - st.weightedAvgCost) / pps;
            if(st.mainWeightedCost > 0.0)
               st.mainPLPoints  = (tick.bid - st.mainWeightedCost) / pps;
           }
         else if(st.direction == -1)
           {
            if(st.weightedAvgCost > 0.0)
               st.totalPLPoints = (st.weightedAvgCost - tick.ask) / pps;
            if(st.mainWeightedCost > 0.0)
               st.mainPLPoints  = (st.mainWeightedCost - tick.ask) / pps;
           }
        }
     }

   return(st.totalLots > 0.0);
  }

//+------------------------------------------------------------------+
//| 从注释解析副仓层号                                               |
//|  注释格式: "GOLD_MM_L{层号}"  例如 GOLD_MM_L3  → 3              |
//+------------------------------------------------------------------+
int SubLayerFromComment(const string comment)
  {
   const string prefix = "GOLD_MM_L";
   int pos = StringFind(comment, prefix);
   if(pos < 0)
      return 0;
   string num = StringSubstr(comment, pos + StringLen(prefix));
   // 截取数字部分
   string digits = "";
   for(int i = 0; i < StringLen(num); i++)
     {
      int ch = StringGetCharacter(num, i);
      if(ch >= '0' && ch <= '9')
         digits += CharToString((uchar)ch);
      else
         break;
     }
   if(digits == "")
      return 0;
   return (int)StringToInteger(digits);
  }

//+------------------------------------------------------------------+
//| 风控预检链                                                       |
//+------------------------------------------------------------------+
// 点差过滤
bool CheckSpreadLimit()
  {
   double spread = CurrentSpreadPoints();
   if(spread > InpMaxSpread)
     {
      if(InpDebugLog)
         LogEvent("风控-点差", "点差=" + DoubleToString(spread,1) + "点 > 限制" + IntegerToString(InpMaxSpread) + "点, 禁止开仓");
      return false;
     }
   return true;
  }

// 总手数上限
bool CheckTotalLotsLimit(const double addLot)
  {
   BasketState dummy;
   ScanBasket(dummy);
   double current = dummy.totalLots;
   double cap = MathMin(InpMaxTotalLots, g_hardMaxLots);
   if(current + addLot > cap + 0.000001)
     {
      LogEvent("风控-总手数", "当前=" + DoubleToString(current,2) + " + 新增=" + DoubleToString(addLot,2) + " > 上限=" + DoubleToString(cap,2) + " 禁止加仓");
      return false;
     }
   return true;
  }

// 单笔主仓风险反推手数(净值2%风险, 按主仓止损距离)
double RiskBasedMainLot()
  {
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double riskUSD = equity * InpMainRiskPct / 100.0;
   double riskPerLot = PointValuePerLot() * PriceDistancePoints(InpMainSLPoints);
   if(riskPerLot <= 0.0)
      return InpMainLot;

   double lot = riskUSD / riskPerLot;
   lot = NormalizeVolumeToSymbol(lot);
   lot = MathMin(lot, InpMainLot);
   lot = MathMax(lot, NormalizeVolumeToSymbol(InpMainLot * 0.1));
   return lot;
  }

//+------------------------------------------------------------------+
//| 200点逆向压力测试                                                |
//|  开/加仓前: 200点逆向时 全部持仓(含新单)浮亏 + 保证金 ≤ 净值90%  |
//+------------------------------------------------------------------+
bool CanAffordStressTest(const int dir, const double addLot, const double anchorPrice)
  {
   if(!InpCheckMarginOnAdd && addLot <= 0.0)
      return true;
   if(dir == 0 || anchorPrice <= 0.0 || _Point <= 0.0)
      return false;

   double pps = _Point * PricePointScale();
   double stressPrice = (dir == 1) ? (anchorPrice - InpStressPoints * pps)
                                   : (anchorPrice + InpStressPoints * pps);

   // 当前全部持仓 + 新单 的 200点逆向浮亏
   double adverseLoss = 0.0;
   double totalVol = addLot;
   double pipValuePerLot = PointValuePerLot() * PricePointScale(); // 每"点"每手金额
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      long magic = PositionGetInteger(POSITION_MAGIC);
      if(magic != g_mainMagic && magic != g_subMagic)
         continue;

      double vol  = PositionGetDouble(POSITION_VOLUME);
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      ENUM_POSITION_TYPE ptype = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      int pdir = (ptype == POSITION_TYPE_BUY) ? 1 : -1;
      if(pdir != dir)
         continue; // 只统计同方向

      totalVol += vol;
      double priceGap = MathAbs(open - stressPrice);
      double pointsDiff = priceGap / (_Point * PricePointScale());
      adverseLoss += pointsDiff * pipValuePerLot * vol;
     }

   // 保证金占用(按200点逆向价估算)
   double margin = 0.0;
   ENUM_ORDER_TYPE otype = (dir == 1) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(!OrderCalcMargin(otype, _Symbol, totalVol, stressPrice, margin))
     {
      LogEvent("风控-压力测试", "OrderCalcMargin 失败, 保守拒绝");
      return false;
     }

   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double budget = equity * InpStressMarginPct / 100.0;
   double totalCost = adverseLoss + margin;

   if(totalCost > budget)
     {
      LogEvent("风控-压力测试", "200点逆向: 浮亏=" + DoubleToString(adverseLoss,2) + " + 保证金=" + DoubleToString(margin,2) + " = " + DoubleToString(totalCost,2) + " > 预算=" + DoubleToString(budget,2) + " (净值" + DoubleToString(equity,2) + "×" + DoubleToString(InpStressMarginPct,0) + "%) 拒绝");
      return false;
     }

   if(InpDebugLog)
      LogEvent("风控-压力测试", "通过: 200点逆向 浮亏+保证金=" + DoubleToString(totalCost,2) + " ≤ 预算" + DoubleToString(budget,2));
   return true;
  }

//+------------------------------------------------------------------+
//| 整体开仓前置检查                                                 |
//+------------------------------------------------------------------+
bool IsTradeAllowedOverall()
  {
   if(g_dailyStopTriggered)
     {
      LogEvent("风控-日亏", "当日已达最大亏损, 停止开仓/加仓");
      return false;
     }
   if(g_fridayWindow)
     {
      LogEvent("过滤-周五", "周五收盘前窗口, 停止开仓");
      return false;
     }
   if(g_newsBlocked)
     {
      LogEvent("过滤-新闻", "重要数据前后" + IntegerToString(InpNewsStopMin) + "分钟停交易");
      return false;
     }
   if(g_spreadBlocked)
     {
      LogEvent("过滤-点差", "点差过大禁止开仓");
      return false;
     }
   if(!IsWithinTradingHours())
     {
      LogEvent("过滤-时段", "不在交易时段内");
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| 突破通道刷新 (前N根K线最高/最低, 不含当前K)                       |
//|  默认用图表周期(PERIOD_CURRENT): 通道与评估同周期, 数据必然存在,  |
//|  避免 H1图表+M15通道 错配导致 M15 数据缺失、一单不下.             |
//|  高级用户可设 InpTF 为其他周期做跨周期实验(需确保该周期数据.      |
//+------------------------------------------------------------------+
void RefreshDonchian()
  {
   ENUM_TIMEFRAMES tf = (InpTF == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)Period() : InpTF;
   MqlRates rates[];
   // 通道 = 上一根K之前的N根(shift=2起), 保证"被比较的收盘K"不在通道内
   int copied = CopyRates(_Symbol, tf, 2, InpChannelBars, rates);
   if(copied < InpChannelBars)
     {
      g_donchianHigh = 0.0;
      g_donchianLow  = 0.0;
      if(InpDebugLog)
         LogEvent("突破", "通道数据不足: got=" + IntegerToString(copied) + " need=" + IntegerToString(InpChannelBars));
      return;
     }

   double hi = rates[0].high;
   double lo = rates[0].low;
   for(int i = 1; i < copied; i++)
     {
      if(rates[i].high > hi) hi = rates[i].high;
      if(rates[i].low  < lo) lo = rates[i].low;
     }
   g_donchianHigh = hi;
   g_donchianLow  = lo;
  }

//+------------------------------------------------------------------+
//| 突破信号判定 (返回 +1 多 / -1 空 / 0 无信号)                      |
//|  收盘穿越: 当前周期上一根已收盘K的收盘价 vs 通道(前N根不含它).   |
//|  触价: 当前 Tick 穿越通道.                                        |
//+------------------------------------------------------------------+
int CheckBreakoutSignal()
  {
   if(g_donchianHigh <= 0.0 || g_donchianLow <= 0.0)
      return 0;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return 0;

   ENUM_TIMEFRAMES tf = (InpTF == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)Period() : InpTF;

   if(InpUseCloseBreak)
     {
      // 收盘价穿越: 取当前周期上一根已收盘K线, 其收盘价 vs 通道(前N根=它之前的N根)
      // 注意: RefreshDonchian 已用 CopyRates(tf,1,N) 取得"上一根开始的N根通道",
      //       这里同样取上一根收盘, 两者同基准.
      MqlRates last[];
      if(CopyRates(_Symbol, tf, 1, 1, last) != 1)
         return 0;
      double close = last[0].close;
      if(close > g_donchianHigh)
         return 1;
      if(close < g_donchianLow)
         return -1;
      return 0;
     }
   else
     {
      // 触价(tick)判定
      if(tick.bid > g_donchianHigh)
         return 1;
      if(tick.ask < g_donchianLow)
         return -1;
      return 0;
     }
  }

//+------------------------------------------------------------------+
//| 下单/重试 (CTrade)                                               |
//+------------------------------------------------------------------+
bool PlaceOrderWithRetry(const ENUM_ORDER_TYPE otype, const double lot,
                         const double sl, const double tp, const string comment)
  {
   long magic = (StringFind(comment, "MAIN") >= 0) ? g_mainMagic : g_subMagic;
   trade.SetExpertMagicNumber(magic);

   for(int retry = 0; retry < InpMaxSlippageRetries; retry++)
     {
      bool result = false;
      if(otype == ORDER_TYPE_BUY)
         result = trade.Buy(lot, _Symbol, 0.0, sl, tp, comment);
      else if(otype == ORDER_TYPE_SELL)
         result = trade.Sell(lot, _Symbol, 0.0, sl, tp, comment);

      if(result && trade.ResultRetcode() == TRADE_RETCODE_DONE)
         return true;

      int retcode = trade.ResultRetcode();
      if(retcode == TRADE_RETCODE_REJECT || retcode == TRADE_RETCODE_TIMEOUT ||
         retcode == TRADE_RETCODE_REQUOTE)
        {
         if(retry < InpMaxSlippageRetries - 1)
           {
            Sleep(100);
            continue;
           }
        }
      LogEvent("下单失败", "type=" + IntegerToString(otype) + " lot=" + DoubleToString(lot,2) + " retcode=" + IntegerToString(retcode) + " desc=" + trade.ResultRetcodeDescription());
      break;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 平仓/重试                                                        |
//+------------------------------------------------------------------+
bool ClosePositionWithRetry(const ulong ticket)
  {
   for(int retry = 0; retry < InpMaxCloseRetries; retry++)
     {
      if(!PositionSelectByTicket(ticket))
         return true; // 已不存在
      if(trade.PositionClose(ticket))
         return true;

      int retcode = trade.ResultRetcode();
      if(retcode == TRADE_RETCODE_TIMEOUT || retcode == TRADE_RETCODE_REQUOTE ||
         retcode == TRADE_RETCODE_REJECT || retcode == TRADE_RETCODE_PRICE_OFF)
        {
         int ms = 500;
         if(retcode == TRADE_RETCODE_TIMEOUT) ms = 1000;
         if(retcode == TRADE_RETCODE_REQUOTE) ms = 800;
         Sleep(ms);
         continue;
        }
      break;
     }
   LogEvent("平仓失败", "ticket=" + IntegerToString(ticket) + " retcode=" + IntegerToString(trade.ResultRetcode()));
   return false;
  }

//+------------------------------------------------------------------+
//| 全部平仓 (主+副 magic 集合)                                      |
//+------------------------------------------------------------------+
void CloseAllPositions(const string reason)
  {
   // 先平副仓(逆势仓) 再平主仓
   for(int pass = 0; pass < 2; pass++)
     {
      long targetMagic = (pass == 0) ? g_subMagic : g_mainMagic;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0 || !PositionSelectByTicket(ticket))
            continue;
         if(PositionGetString(POSITION_SYMBOL) != _Symbol)
            continue;
         if(PositionGetInteger(POSITION_MAGIC) != targetMagic)
            continue;
         ClosePositionWithRetry(ticket);
        }
     }

   // 清理移动止损状态
   g_trailActivated = false;
   g_breakevenSet   = false;
   g_trailPlaced    = false;
   g_basketPeakPrice = 0.0;
   g_basketTrailSL   = 0.0;

   LogEvent("全平", reason);
  }

//+------------------------------------------------------------------+
//| 主仓开仓                                                         |
//+------------------------------------------------------------------+
bool OpenMainPosition(const int direction)
  {
   double lot = RiskBasedMainLot();
   lot = MathMin(lot, InpMainLot);

   // 单笔主仓风险 ≤ 净值2% (RiskBasedMainLot 已按2%反推, 此处再校验)
   if(!CheckTotalLotsLimit(lot))
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double anchor = (direction == 1) ? tick.ask : tick.bid;
   if(!CanAffordStressTest(direction, lot, anchor))
      return false;

   double sl = 0.0, tp = 0.0;
   if(InpMainSLPoints > 0)
      sl = (direction == 1) ? anchor - PointsToPriceStep(InpMainSLPoints)
                            : anchor + PointsToPriceStep(InpMainSLPoints);
   if(InpMainTPPoints > 0)
      tp = (direction == 1) ? anchor + PointsToPriceStep(InpMainTPPoints)
                            : anchor - PointsToPriceStep(InpMainTPPoints);

   ENUM_ORDER_TYPE otype = (direction == 1) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   string comment = "GOLD_MM_MAIN";
   if(PlaceOrderWithRetry(otype, lot, sl, tp, comment))
     {
      LogEvent("开主仓", (direction == 1 ? "BUY" : "SELL") + " 手数=" + DoubleToString(lot,2) + " SL=" + DoubleToString(sl,_Digits) + " TP=" + DoubleToString(tp,_Digits) + " 触发: " + (direction == 1 ? "上破前" : "下破前") + IntegerToString(InpChannelBars) + "根高低");
      ResetTrailState();
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 重置移动止损状态                                                  |
//+------------------------------------------------------------------+
void ResetTrailState()
  {
   g_trailActivated   = false;
   g_breakevenSet     = false;
   g_trailPlaced      = false;
   g_basketPeakPrice  = 0.0;
   g_basketTrailSL    = 0.0;
  }

//+------------------------------------------------------------------+
//| 副仓手数计算 (第i层, 从1开始)                                    |
//+------------------------------------------------------------------+
double SubLayerLot(const int layer)
  {
   if(layer <= 0)
      return 0.0;
   double lot = InpSubFirstLot * MathPow(InpSubFactor, layer - 1);
   lot = NormalizeVolumeToSymbol(lot);
   lot = MathMin(lot, g_subMaxLot);   // 单层上限
   return lot;
  }

//+------------------------------------------------------------------+
//| 副仓加仓间距(点数, 第k层相对第1层的累计逆势距离)                  |
//+------------------------------------------------------------------+
int SubGridTotalPoints(const int layer)
  {
   // layer=1 → 0; layer=2 → 1个间距; layer=3 → 2个间距...
   if(layer <= 1)
      return 0;
   double total = 0.0;
   for(int i = 1; i < layer; i++)
     {
      double step = InpSubGridPoints;
      if(InpGridScaleByMart)
         step = InpSubGridPoints * MathPow(InpSubFactor, i - 1);
      total += step;
     }
   return (int)total;
  }

//+------------------------------------------------------------------+
//| 副仓加仓判定与开仓                                                |
//+------------------------------------------------------------------+
bool TryAddSubLayer(BasketState &st)
  {
   if(st.direction == 0)
      return false;

   // 副仓层数硬上限
   int maxLayers = g_subMaxLayers;
   if(st.subLayers >= maxLayers)
      return false;

   // 下一层号 = 已触发最大层号 + 1 (主仓入场且尚未有副仓时 = 1)
   int nextLayer = (st.maxSubLayer > 0) ? st.maxSubLayer + 1 : 1;
   if(nextLayer > maxLayers)
      return false;

   // 触发阈值: 主仓逆向点数达到 T_k = 触发距离 + 累计间距 (用户确认: 主仓浮亏为锚)
   int threshold = (int)InpSubTrigger + SubGridTotalPoints(nextLayer);
   bool triggered = (st.mainPLPoints <= -threshold);

   if(!triggered)
      return false;

   double lot = SubLayerLot(nextLayer);
   if(lot <= 0.0)
      return false;

   // 总手数校验
   if(!CheckTotalLotsLimit(lot))
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double anchor = (st.direction == 1) ? tick.ask : tick.bid;
   if(!CanAffordStressTest(st.direction, lot, anchor))
      return false;

   ENUM_ORDER_TYPE otype = (st.direction == 1) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   string comment = StringFormat("GOLD_MM_L%d", nextLayer);
   if(PlaceOrderWithRetry(otype, lot, 0.0, 0.0, comment))
     {
      LogEvent("加副仓", "层号=" + IntegerToString(nextLayer) + " 方向=" + (st.direction == 1 ? "BUY" : "SELL") + " 手数=" + DoubleToString(lot,2) + " 主仓浮亏=" + DoubleToString(-st.mainPLPoints,1) + "点 (阈值" + IntegerToString(threshold) + "点)");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 组合出场 A: 全部持仓合计浮盈 ≥ 组合止盈金额                      |
//+------------------------------------------------------------------+
bool CheckExitA(BasketState &st)
  {
   if(st.totalPL >= InpTakeProfitUSD)
     {
      LogEvent("出场A-组合止盈", "组合浮盈=" + DoubleToString(st.totalPL,2) + "$ ≥ 目标" + DoubleToString(InpTakeProfitUSD,2) + "$ 全平");
      CloseAllPositions("组合止盈A");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 组合出场 B: 主仓浮盈 ≥ 副仓浮亏 且 整体浮盈 > 0                 |
//+------------------------------------------------------------------+
bool CheckExitB(BasketState &st)
  {
   if(st.subLayers <= 0)
      return false;
   if(st.mainPL >= -st.subPL && st.totalPL > 0.0)
     {
      LogEvent("出场B-主盈盖副亏", "主仓浮盈=" + DoubleToString(st.mainPL,2) + "$ 副仓浮亏=" + DoubleToString(-st.subPL,2) + "$ 组合=" + DoubleToString(st.totalPL,2) + "$ 全平");
      CloseAllPositions("主盈盖副亏B");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 组合出场 D: 组合浮亏 ≥ 硬止损金额 或 距加权成本 ≥ 硬止损距离     |
//+------------------------------------------------------------------+
bool CheckExitD(BasketState &st)
  {
   bool byMoney = (st.totalPL <= -InpHardStopUSD);
   bool byDistance = (st.weightedAvgCost > 0.0 && st.totalPLPoints <= -InpMainSLPoints);

   if(byMoney || byDistance)
     {
      LogEvent("出场D-组合硬止损", byMoney ? ("金额触发: 组合浮亏=" + DoubleToString(-st.totalPL,2) + "$ ≥ " + DoubleToString(InpHardStopUSD,0) + "$")
                       : ("距离触发: 组合逆势=" + DoubleToString(-st.totalPLPoints,1) + "点 ≥ " + IntegerToString(InpMainSLPoints) + "点") + " 全平");
      CloseAllPositions("组合硬止损D");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 周五收盘前全平                                                    |
//+------------------------------------------------------------------+
bool CheckExitFriday(BasketState &st)
  {
   if(g_fridayWindow && st.direction != 0)
     {
      LogEvent("出场-周五", "收盘前" + IntegerToString(InpFridayLeadMin) + "分钟, 全平");
      CloseAllPositions("周五收盘平仓");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 每日最大亏损强平                                                  |
//+------------------------------------------------------------------+
bool CheckDailyLossForce(BasketState &st)
  {
   if(!InpDailyLossForceClose)
      return false;
   double totalDayLoss = g_todayRealizedPL + st.totalPL;
   if(totalDayLoss <= -InpDailyMaxLossUSD && st.direction != 0)
     {
      g_dailyStopTriggered = true;
      LogEvent("风控-日亏强平", "今日已实现=" + DoubleToString(g_todayRealizedPL,2) + " + 浮动=" + DoubleToString(st.totalPL,2) + " = " + DoubleToString(totalDayLoss,2) + "$ ≤ -" + DoubleToString(InpDailyMaxLossUSD,2) + "$ 强平");
      CloseAllPositions("日亏损强平");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| 组合级移动止损 (保本 + 50点跟随, 出场方式C)                       |
//|  启动: 组合浮盈点数 ≥ InpTrailActivate(30)                        |
//|  副仓激活期间冻结上移, 被扫到即全平                               |
//+------------------------------------------------------------------+
bool CheckTrailingStopBasket(BasketState &st)
  {
   if(!InpEnableTrailing)
      return false;
   if(st.direction == 0)
      return false;
   if(st.subLayers > 0)
      return false;   // 副仓期间冻结

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   int dir = st.direction;

   // 1) 启动: 组合浮盈达到激活距离
   if(!g_trailActivated)
     {
      if(st.totalPLPoints >= InpTrailActivate)
        {
         g_trailActivated = true;
         g_basketPeakPrice = (dir == 1) ? tick.bid : tick.ask;
         LogEvent("移动止损", "启动: 组合浮盈=" + DoubleToString(st.totalPLPoints,1) + "点 ≥ " + IntegerToString(InpTrailActivate) + "点");
        }
      else
         return false;
     }

   // 2) 更新峰值
   if(dir == 1)
     {
      if(tick.bid > g_basketPeakPrice || g_basketPeakPrice <= 0.0)
         g_basketPeakPrice = tick.bid;
     }
   else
     {
      if(tick.ask < g_basketPeakPrice || g_basketPeakPrice <= 0.0)
         g_basketPeakPrice = tick.ask;
     }

   // 3) 移动止损线 (先保本, 再50点跟随)
   //    保本: 未保本时 SL = 加权成本 ± 保本缓冲
   //    跟随: 已保本后 SL = 峰值 ∓ 移动止损距离
   double trailSL;
   if(!g_breakevenSet)
     {
      // 第一步: 移到保本位(加权成本 + 缓冲)
      double bePrice = (dir == 1) ? (st.weightedAvgCost + PointsToPriceStep((int)InpBreakEvenBuffer))
                                  : (st.weightedAvgCost - PointsToPriceStep((int)InpBreakEvenBuffer));
      // 保本位只向有利方向移动: 多仓保本>当前SL, 空仓保本<当前SL
      trailSL = bePrice;
     }
   else
     {
      trailSL = (dir == 1) ? g_basketPeakPrice - PointsToPriceStep(InpTrailDistance)
                           : g_basketPeakPrice + PointsToPriceStep(InpTrailDistance);
     }

   // 4) 触发全平 (出场C)
   if(dir == 1 && tick.bid <= g_basketTrailSL && g_trailPlaced)
     {
      LogEvent("出场C-移动止损", "多头触发: bid=" + DoubleToString(tick.bid,_Digits) + " ≤ 移动止损线" + DoubleToString(g_basketTrailSL,_Digits));
      CloseAllPositions("移动止损C");
      return true;
     }
   if(dir == -1 && tick.ask >= g_basketTrailSL && g_trailPlaced)
     {
      LogEvent("出场C-移动止损", "空头触发: ask=" + DoubleToString(tick.ask,_Digits) + " ≥ 移动止损线" + DoubleToString(g_basketTrailSL,_Digits));
      CloseAllPositions("移动止损C");
      return true;
     }

   // 5) 应用到持仓 (主仓SL=trailSL / 副仓无SL). 组合移动止损挂主仓即可
   //    衔接: 保本后跟随线不得低于已设保本位(多) / 不得高于保本位(空), 保证只向有利方向移动
   double applySL = trailSL;
   if(g_breakevenSet)
     {
      if(dir == 1 && applySL < g_basketTrailSL)
         applySL = g_basketTrailSL;
      if(dir == -1 && applySL > g_basketTrailSL)
         applySL = g_basketTrailSL;
     }

   if(!g_trailPlaced || applySL != g_basketTrailSL)
     {
      bool modified = ModifyBasketTrailSL(dir, applySL);
      if(modified)
        {
         g_basketTrailSL = applySL;
         g_trailPlaced = true;
         if(!g_breakevenSet)
           {
            g_breakevenSet = true;
            LogEvent("移动止损", "保本设置: SL=" + DoubleToString(applySL,_Digits) + " (加权成本 " + DoubleToString(st.weightedAvgCost,_Digits) + ")");
           }
         else
           {
            if(InpDebugLog)
               LogEvent("移动止损", "上移至 " + DoubleToString(applySL,_Digits) + " (峰值 " + DoubleToString(g_basketPeakPrice,_Digits) + ")");
           }
        }
     }

   return false;
  }

//+------------------------------------------------------------------+
//| 修改组合移动止损 (挂到主仓 SL/TP 位)                              |
//+------------------------------------------------------------------+
bool ModifyBasketTrailSL(const int dir, const double trailSL)
  {
   // 找到主仓
   ulong mainTicket = 0;
   double mainSL = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != g_mainMagic)
         continue;
      mainTicket = ticket;
      mainSL = PositionGetDouble(POSITION_SL);
      break;
     }

   if(mainTicket == 0)
      return false;

   double tp = PositionGetDouble(POSITION_TP);

   // 只向有利方向移动
   double newSL = trailSL;
   if(dir == 1)
     {
      if(mainSL > 0.0 && newSL <= mainSL)
         return false;   // 不向下移动
     }
   else
     {
      if(mainSL > 0.0 && newSL >= mainSL)
         return false;   // 不向上移动
     }

   if(!trade.PositionModify(mainTicket, newSL, tp))
     {
      LogEvent("移动止损", "修改失败 retcode=" + IntegerToString(trade.ResultRetcode()));
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| OnTick 主流程                                                    |
//+------------------------------------------------------------------+
void OnTick()
  {
   // ① 刷新与窗口检查
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return;

   CheckDailyReset();
   g_fridayWindow  = IsFridayWrapUpWindow(TimeCurrent());
   g_newsBlocked   = IsUpcomingNews();
   g_spreadBlocked = (CurrentSpreadPoints() > InpMaxSpread);

   // ② 组合持仓扫描
   BasketState st;
   bool hasBasket = ScanBasket(st);

   // ③ 出场检查 (永远优先于加仓/开仓)
   if(hasBasket)
     {
      UpdateDailyStats();

      if(CheckDailyLossForce(st))
         return;

      if(CheckExitFriday(st))
         return;

      if(CheckExitB(st))
         return;

      if(CheckExitA(st))
         return;

      if(CheckExitD(st))
         return;

      if(CheckTrailingStopBasket(st))
         return;

      // 副仓激活后: 移除主仓独立SL/TP, 止损交由组合级硬止损/移动止损管理
      if(InpMainTPOnSub && st.subLayers > 0 && st.mainTicket > 0)
         RemoveMainSLTP(st.mainTicket);
     }

   // ④ 加仓检查
   if(hasBasket && st.direction != 0)
     {
      TryAddSubLayer(st);
      return;   // 有组合持仓, 不开新主仓
     }

   // ⑤ 开仓检查 (仅新K线触发, 组合空仓)
   if(!hasBasket && !g_dailyStopTriggered)
     {
      ENUM_TIMEFRAMES tf = (InpTF == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)Period() : InpTF;
      bool newBar = (g_lastBarTime != iTime(_Symbol, tf, 0));
      if(newBar || !InpNewBarOnly)
        {
         g_lastBarTime = iTime(_Symbol, tf, 0);
         RefreshDonchian();

         if(IsTradeAllowedOverall())
           {
            int signal = CheckBreakoutSignal();
            if(signal == 1)
               OpenMainPosition(1);
            else if(signal == -1)
               OpenMainPosition(-1);
           }
        }
     }

   // ⑥ 日志
   if(InpDebugLog && hasBasket)
      DebugLog(st);
  }

//+------------------------------------------------------------------+
//| 副仓激活后移除主仓独立SL/TP                                       |
//|  主仓独立150点SL会先于组合硬止损被扫(组合加权成本更低), 破坏        |
//|  "整体组合硬止损"语义. 故副仓建立后移除主仓独立SL/TP,              |
//|  止损完全交由组合级硬止损(出场D)与组合移动止损管理.                 |
//+------------------------------------------------------------------+
void RemoveMainSLTP(const ulong ticket)
  {
   if(!PositionSelectByTicket(ticket))
      return;
   double sl = PositionGetDouble(POSITION_SL);
   double tp = PositionGetDouble(POSITION_TP);
   if(sl != 0.0 || tp != 0.0)
     {
      if(trade.PositionModify(ticket, 0.0, 0.0))
        {
         if(InpDebugLog)
            LogEvent("主仓SL/TP", "副仓激活, 移除主仓独立SL/TP (止损交由组合级管理)");
        }
     }
  }

//+------------------------------------------------------------------+
//| 调试日志摘要                                                      |
//+------------------------------------------------------------------+
void DebugLog(BasketState &st)
  {
   LogEvent("状态", "方向=" + (st.direction == 1 ? "多" : (st.direction == -1 ? "空" : "无")) + " 主=" + DoubleToString(st.mainLots,2) + "手 副=" + DoubleToString(st.subLots,2) + "手(" + IntegerToString(st.subLayers) + "层)" + " 总=" + DoubleToString(st.totalLots,2) + "手" + " 浮盈=" + DoubleToString(st.totalPL,2) + "$(" + DoubleToString(st.totalPLPoints,1) + "点)" + " 加权成本=" + DoubleToString(st.weightedAvgCost,_Digits) + " 移动止损=" + (g_trailPlaced ? DoubleToString(g_basketTrailSL,_Digits) : "未启动"));
  }


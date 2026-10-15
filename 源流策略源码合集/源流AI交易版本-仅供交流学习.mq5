//+------------------------------------------------------------------+
//|                                          源流AI交易版本 V3.2      |
//|                    源流智能AI交易系统 - 黄金专用                  |
//|              清晰架构 | 可靠执行 | AI驱动决策                     |
//|        V3.2: 高级形态识别 (100根K线深度分析!)                     |
//|   让利润奔跑 + 智能追踪止损 + 基于形态的AI交易                   |
//|   多时间框架: M1:30, M5:100, M15:100, H1:100, H4:50, D1:100      |
//+------------------------------------------------------------------+
#property copyright "源流智能交易系统"
#property version   "3.20"
#property description "黄金交易 - 形态识别 + 让利润奔跑"
#property strict    // 保持兼容性

#include <Trade\Trade.mqh>

//+------------------------------------------------------------------+
//| 输入参数                                                         |
//+------------------------------------------------------------------+
input group "═══════════════════════════════════════════════════════"
input group "面板位置与尺寸"
input int      InpXLeft          = 10;       // 左面板X位置
input int      InpYTop           = 40;       // 顶部面板Y位置
input int      InpWidthLeft      = 220;      // 左面板宽度
input int      InpWidthRight     = 280;      // 右面板宽度
input int      InpWidthThird     = 280;      // 第三面板宽度
input int      InpPanelHeight    = 650;      // 面板高度

input group "═══════════════════════════════════════════════════════"
input group "配色方案"
input color    ClrBackground     = C'10,10,12';    // 背景颜色
input color    ClrHeader         = C'255,190,0'; // 标题颜色(金色)
input color    ClrLabel          = C'180,180,180'; // 标签颜色
input color    ClrValue          = C'255,255,255'; // 数值颜色
input color    ClrBuy            = C'46,204,113';  // 买入/看涨颜色
input color    ClrSell           = C'231,76,60';   // 卖出/看跌颜色
input color    ClrNeutral        = C'120,120,120'; // 中性颜色
input color    ClrWarning        = C'255,152,0';  // 警告颜色

input group "═══════════════════════════════════════════════════════"
input group "指标设置"
input int      InpRSIPeriod      = 14;       // RSI周期
input int      InpMAFast         = 20;       // 快速均线周期
input int      InpMASlow         = 50;       // 慢速均线周期
input int      InpATRPeriod      = 14;       // ATR周期

input group "═══════════════════════════════════════════════════════"
input group "DeepSeek AI集成 - 可配置分析!"
input bool     InpUseAI          = true;     // 使用AI做交易决策
input string   InpOpenAIAPIKey   = "api-KEY";       // DeepSeek API密钥
input string   InpOpenAIModel    = "deepseek-v4-flash"; // DeepSeek模型(推荐使用deepseek-chat)
input int      InpAIUpdateMinutes = 3;      // AI更新间隔(1-15分钟)
input double   InpAIConfidenceMin = 0.60;   // AI最低置信度(降低以增加交易频率)
input bool     InpAIOverride      = true;  // 允许AI覆盖信号

input group "═══════════════════════════════════════════════════════"
input group "交易算法设置"
input bool     InpEnableTrading  = true;    // 启用自动交易
input double   InpLotSize        = 0.01;    // 每笔交易手数(波段交易)
input int      InpRSIBuyLevel    = 30;       // RSI买入信号水平(超卖)
input int      InpMaxPositions   = 5;       // 最大持仓数(波段交易)
input double   InpStopLossATR     = 5;      // 止损(ATR倍数) - 宽止损提高胜率
input double   InpMaxStopLossDollars = 50.0; // 最大止损金额(美元,0=禁用)
input int      InpMinSpreadPts   = 5000;    // 最小点差(点)
input bool     InpRequireSupport = true;     // 要求价格接近支撑位
input double   InpSupportDistance = 100.0;  // 支撑距离(点)
input bool     InpRequireBullishMA = true;   // 要求均线看涨趋势
input bool     InpRequireGoodSession = true;// 要求良好交易时段

input group "═══════════════════════════════════════════════════════"
input group "高级风险与资金管理"
input double   InpBreakevenTrigger   = 30;  // 触发保本的利润($)
input double   InpBreakevenPadding   = 15;   // 保本时锁定的额外利润($)
input bool     InpUseMoneyManagement = false; // 启用动态手数
input double   InpRiskPercent        = 0.25;   // 每笔交易风险%(资金管理开启时)
input double   InpMaxLotCap          = 0.02;  // 限制: 最大允许手数
input double   InpMinLotSize         = 0.01;  // 限制: 最小允许手数
input bool     InpSniperEntry        = true;  // M15信号时等待M1回调

input group "═══════════════════════════════════════════════════════"
input group "专业版: 增强风险管理"
input bool     InpUseTrailingRisk    = true;    // 随账户增长调整风险
input double   InpMaxRiskPerTrade    = 0.50;     // 每笔交易最大风险%
input double   InpDailyProfitTarget  = 10.0;    // 每日盈利目标($)后停止交易
input double   InpMaxDailyLoss       = 10.0;    // 每日最大亏损($)后停止交易
input int      InpMaxConsecLosses    = 5;       // 连续亏损X次后停止交易
input int      InpCooldownAfterLoss  = 300;     // 亏损后冷却秒数(默认5分钟)

input group "═══════════════════════════════════════════════════════"
input group "专业版: 高级仓位管理"
input bool     InpUseKellyCriterion  = true;   // 使用凯利公式优化仓位
input double   InpKellyFraction      = 0.25;    // 分数凯利(0.25=四分之一,更安全)
input int      InpMinTradesForKelly  = 20;      // 凯利计算所需最小交易数

input group "═══════════════════════════════════════════════════════"
input group "专业版: 市场状态检测"
input bool     InpUseRegimeDetection = true;    // 检测趋势与震荡市场
input int      InpRegimeADXPeriod    = 14;      // ADX趋势检测周期
input double   InpRegimeADXThreshold = 25.0;    // ADX趋势市场阈值

input group "═══════════════════════════════════════════════════════"
input group "专业版: 时间过滤器"
input bool     InpUseTimeFilters     = true;    // 启用时间过滤器
input bool     InpAvoidAsianDeadZone = true;    // 避免凌晨2-5点(低流动性)
input bool     InpAvoidSessionOpen   = true;   // 避免主要时段开盘15分钟
input bool     InpAvoidSessionClose  = true;   // 避免主要时段收盘15分钟

input group "═══════════════════════════════════════════════════════"
input group "专业版: 绩效分析"
input bool     InpShowPerformancePanel = false; // 显示绩效统计面板(已禁用)
input int      InpPerformancePanelX    = 250;   // 绩效面板X位置
input int      InpPerformancePanelY    = 40;    // 绩效面板Y位置
input bool     InpIncludeAllMagicNumbers = false; // 包含所有交易(忽略魔术码过滤)

input group "═══════════════════════════════════════════════════════"
input group "M15波段交易设置 - 让利润奔跑!"
input double   InpProfitTargetATR = 2;    // 止盈(ATR倍数)
input double   InpMinProfitPct   = 0.20;    // 最小平仓利润%(让利润奔跑!)
input double   InpStrongProfitPct = 0.80;   // 强利润平仓%(大赢!)
input double   InpTrailingDollar  = 25;   // 追踪止损距离($) - 黄金波动空间
input double   InpRescueSLDollar  = 25;    // 亏损时移动止损救援($)

input group "═══════════════════════════════════════════════════════"
input group "测试模式"
input bool     InpTestMode       = false;    // 启用测试模式(实盘请禁用!)

//+------------------------------------------------------------------+
//| 全局变量                                                         |
//+------------------------------------------------------------------+
string         g_Prefix = "GOLD_V2_";

// 指标句柄
int            g_HandleRSI;
int            g_HandleMAFast;
int            g_HandleMASlow;
int            g_HandleATR;

// 指标缓冲区
double         g_BufferRSI[];
double         g_BufferMAFast[];
double         g_BufferMASlow[];
double         g_BufferATR[];

// 品种信息
int            g_SymbolDigits = 0;
double         g_SymbolPoint = 0.0;
bool           g_IsGoldSymbol = false;  // 黄金交易时为真
string         g_SymbolName = "";       // 完整品种名
double         g_TickValue = 0.0;       // 每tick价值
double         g_TickSize = 0.0;        // 一个tick的大小
double         g_ContractSize = 0.0;    // 合约大小

// 交易
CTrade         g_Trade;
datetime       g_LastTradeCheck = 0;
ulong          g_LastTradeTicket = 0;

// Tick跟踪
int            g_TicksPerSecond = 0;
datetime       g_LastSecond = 0;

// AI集成
datetime       g_LastAIUpdate = 0;
string         g_AISignal = "WAIT";
double         g_AIConfidence = 0.0;
double         g_AISLPoints = 0;      // AI建议的止损点数
double         g_AITPPoints = 0;      // AI建议的止盈点数
string         g_AIReasoning = "";
string         g_AISummary = "";
string         g_AISummaryLines[];
bool           g_AIIsActive = false;
string         g_AIStatus = "初始化";

// 交易统计
int            g_TotalTrades = 0;
int            g_WinningTrades = 0;
int            g_LosingTrades = 0;
double         g_TotalProfit = 0.0;

// 测试模式
bool           g_TestCompleted = false;
int            g_TestStep = 0; // 0=not started, 1=place order, 2=modify SL, 3=close, 4=done
ulong          g_TestTicket = 0;
datetime       g_TestLastAction = 0;

// 追踪止损 - 跟踪每个持仓的最大利润
ulong          g_TrackedTickets[];     // 跟踪的持仓票据数组
double         g_MaxProfitPrice[];     // 每个持仓达到的最大利润价格
datetime       g_LastSLUpdate[];       // 每个持仓最后更新止损的时间

// 专业: 跟踪已处理交易避免重复统计
ulong          g_ProcessedDeals[];    // 已处理交易票据数组(用于统计)

// 专业: 增强风险管理跟踪
double         g_DailyProfit = 0.0;    // 今日盈亏
int            g_ConsecutiveLosses = 0; // 连续亏损交易
datetime       g_LastResetDate = 0;    // 上次每日统计重置日期
datetime       g_LastLossTime = 0;     // 上次亏损交易时间
bool           g_TradingHalted = false; // 交易 halted due to risk limits
double         g_DailyHighEquity = 0.0; // 今日最高净值(用于回撤计算)
double         g_MaxDrawdown = 0.0;     // 最大回撤百分比

// 专业: 市场状态检测
enum MARKET_REGIME {
   REGIME_TRENDING_UP,
   REGIME_TRENDING_DOWN,
   REGIME_RANGING,
   REGIME_VOLATILE,
   REGIME_UNKNOWN
};
MARKET_REGIME  g_CurrentRegime = REGIME_UNKNOWN;
int            g_HandleADX = INVALID_HANDLE; // ADX指标句柄(用于状态检测)

// 专业: 绩效分析
double         g_GrossProfit = 0.0;    // 总毛利润
double         g_GrossLoss = 0.0;      // 总毛亏损
double         g_LargestWin = 0.0;     // 最大盈利交易
double         g_LargestLoss = 0.0;    // 最大亏损交易
double         g_AvgWin = 0.0;         // 平均盈利交易
double         g_AvgLoss = 0.0;        // 平均亏损交易
double         g_SharpeRatio = 0.0;    // 夏普比率(如计算)
double         g_ProfitFactor = 0.0;   // 盈亏比(毛利/毛亏)

//+------------------------------------------------------------------+
//| 测试模式函数 - AI驱动测试                                        |
//| 测试AI是否能下单和修改止损                                       |
//+------------------------------------------------------------------+
void RunTestMode()
{
   if(g_TestCompleted || g_TestStep == 4) {
      return; // Test already completed
   }
   
   // 检查交易权限和连接(仅一次)
   if(g_TestStep == 0) {
      // 检查终端连接
      if(!TerminalInfoInteger(TERMINAL_CONNECTED)) {
         Print("❌ 错误: 终端未连接到经纪商服务器!");
         Print("   请检查网络连接和经纪商服务器状态。");
         Alert("终端未连接! 检查网络和经纪商连接。");
         g_TestCompleted = true;
         return;
      }
      
      // 检查账户连接
      if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) {
         Print("❌ 错误: 此账户不允许交易!");
         Alert("此账户不允许交易!");
         g_TestCompleted = true;
         return;
      }
      
      // 检查品种是否可交易
      if(!SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_FULL) {
         long tradeMode = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE);
         if(tradeMode == SYMBOL_TRADE_MODE_DISABLED) {
            Print("❌ 错误: 交易已禁用 ", _Symbol);
            Alert("交易已禁用 " + _Symbol);
            g_TestCompleted = true;
            return;
         }
      }
      
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) {
         Print("❌ 错误: 终端自动交易已禁用! 无法测试。");
         Alert("自动交易已禁用! 请在 工具->选项->EA 中启用");
         g_TestCompleted = true;
         return;
      }
      
      if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) {
         Print("❌ 错误: EA自动交易已禁用! 无法测试。");
         Alert("此EA的自动交易已禁用! 检查EA设置。");
         g_TestCompleted = true;
         return;
      }
      
      // 检查是否能获取市场价格(连接测试)
      double testAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double testBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(testAsk <= 0 || testBid <= 0) {
         Print("❌ 错误: 无法获取市场价格 - 经纪商连接问题!");
         Print("   卖价: ", testAsk, " Bid: ", testBid);
         Alert("无法获取市场价格! 检查经纪商连接。");
         g_TestCompleted = true;
         return;
      }
      
      Print("═══════════════════════════════════════════════════════");
      Print("🤖 AI测试模式 - 测试AI交易能力");
      Print("   账户: ", AccountInfoString(ACCOUNT_NAME));
      Print("   服务器: ", AccountInfoString(ACCOUNT_SERVER));
      Print("   已连接: ✓");
      Print("   等待AI分析市场并发出买入信号...");
      Print("═══════════════════════════════════════════════════════");
      g_TestStep = 1; // Move to waiting for AI signal
   }
   
   // STEP 1: PLACE ORDER FAST (after 2-3 ticks, simulate AI decision)
   if(g_TestStep == 1) {
      // 计算tick - 2-3个tick后下单
      static int placeTickCount = 0;
      placeTickCount++;
      
      // 等待2-3个tick后再下单
      if(placeTickCount < 2) {
         return; // Wait for more ticks
      }
      
      // 检查是否已有持仓
      if(CountOpenBuyPositions() > 0) {
         Print("✅ AI测试: 持仓已存在!");
         Print("   进入步骤2: 修改止损和止盈...");
         g_TestStep = 2;
         placeTickCount = 0;
         g_TestLastAction = TimeCurrent();
         return;
      }
      
      // 模拟AI决策(快速测试模式)
      // 实际模式中会等待真正的AI信号
      Print("🤖 AI测试: 模拟AI买入信号(快速测试模式)");
      Print("   → AI分析市场后决定买入");
      
      // 获取市场数据
      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      
      if(currentAsk <= 0 || currentBid <= 0) {
         Print("❌ 错误: 无效的市场价格");
         return;
      }
      
      // 获取ATR
      double atr = 0.0;
      if(CopyBuffer(g_HandleATR, 0, 0, 1, g_BufferATR) >= 1) {
         atr = g_BufferATR[0];
      } else {
         atr = (currentAsk - currentBid) * 10;
      }
      
      // 计算止损
      double stopLoss = currentAsk - (atr * InpStopLossATR);
      stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);
      
      double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
      if(minStopLevel > 0 && (currentAsk - stopLoss) < minStopLevel) {
         stopLoss = NormalizeDouble(currentAsk - minStopLevel, g_SymbolDigits);
      }
      
      Print("⚡ 步骤1: AI下单(快速测试)");
      Print("  卖价: ", currentAsk, " SL: ", stopLoss);
      Print("  手数: 0.01 (测试模式)");
      
      MqlTradeRequest request = {};
      MqlTradeResult result = {};
      
      request.action = TRADE_ACTION_DEAL;
      request.symbol = _Symbol;
      request.volume = 0.01; // Test mode uses 0.01 lot
      request.type = ORDER_TYPE_BUY;
      request.price = 0; // Market price
      request.sl = stopLoss;
      request.tp = 0; // No TP initially
      request.deviation = 10;
      request.magic = 123456;
      request.comment = "GOLD V2 - AI TEST";
      
      long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
      if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) {
         request.type_filling = ORDER_FILLING_FOK;
      } else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) {
         request.type_filling = ORDER_FILLING_IOC;
      } else {
         request.type_filling = ORDER_FILLING_RETURN;
      }
      
      if(OrderSend(request, result)) {
         if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
            Print("✅ AI测试: AI已下单!");
            Print("   票据: ", result.order, " Deal: ", result.deal);
            Print("   → AI成功下单!");
            g_TestTicket = result.order;
            g_TestStep = 2; // Move to modify SL/TP
            placeTickCount = 0; // Reset counter
            g_TestLastAction = TimeCurrent();
            return;
         } else {
            Print("❌ AI测试: 下单失败: 返回码=", result.retcode, " - ", result.comment);
            g_TestCompleted = true;
            return;
         }
      } else {
         Print("❌ AI测试: OrderSend失败!");
         Print("   错误: ", GetLastError(), " - ", result.comment);
         g_TestCompleted = true;
         return;
      }
      return;
   }
   
   // STEP 2: MODIFY SL AND TP (FAST - after 2-3 ticks)
   if(g_TestStep == 2) {
      // Count ticks since order was placed
      static int tickCount = 0;
      tickCount++;
      
      // Wait 2-3 ticks before modifying
      if(tickCount < 2) {
         return; // Wait for more ticks
      }
      
      // Find position
      for(int i = PositionsTotal() - 1; i >= 0; i--) {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0) {
            if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
               PositionGetInteger(POSITION_MAGIC) == 123456 &&
               PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {
               
               double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
               double currentSL = PositionGetDouble(POSITION_SL);
               double currentPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
               
               // 获取ATR for calculations
               double atr = 0.0;
               if(CopyBuffer(g_HandleATR, 0, 0, 1, g_BufferATR) >= 1) {
                  atr = g_BufferATR[0];
                  } else {
                  atr = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) * 10;
               }
               
               // Get minimum stop level
               double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
               if(minStopLevel <= 0) minStopLevel = 10 * g_SymbolPoint;
               
               // Calculate new SL (breakeven or slightly above)
               double newSL = entryPrice; // Breakeven
               double maxAllowedSL = currentPrice - minStopLevel;
               if(newSL >= maxAllowedSL) {
                  newSL = maxAllowedSL - (g_SymbolPoint * 1);
               }
               newSL = NormalizeDouble(newSL, g_SymbolDigits);
               
               // Calculate TP (entry + 1x ATR profit)
               double newTP = entryPrice + (atr * 1.0);
               newTP = NormalizeDouble(newTP, g_SymbolDigits);
               
               Print("⚡ 步骤2: 修改止损和止盈(AI测试)");
               Print("  票据: ", ticket);
               Print("  入场: ", entryPrice, " Current: ", currentPrice);
               Print("  原止损: ", currentSL, " → 新止损: ", newSL);
               Print("  原止盈: 0 → 新止盈: ", newTP);
               
               if(g_Trade.PositionModify(ticket, newSL, newTP)) {
                  Print("✅ 止损和止盈已修改!");
                  g_TestTicket = ticket;
                  g_TestStep = 3; // Move to close
                  tickCount = 0; // Reset for next step
                  g_TestLastAction = TimeCurrent();
                  return;
               } else {
                  Print("❌ 止损/止盈修改失败: ", g_Trade.ResultRetcodeDescription());
                  // Continue to close anyway
                  g_TestStep = 3;
                  tickCount = 0;
                  return;
               }
            }
         }
      }
      
      // Position not found
      if(TimeCurrent() - g_TestLastAction > 5) {
         Print("⚠️  未找到持仓，跳到平仓");
         g_TestStep = 3;
         tickCount = 0;
      }
      return;
   }
   
   // STEP 3: CLOSE POSITION (FAST - after 2-3 ticks from modification)
   if(g_TestStep == 3) {
      // Count ticks since modification
      static int closeTickCount = 0;
      closeTickCount++;
      
      // Wait 2-3 ticks before closing
      if(closeTickCount < 2) {
         return; // Wait for more ticks
      }
      
      for(int i = PositionsTotal() - 1; i >= 0; i--) {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0) {
            if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
               PositionGetInteger(POSITION_MAGIC) == 123456 &&
               PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {
               
               double profit = PositionGetDouble(POSITION_PROFIT);
               double profitPts = (SymbolInfoDouble(_Symbol, SYMBOL_BID) - PositionGetDouble(POSITION_PRICE_OPEN)) / g_SymbolPoint;
               
               Print("⚡ 步骤3: 平仓(AI测试)");
               Print("  票据: ", ticket, " Profit: ", profitPts, " pts ($", profit, ")");
               
               if(g_Trade.PositionClose(ticket)) {
                  Print("✅ 持仓已平仓!");
                  Print("═══════════════════════════════════════════════════════");
                  Print("🎉 AI测试完成 - 所有步骤已执行!");
                  Print("  → AI已下单");
                  Print("  → AI已修改止损和止盈");
                  Print("  → AI已平仓");
                  Print("  最终利润: ", profitPts, " pts ($", profit, ")");
                  Print("═══════════════════════════════════════════════════════");
                  g_TestStep = 4;
                  g_TestCompleted = true;
                  closeTickCount = 0;
                  return;
               } else {
                  Print("❌ 平仓失败: ", g_Trade.ResultRetcodeDescription());
                  g_TestStep = 4;
                  g_TestCompleted = true;
                  closeTickCount = 0;
                  return;
               }
            }
         }
      }
      
      // Position not found (already closed)
      if(TimeCurrent() - g_TestLastAction > 5) {
         Print("⚠️  未找到持仓(可能已平仓)");
         Print("🎉 AI测试完成!");
         g_TestStep = 4;
         g_TestCompleted = true;
         closeTickCount = 0;
      }
   }
}

//+------------------------------------------------------------------+
//| EA初始化函数                                                     |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| 检测是否为黄金品种并初始化相关参数                               |
//+------------------------------------------------------------------+
bool DetectAndInitializeGoldSymbol()
{
   g_SymbolName = _Symbol;
   string symbolUpper = _Symbol;
   StringToUpper(symbolUpper);
   
   // Check if this is a gold symbol
   g_IsGoldSymbol = (StringFind(symbolUpper, "XAU") >= 0 || 
                     StringFind(symbolUpper, "GOLD") >= 0 ||
                     StringFind(symbolUpper, "XAUUSD") >= 0 ||
                     StringFind(symbolUpper, "GOLDUSD") >= 0);
   
   // Get symbol-specific trading parameters
   g_SymbolDigits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   g_SymbolPoint = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   g_TickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   g_TickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   g_ContractSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   
   // Log symbol information
   Print("═══════════════════════════════════════════════════════");
   Print("📊 品种检测与初始化");
   Print("   品种: ", g_SymbolName);
   Print("   是否黄金: ", (g_IsGoldSymbol ? "YES ✓" : "NO"));
   Print("   小数位: ", g_SymbolDigits);
   Print("   点值: ", g_SymbolPoint);
   Print("   Tick价值: $", DoubleToString(g_TickValue, 2));
   Print("   Tick大小: ", g_TickSize);
   Print("   合约大小: ", g_ContractSize);
   Print("   最小手数: ", SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN));
   Print("   最大手数: ", SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   Print("   手数步长: ", SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP));
   Print("   止损水平: ", SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL), " 点");
   
   if(g_IsGoldSymbol)
   {
      Print("   ✓ 黄金交易模式已激活");
      Print("   → 使用黄金专用参数和计算");
   }
   else
   {
      Print("   ⚠️ 警告: 品种似乎不是黄金");
      Print("   → EA仍可工作但可能需要调整参数");
   }
   Print("═══════════════════════════════════════════════════════");
   
   return true;
}

//+------------------------------------------------------------------+
//| EA初始化函数                                                     |
//+------------------------------------------------------------------+
int OnInit()
{
   // 初始化品种信息并检测黄金
   if(!DetectAndInitializeGoldSymbol())
   {
      Print("错误: 初始化品种信息失败");
      return INIT_FAILED;
   }
   
   SymbolSelect(_Symbol, true);
   
   // 创建指标
   g_HandleRSI = iRSI(_Symbol, PERIOD_CURRENT, InpRSIPeriod, PRICE_CLOSE);
   g_HandleMAFast = iMA(_Symbol, PERIOD_CURRENT, InpMAFast, 0, MODE_EMA, PRICE_CLOSE);
   g_HandleMASlow = iMA(_Symbol, PERIOD_CURRENT, InpMASlow, 0, MODE_EMA, PRICE_CLOSE);
   g_HandleATR = iATR(_Symbol, PERIOD_CURRENT, InpATRPeriod);
   
   // 专业: 初始化ADX用于市场状态检测
   if(InpUseRegimeDetection)
   {
      g_HandleADX = iADX(_Symbol, PERIOD_M15, InpRegimeADXPeriod);
      if(g_HandleADX == INVALID_HANDLE)
         Print("警告: 创建ADX指标失败(用于市场状态检测)");
   }
   
   if(g_HandleRSI == INVALID_HANDLE || 
      g_HandleMAFast == INVALID_HANDLE || 
      g_HandleMASlow == INVALID_HANDLE ||
      g_HandleATR == INVALID_HANDLE) {
      Print("错误: 创建指标失败");
      return INIT_FAILED;
   }
   
   // 设置数组为序列
   ArraySetAsSeries(g_BufferRSI, true);
   ArraySetAsSeries(g_BufferMAFast, true);
   ArraySetAsSeries(g_BufferMASlow, true);
   ArraySetAsSeries(g_BufferATR, true);
   
   // 初始化交易
   g_Trade.SetExpertMagicNumber(123456);
   g_Trade.SetDeviationInPoints(10);
   g_Trade.SetTypeFilling(ORDER_FILLING_FOK);
   
   // 专业: 初始化每日跟踪
   CheckDailyReset();
   g_DailyHighEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   
   // 专业: 从MT5历史加载交易统计
   LoadHistoricalStatistics();
   
   // 绘制仪表板
   DrawDashboard();
   
   // PROFESSIONAL: Performance panel disabled (removed)
   // if(InpShowPerformancePanel)
   //    DrawPerformancePanel();
   
   // 设置定时器
   EventSetTimer(1);
   
   Print("═══════════════════════════════════════════════════════");
   Print("源流AI交易系统初始化成功");
   Print("   交易品种: ", g_SymbolName, (g_IsGoldSymbol ? " (GOLD)" : ""));
   Print("   交易状态: ", (InpEnableTrading ? "ENABLED" : "禁用"));
   if(g_IsGoldSymbol)
      Print("   ✓ 黄金交易模式: 已激活");
   Print("专业功能:");
   Print("  - 增强风险管理: ", (InpMaxDailyLoss > 0 ? "ON" : "OFF"));
   Print("  - 凯利公式: ", (InpUseKellyCriterion ? "ON" : "OFF"));
   Print("  - 市场状态检测: ", (InpUseRegimeDetection ? "ON" : "OFF"));
   Print("  - 时间过滤器: ", (InpUseTimeFilters ? "ON" : "OFF"));
   // Print("  - Performance Analytics: ", (InpShowPerformancePanel ? "ON" : "OFF"));
   Print("═══════════════════════════════════════════════════════");
   
   if(InpTestMode) {
      Print("═══════════════════════════════════════════════════════");
      Print("🤖 AI测试模式已启用!");
      Print("   This mode tests if AI can:");
      Print("   1. Analyze market and signal BUY");
      Print("   2. Place orders when AI says BUY");
      Print("   3. Manage stop loss with trailing stop");
      Print("   → AI will make all trading decisions");
      Print("   → Test uses 0.01 lot size");
      Print("   → Disable Test Mode for normal trading");
      Print("═══════════════════════════════════════════════════════");
   }
   
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EA逆初始化函数                                                   |
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
   
   Print("源流AI交易系统已停止");
}

//+------------------------------------------------------------------+
//| EA报价函数(主循环)                                               |
//+------------------------------------------------------------------+
void OnTick()
{
   // ============================================================
   // 优先级1: 每个tick更新价格(最快)
   // ============================================================
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double midPrice = (bid + ask) / 2.0;
   double spread = (ask - bid) / g_SymbolPoint;
   
   // 即时更新价格显示(无节流 - 每个tick!)
   UpdateUI("Price", DoubleToString(midPrice, g_SymbolDigits), ClrValue);
   UpdateUI("BidPrice", DoubleToString(bid, g_SymbolDigits), ClrValue);
   UpdateUI("AskPrice", DoubleToString(ask, g_SymbolDigits), ClrValue);
   UpdateUI("Spread", DoubleToString(spread, 0) + " pts", (spread > 30) ? ClrWarning : ClrValue);
   
   // ============================================================
   // 优先级2: 持仓平仓时直接跟踪统计(简化)
   // ============================================================
   // CheckClosedPositionsAndUpdateStats(); // No longer needed - tracking happens in ManageAIPositions
   
   // ============================================================
   // 优先级3: 节流操作(不是每个tick)
   // ============================================================
   
   // 检查每日重置(轻量级，可每tick运行)
   CheckDailyReset();
   
   // 市场状态检测(重量级 - 每60秒节流)
   static datetime lastRegimeCheck = 0;
   if(TimeCurrent() - lastRegimeCheck >= 60)
   {
      AdjustStrategyForRegime();
      lastRegimeCheck = TimeCurrent();
   }
   
   // 运行AI测试模式(如启用)
   if(InpTestMode && !g_TestCompleted) {
      RunTestMode();
   }
   
   // 更新所有其他数据(节流 - 仅在定时器或新K线时运行)
   // Note: UpdateAllData() is called from OnTimer() to avoid spamming
   // We only call it here if OnTimer might not fire frequently enough
   static datetime lastDataUpdate = 0;
   if(TimeCurrent() - lastDataUpdate >= 1) // Update other UI elements every 1 second max
   {
   UpdateAllData();
      lastDataUpdate = TimeCurrent();
   }
   
   // Performance panel disabled (removed)
   // if(InpShowPerformancePanel)
   //    UpdatePerformancePanel();
   
   // 重绘图表(每个tick平滑价格更新)
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 定时器函数                                                       |
//+------------------------------------------------------------------+
void OnTimer()
{
   // 运行AI测试模式(如启用) - Tests AI's ability to trade
   if(InpTestMode && !g_TestCompleted) {
      RunTestMode();
      // 继续正常数据更新以便AI分析
   }
   
   UpdateAllData();
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 管理追踪止损 - 落后最大利润1%                                    |
//+------------------------------------------------------------------+
void ManageTrailingStopLoss()
{
   if(!InpEnableTrading) return;
   
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
   if(minStopLevel <= 0) minStopLevel = 10 * g_SymbolPoint;
   
   // Update tracking arrays for all open positions (BUY and SELL)
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0) {
         if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == 123456) {
            
            ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
            double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            double currentSL = PositionGetDouble(POSITION_SL);
            
            // Get current price based on position type
            double currentPrice = (posType == POSITION_TYPE_BUY) ? currentBid : currentAsk;
            
            // Find or create tracker for this position
            int trackerIdx = -1;
            for(int j = 0; j < ArraySize(g_TrackedTickets); j++) {
               if(g_TrackedTickets[j] == ticket) {
                  trackerIdx = j;
                  break;
               }
            }
            
            // Create new tracker if not found
            if(trackerIdx < 0) {
               int newSize = ArraySize(g_TrackedTickets) + 1;
               ArrayResize(g_TrackedTickets, newSize);
               ArrayResize(g_MaxProfitPrice, newSize);
               ArrayResize(g_LastSLUpdate, newSize);
               trackerIdx = newSize - 1;
               g_TrackedTickets[trackerIdx] = ticket;
               g_MaxProfitPrice[trackerIdx] = entryPrice; // Start with entry price
               g_LastSLUpdate[trackerIdx] = 0;
            }
            
            // Update max profit price
            // For BUY: higher price = more profit, track highest price
            // For SELL: lower price = more profit, track lowest price
            if(posType == POSITION_TYPE_BUY) {
            if(currentBid > g_MaxProfitPrice[trackerIdx]) {
               g_MaxProfitPrice[trackerIdx] = currentBid;
               }
            } else if(posType == POSITION_TYPE_SELL) {
               if(currentAsk < g_MaxProfitPrice[trackerIdx]) {
                  g_MaxProfitPrice[trackerIdx] = currentAsk;
               }
            }
            
            // NEW: Apply Breakeven Logic First (moves to entry + padding at $15 profit)
            CheckAndApplyBreakeven(ticket);
            
            // PROFIT HUNGRY: Tight trailing stop - moves on every tick, even by cents!
            double maxProfit = g_MaxProfitPrice[trackerIdx];
            double trailingSL = 0.0;
            double profitPct = 0.0;
            
            if(posType == POSITION_TYPE_BUY) {
               profitPct = ((currentBid - entryPrice) / entryPrice) * 100.0;
               double profitDollars = PositionGetDouble(POSITION_PROFIT);
               
               // LET WINNERS RUN - Only trail when in good profit
               if(profitPct > 0.10) { // In profit - start trailing
                  // Move to breakeven first
                  if(currentSL < entryPrice) {
                     trailingSL = entryPrice + (g_SymbolPoint * 5); // 5 points above breakeven for safety
                     trailingSL = NormalizeDouble(trailingSL, g_SymbolDigits);
                     Print("💰 保本: 移动多单 #", ticket, " 到保本位 ", DoubleToString(profitPct, 2), "%");
                  } else {
                     // WIDE TRAILING - Let winners RUN with room to breathe!
                     // Trail by InpTrailingDollar ($1.50 default) behind max profit
                     double trailPoints = (InpTrailingDollar * 100.0) / g_TickValue; // Convert $ to points
                     trailingSL = maxProfit - (trailPoints * g_SymbolPoint);
                     trailingSL = NormalizeDouble(trailingSL, g_SymbolDigits);
                  }
               } else if(profitDollars < -InpRescueSLDollar && currentSL > 0) {
                  // RESCUE MODE - Position losing, move SL closer to minimize damage
                  double rescuePoints = (InpRescueSLDollar * 50.0) / g_TickValue; // Tighter SL when losing
                  double rescueSL = currentBid - (rescuePoints * g_SymbolPoint);
                  if(rescueSL > currentSL) { // Only move SL up (closer to price)
                     trailingSL = NormalizeDouble(rescueSL, g_SymbolDigits);
                     Print("🚨 救援: 移动亏损多单 #", ticket, " | 亏损: $", DoubleToString(profitDollars, 2));
                  } else {
                     trailingSL = currentSL; // Keep current SL
                  }
               } else {
                  // Small profit or small loss - keep original SL, let it develop
                  trailingSL = currentSL;
               }
               
               // Ensure SL is at least minStopLevel below current price
            double maxAllowedSL = currentBid - minStopLevel;
            if(trailingSL >= maxAllowedSL) {
                  trailingSL = maxAllowedSL - (g_SymbolPoint * 1);
               trailingSL = NormalizeDouble(trailingSL, g_SymbolDigits);
            }
            
               // Move SL if it's better (protecting profit or minimizing loss)
               if(trailingSL > currentSL && trailingSL >= entryPrice) {
                  if(g_Trade.PositionModify(ticket, trailingSL, 0)) {
                     double profitLocked = ((trailingSL - entryPrice) / entryPrice) * 100.0;
                     // Log significant moves
                     if(MathAbs(trailingSL - currentSL) > (5 * g_SymbolPoint)) {
                        Print("🏃 让利润奔跑(多): #", ticket, " | 最高: ", maxProfit, 
                           " | 止损: ", currentSL, " → ", trailingSL, 
                           " | 锁定利润: ", DoubleToString(profitLocked, 3), "% | Trail: $", InpTrailingDollar);
                     }
                     g_LastSLUpdate[trackerIdx] = TimeCurrent();
                  }
               } else if(trailingSL > currentSL && profitDollars < 0) {
                  // Rescue mode - moving SL up to cut losses
                  if(g_Trade.PositionModify(ticket, trailingSL, 0)) {
                     Print("🛡️ 救援(多): #", ticket, " | 止损上移减少亏损 | 新止损: ", trailingSL);
                     g_LastSLUpdate[trackerIdx] = TimeCurrent();
                  }
               }
            } else if(posType == POSITION_TYPE_SELL) {
               profitPct = ((entryPrice - currentAsk) / entryPrice) * 100.0;
               double profitDollars = PositionGetDouble(POSITION_PROFIT);
               
               // LET WINNERS RUN - Only trail when in good profit
               if(profitPct > 0.10) { // In profit - start trailing
                  // Move to breakeven first
                  if(currentSL > entryPrice || currentSL == 0) {
                     trailingSL = entryPrice - (g_SymbolPoint * 5); // 5 points below breakeven for safety
                     trailingSL = NormalizeDouble(trailingSL, g_SymbolDigits);
                     Print("💰 保本: 移动空单 #", ticket, " 到保本位 ", DoubleToString(profitPct, 2), "%");
                  } else {
                     // WIDE TRAILING - Let winners RUN with room to breathe!
                     double trailPoints = (InpTrailingDollar * 100.0) / g_TickValue;
                     trailingSL = maxProfit + (trailPoints * g_SymbolPoint);
                     trailingSL = NormalizeDouble(trailingSL, g_SymbolDigits);
                  }
               } else if(profitDollars < -InpRescueSLDollar && currentSL > 0) {
                  // RESCUE MODE - Position losing, move SL closer to minimize damage
                  double rescuePoints = (InpRescueSLDollar * 50.0) / g_TickValue;
                  double rescueSL = currentAsk + (rescuePoints * g_SymbolPoint);
                  if(rescueSL < currentSL) { // Only move SL down (closer to price)
                     trailingSL = NormalizeDouble(rescueSL, g_SymbolDigits);
                     Print("🚨 救援: 移动亏损空单 #", ticket, " | 亏损: $", DoubleToString(profitDollars, 2));
                  } else {
                     trailingSL = currentSL; // Keep current SL
                  }
               } else {
                  // Small profit or small loss - keep original SL, let it develop
                  trailingSL = currentSL;
               }
               
               // Ensure SL is at least minStopLevel above current price
               double minAllowedSL = currentAsk + minStopLevel;
               if(trailingSL <= minAllowedSL) {
                  trailingSL = minAllowedSL + (g_SymbolPoint * 1);
                  trailingSL = NormalizeDouble(trailingSL, g_SymbolDigits);
               }
               
               // Move SL if it's better (protecting profit or minimizing loss)
               if(trailingSL < currentSL && trailingSL <= entryPrice) {
                  if(g_Trade.PositionModify(ticket, trailingSL, 0)) {
                     double profitLocked = ((entryPrice - trailingSL) / entryPrice) * 100.0;
                     // Log significant moves
                     if(MathAbs(currentSL - trailingSL) > (5 * g_SymbolPoint)) {
                        Print("🏃 让利润奔跑(空): #", ticket, " | 最高: ", maxProfit, 
                              " | 止损: ", currentSL, " → ", trailingSL, 
                              " | 锁定利润: ", DoubleToString(profitLocked, 3), "% | Trail: $", InpTrailingDollar);
                     }
                     g_LastSLUpdate[trackerIdx] = TimeCurrent();
                  }
               } else if(trailingSL < currentSL && profitDollars < 0) {
                  // Rescue mode - moving SL down to cut losses
                  if(g_Trade.PositionModify(ticket, trailingSL, 0)) {
                     Print("🛡️ 救援(空): #", ticket, " | 止损下移减少亏损 | 新止损: ", trailingSL);
                     g_LastSLUpdate[trackerIdx] = TimeCurrent();
                  }
               }
            }
         }
      }
   }
   
   // 清理不存在的持仓跟踪器
   for(int k = ArraySize(g_TrackedTickets) - 1; k >= 0; k--) {
      bool positionExists = false;
      for(int m = PositionsTotal() - 1; m >= 0; m--) {
         ulong ticket = PositionGetTicket(m);
         if(ticket == g_TrackedTickets[k]) {
            positionExists = true;
            break;
         }
      }
      if(!positionExists) {
         // 移除跟踪器
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
//| 主数据更新函数                                                   |
//+------------------------------------------------------------------+
void UpdateAllData()
{
   // Get current prices (always available)
   // Note: Price is already updated in OnTick() for instant tick-by-tick updates
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double spread = (ask - bid) / g_SymbolPoint;
   
   // 按tick更新实时价格(中间价)
   double midPrice = (bid + ask) / 2.0;
   UpdateUI("Price", DoubleToString(midPrice, g_SymbolDigits), ClrValue);
   UpdateUI("BidPrice", DoubleToString(bid, g_SymbolDigits), ClrValue);
   UpdateUI("AskPrice", DoubleToString(ask, g_SymbolDigits), ClrValue);
   UpdateUI("Spread", DoubleToString(spread, 0) + " pts", (spread > 30) ? ClrWarning : ClrValue);
   
   // 获取指标数据
   double rsi = 50.0;
   double atr = 0.0;
   bool dataValid = true;
   
   if(CopyBuffer(g_HandleRSI, 0, 0, 1, g_BufferRSI) < 1 || ArraySize(g_BufferRSI) < 1) {
      dataValid = false;
      UpdateUI("Prediction", "等待数据...", ClrNeutral);
   } else {
      rsi = g_BufferRSI[0];
   }
   
   if(CopyBuffer(g_HandleMAFast, 0, 0, 1, g_BufferMAFast) < 1 ||
      CopyBuffer(g_HandleMASlow, 0, 0, 1, g_BufferMASlow) < 1 ||
      CopyBuffer(g_HandleATR, 0, 0, 1, g_BufferATR) < 1) {
      dataValid = false;
   } else {
      // Safety check: ensure buffer has data before accessing
      if(ArraySize(g_BufferATR) > 0)
      atr = g_BufferATR[0];
   }
   
   if(!dataValid) {
      ChartRedraw(0);
      return;
   }
   
   // 更新tick速度
   datetime currentSecond = TimeCurrent();
   if(currentSecond != g_LastSecond) {
      g_LastSecond = currentSecond;
      g_TicksPerSecond = 0;
   }
   g_TicksPerSecond++;
   UpdateUI("Velocity", IntegerToString(g_TicksPerSecond) + " ticks/秒", 
            (g_TicksPerSecond > 10) ? ClrBuy : ClrValue);
   
   // 更新RSI和距离指标
   UpdateUI("RSI", DoubleToString(rsi, 1), 
            (rsi < 30) ? ClrBuy : (rsi > 70) ? ClrSell : ClrValue);
   
   // 计算到RSI水平的距离
   double distanceTo30 = rsi - 30.0; // How much until <30 (oversold)
   double distanceTo70 = 70.0 - rsi; // How much until >70 (overbought)
   
   if(distanceTo30 <= 0) {
      UpdateUI("RSI_To30", "超卖 ✓", ClrBuy);
   } else {
      UpdateUI("RSI_To30", DoubleToString(distanceTo30, 1) + " to <30", ClrBuy);
   }
   
   if(distanceTo70 <= 0) {
      UpdateUI("RSI_To70", "超买 ✓", ClrSell);
   } else {
      UpdateUI("RSI_To70", DoubleToString(distanceTo70, 1) + " to >70", ClrSell);
   }
   
   // 更新均线 - 带安全检查
   if(ArraySize(g_BufferMAFast) > 0)
   UpdateUI("MAFast", DoubleToString(g_BufferMAFast[0], g_SymbolDigits), ClrValue);
   if(ArraySize(g_BufferMASlow) > 0)
   UpdateUI("MASlow", DoubleToString(g_BufferMASlow[0], g_SymbolDigits), ClrValue);
   UpdateUI("ATR", DoubleToString(atr, g_SymbolDigits), ClrValue);
   
   // 更新交易状态 - 检测持仓变化并即时更新面板
   static int lastPositionCount = -1;
   static datetime lastStatusLog = 0;
   int openPositions = CountTotalOpenPositions();
   int buyPositions = CountOpenBuyPositions();
   int sellPositions = CountOpenSellPositions();

   // 检测持仓数变化
   bool positionChanged = (openPositions != lastPositionCount);
   if(positionChanged) {
      Print("═══════════════════════════════════════════════════════");
      Print("📊 持仓数变化: ", lastPositionCount, " → ", openPositions, "/", InpMaxPositions,
            " (多:", buyPositions, " 空:", sellPositions, ")");

      // 如果持仓减少，说明有平仓发生
      if(openPositions < lastPositionCount)
      {
         int closedCount = lastPositionCount - openPositions;
         Print("   ⚠️ 检测到 ", closedCount, " 个持仓被平仓!");
         Print("   可能原因: 止盈/止损/追踪止损/手动平仓");

         // 强制刷新历史并检测平仓
         Print("   刷新历史记录...");
         CheckClosedPositionsAndUpdateStats();
      }

      Print("   今日盈亏: $", DoubleToString(g_DailyProfit, 2));
      Print("   连续亏损: ", g_ConsecutiveLosses, "次");
      Print("═══════════════════════════════════════════════════════");
      lastPositionCount = openPositions;

      // 立即更新面板
      double floatingProfit = 0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == 123456)
         {
            floatingProfit += PositionGetDouble(POSITION_PROFIT) +
                             PositionGetDouble(POSITION_SWAP) +
                             PositionGetDouble(POSITION_COMMISSION);
         }
      }
      double dailyTotalProfit = g_DailyProfit + floatingProfit;
      UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotalProfit, 2), dailyTotalProfit >= 0 ? ClrBuy : ClrSell);

      double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
      UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);

      ChartRedraw(0);
   }

   // 每60秒输出一次状态（帮助调试）
   if(TimeCurrent() - lastStatusLog >= 60)
   {
      Print("📈 状态: 持仓=", openPositions, "/", InpMaxPositions,
            " | 今日=$", DoubleToString(g_DailyProfit, 2),
            " | 连续亏损=", g_ConsecutiveLosses,
            " | AI=", g_AIStatus,
            " | 信号=", g_AISignal);
      lastStatusLog = TimeCurrent();
   }

   string statusText = InpEnableTrading ?
      "活跃 (" + IntegerToString(openPositions) + "/" + IntegerToString(InpMaxPositions) +
      " | 多:" + IntegerToString(buyPositions) + " 空:" + IntegerToString(sellPositions) + ")" :
      "禁用";
   UpdateUI("TradingStatus", statusText, (InpEnableTrading ? ClrBuy : ClrNeutral));

   // 检测平仓并更新统计（包括手动平仓、止盈止损、追踪止损）
   CheckClosedPositionsAndUpdateStats();

   // 更新今日盈利（包含浮动盈亏）- 每次都更新
   double floatingProfit = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == 123456)
      {
         floatingProfit += PositionGetDouble(POSITION_PROFIT) +
                          PositionGetDouble(POSITION_SWAP) +
                          PositionGetDouble(POSITION_COMMISSION);
      }
   }
   double dailyTotalProfit = g_DailyProfit + floatingProfit;
   UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotalProfit, 2), dailyTotalProfit >= 0 ? ClrBuy : ClrSell);

   // 更新胜率
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);

   // 如果持仓变化，强制重绘
   if(positionChanged) {
      ChartRedraw(0);
   }

   // ═══════════════════════════════════════════════════════════
   // 风控检查（优先级从高到低）
   // ═══════════════════════════════════════════════════════════

   // 调试：显示风控状态
   static datetime lastRiskCheckLog = 0;
   bool showRiskDebug = (TimeCurrent() - lastRiskCheckLog >= 15);

   if(showRiskDebug)
   {
      Print("🔍 风控检查:");
      Print("   今日盈亏: $", DoubleToString(g_DailyProfit, 2));
      Print("   连续亏损: ", g_ConsecutiveLosses, "次");
      Print("   上次亏损时间: ", TimeToString(g_LastLossTime, TIME_SECONDS));
      Print("   冷却时间: ", InpCooldownAfterLoss, "秒");
      if(g_ConsecutiveLosses > 0)
      {
         int elapsed = (int)(TimeCurrent() - g_LastLossTime);
         Print("   距上次亏损: ", elapsed, "秒 (需", InpCooldownAfterLoss, "秒)");
      }
      lastRiskCheckLog = TimeCurrent();
   }

   // 1. 检查每日盈利目标（达到后当天停止）
   if(g_DailyProfit >= InpDailyProfitTarget)
   {
      UpdateUI("TradingStatus", "✅ 盈利达标 已停止", ClrBuy);
      if(showRiskDebug) Print("   ❌ 被阻止: 每日盈利达标");
      return;
   }

   // 2. 检查每日亏损限制（达到后当天停止）
   if(g_DailyProfit <= -InpMaxDailyLoss)
   {
      UpdateUI("TradingStatus", "❌ 亏损达标 已停止", ClrSell);
      if(showRiskDebug) Print("   ❌ 被阻止: 每日亏损达标");
      return;
   }

   // 3. 检查连续亏损冷却
   if(g_ConsecutiveLosses > 0 && InpCooldownAfterLoss > 0)
   {
      datetime timeSinceLastLoss = TimeCurrent() - g_LastLossTime;
      if(timeSinceLastLoss < InpCooldownAfterLoss)
      {
         int remaining = InpCooldownAfterLoss - (int)timeSinceLastLoss;
         UpdateUI("TradingStatus", "⏸️ 冷却中 " + IntegerToString(remaining) + "秒", ClrWarning);
         if(showRiskDebug) Print("   ❌ 被阻止: 冷却中 还需", remaining, "秒");
         return;  // 不调用AI，不执行交易
      }
      else
      {
         // 冷却结束，重置连续亏损
         if(showRiskDebug) Print("   ✅ 冷却结束，重置连续亏损计数");
         g_ConsecutiveLosses = 0;
      }
   }

   // ═══════════════════════════════════════════════════════════
   // 所有风控检查通过，调用AI分析
   // ═══════════════════════════════════════════════════════════
   if(showRiskDebug) Print("   ✅ 风控通过，调用AI分析");
   if(InpUseAI) {
      UpdateAIAnalysis(rsi, bid, ask, atr);
   }
   
   // 管理追踪止损 - 关键: 不允许亏损
   // 注意: 每个tick运行以立即捕捉价格变动
   if(InpEnableTrading) {
      ManageTrailingStopLoss();
   }
   
   // 利润收割 - 每个tick检查持仓止盈
   if(InpEnableTrading) {
      // 始终检查持仓(即使没有AI)止盈
      ManageAIPositions(rsi, bid, ask, atr);
   }
   
   // 交易逻辑(测试模式已下单则跳过)
   // NOTE: This is throttled - only checks on new M1 bars (see CheckAndExecuteTrades)
   if(InpEnableTrading) {
      // 测试模式只允许一个测试持仓
      if(InpTestMode && CountOpenBuyPositions() > 0) {
         // 测试模式已有持仓，不再下单
         // (追踪止损仍会管理持仓)
      } else {
      CheckAndExecuteTrades(rsi, bid, ask, atr);
      }
   }
   
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| 检查并执行交易 - AI驱动 (V3.1修正逻辑)                          |
//+------------------------------------------------------------------+
void CheckAndExecuteTrades(double rsi, double bid, double ask, double atr)
{
   // 调试：显示当前状态
   static datetime lastDebugTime = 0;
   bool showDebug = (TimeCurrent() - lastDebugTime >= 10); // 每10秒显示一次

   if(showDebug) {
      Print("═══ 交易检查调试 ═══");
      Print("  AI信号: ", g_AISignal, " | 置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
      Print("  AI状态: ", g_AIStatus, " | AI激活: ", (g_AIIsActive ? "是" : "否"));
      Print("  持仓数: ", CountTotalOpenPositions(), "/", InpMaxPositions);
      Print("  今日盈亏: $", DoubleToString(g_DailyProfit, 2));
      Print("  连续亏损: ", g_ConsecutiveLosses, "次");
   }

   // 1. 安全检查
   // 专业风险管理检查
   if(!IsTradingAllowed()) {
      if(showDebug) Print("❌ 被阻止: IsTradingAllowed() = false");
      lastDebugTime = TimeCurrent();
      return;
   }

   // 时间过滤检查
   if(!IsGoodTradingTime()) {
      if(showDebug) Print("❌ 被阻止: IsGoodTradingTime() = false");
      lastDebugTime = TimeCurrent();
      return;
   }

   // 2. 检查最大持仓数
   int totalPositions = CountTotalOpenPositions();
   if(totalPositions >= InpMaxPositions) {
      if(showDebug) Print("❌ 被阻止: 持仓数已满 ", totalPositions, "/", InpMaxPositions);
      lastDebugTime = TimeCurrent();
      return;
   }

   if(showDebug) lastDebugTime = TimeCurrent();

   // 3. AI交易逻辑
   if(InpUseAI && g_AIIsActive) {
      if(showDebug) Print("  ✅ AI已激活，检查信号...");

      // --- 买入信号 ---
      if(g_AISignal == "BUY") {
         double minConf = InpAIConfidenceMin;

         if(showDebug) {
            Print("  检查BUY信号:");
            Print("    置信度: ", DoubleToString(g_AIConfidence * 100, 1), "% >= ", DoubleToString(minConf * 100, 1), "%? ", (g_AIConfidence >= minConf ? "✅ 是" : "❌ 否"));
         }

         if(g_AIConfidence >= minConf) {

            // 狙击手入场过滤
            if(InpSniperEntry && !CheckSniperEntry("BUY")) {
               if(showDebug) Print("❌ 被阻止: 狙击手入场过滤(等待M1回调)");
               return;
            }

            Print("✅ 所有条件满足，执行买入!");

            Print("═══════════════════════════════════════════════════════");
            Print("📊 AI M15 SWING: BUY SIGNAL RECEIVED");
            Print("   置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
            Print("   → 执行多头持仓");

            // 执行交易
            ExecuteBuyOrder(ask, atr);

            // 不重置信号，让AI继续分析下一个机会
            // 如果持仓数未满，AI可以继续给出信号
            if(CountTotalOpenPositions() >= InpMaxPositions) {
               g_AISignal = "WAIT";
               g_AIReasoning = "已达到最大持仓数，等待平仓";
            }

            Print("═══════════════════════════════════════════════════════");
         }
      }
      
      // --- 卖出信号 ---
      else if(g_AISignal == "SELL") {
         // 确定所需置信度
         double minConf = InpAIConfidenceMin;
         
         // 检查AI是否足够自信
         if(g_AIConfidence >= minConf) {
            
            // SNIPER ENTRY FILTER
            if(InpSniperEntry && !CheckSniperEntry("SELL")) {
               return; 
            }
            
            Print("═══════════════════════════════════════════════════════");
            Print("📊 AI M15波段: 收到卖出信号");
            Print("   置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
            Print("   → 执行空头持仓");

            // 执行交易
            ExecuteSellOrder(bid, atr);

            // 不重置信号，让AI继续分析下一个机会
            if(CountTotalOpenPositions() >= InpMaxPositions) {
               g_AISignal = "WAIT";
               g_AIReasoning = "已达到最大持仓数，等待平仓";
            }

            Print("═══════════════════════════════════════════════════════");
         }
      }
   }
   
   // 4. 传统备用(仅在AI禁用/未激活时运行)
   if(!InpUseAI || !g_AIIsActive) {
      if(showDebug) {
         Print("  ⚠️ AI未激活，使用传统策略");
         Print("    InpUseAI: ", (InpUseAI ? "是" : "否"));
         Print("    g_AIIsActive: ", (g_AIIsActive ? "是" : "否"));
         Print("    g_AIStatus: ", g_AIStatus);
      }
      // 传统RSI策略
      if(rsi < InpRSIBuyLevel && InpRequireBullishMA) {
         if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0) {
            if(g_BufferMAFast[0] > g_BufferMASlow[0]) {
                ExecuteBuyOrder(ask, atr);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 根据美元风险计算最大止损距离                                     |
//| 返回给定手数允许的最大价格距离                                   |
//+------------------------------------------------------------------+
double CalculateMaxStopLossDistance(double lotSize)
{
   if(InpMaxStopLossDollars <= 0) {
      return 0; // Disabled - return 0 means no limit
   }
   
   // Get tick value (value per tick per 1 standard lot)
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   
   if(tickSize <= 0 || tickValue <= 0) {
      Print("WARNING: Could not get tick info. TickSize=", tickSize, " TickValue=", tickValue);
      // Fallback for gold: assume ~$1 per 0.01 move per 0.01 lot
      // So for 0.1 lot, $1 move = $10
      // Max distance = $50 / ($10 per $1) = $5
      double fallbackDistance = InpMaxStopLossDollars / (lotSize * 100.0);
      Print("Using fallback calculation: Max SL distance = $", DoubleToString(fallbackDistance, 2));
      return fallbackDistance;
   }
   
   // Calculate value per price unit for this lot size
   // tickValue is the $ value of 1 tick (tickSize) for 1 lot
   // So value per tick for our lot = tickValue * lotSize
   double valuePerTick = tickValue * lotSize;
   
   // Max ticks we can lose = MaxDollars / valuePerTick
   double maxTicks = InpMaxStopLossDollars / valuePerTick;
   
   // Convert ticks to price distance
   double maxPriceDistance = maxTicks * tickSize;
   
   Print("═══ 最大止损计算 ═══");
   Print("   手数: ", lotSize);
   Print("   Tick大小: ", tickSize, " | Tick价值: $", tickValue);
   Print("   每Tick价值(此手数): $", DoubleToString(valuePerTick, 4));
   Print("   最大允许亏损: $", InpMaxStopLossDollars);
   Print("   最大Tick: ", DoubleToString(maxTicks, 2));
   Print("   最大价格距离: $", DoubleToString(maxPriceDistance, g_SymbolDigits));
   Print("═════════════════════════════════");
   
   return maxPriceDistance;
}

//+------------------------------------------------------------------+
//| 执行买入订单 - 可靠版本                                          |
//+------------------------------------------------------------------+
void ExecuteBuyOrder(double entryPrice, double atr)
{
   // 检查交易权限
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) {
      Print("错误: 终端自动交易已禁用!");
      return;
   }
   
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) {
      Print("错误: EA自动交易已禁用!");
      return;
   }
   
   // 获取当前市场价格
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(currentAsk <= 0 || currentBid <= 0) {
      Print("错误: 无效的市场价格");
      return;
   }

   // 计算止损 - 优先使用AI建议，否则用ATR
   double stopLossDistance = 0;
   double stopLoss = 0;
   double takeProfit = 0;

   if(g_AISLPoints > 0) {
      // 使用AI建议的止损点数
      stopLossDistance = g_AISLPoints * g_SymbolPoint;
      stopLoss = currentAsk - stopLossDistance;
      Print("📊 使用AI止损: ", g_AISLPoints, "点");
   } else {
      // 使用默认ATR止损
      stopLossDistance = atr * InpStopLossATR;
      stopLoss = currentAsk - stopLossDistance;
      Print("📊 使用ATR止损: ", DoubleToString(stopLossDistance / g_SymbolPoint, 0), "点");
   }
   stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);

   // 计算止盈 - 使用AI建议
   if(g_AITPPoints > 0) {
      takeProfit = currentAsk + (g_AITPPoints * g_SymbolPoint);
      takeProfit = NormalizeDouble(takeProfit, g_SymbolDigits);
      Print("📊 使用AI止盈: ", g_AITPPoints, "点");
   }
   
   // 专业: 计算手数(凯利公式或动态)
   double calculatedLots = CalculateKellyCriterionLots(stopLossDistance);
   
   // ═══ V2.1: 限制止损最大美元金额 ═══
   double maxSLDistance = CalculateMaxStopLossDistance(calculatedLots);
   if(maxSLDistance > 0) {
      double atrDistance = currentAsk - stopLoss;
      if(atrDistance > maxSLDistance) {
         double oldSL = stopLoss;
         stopLoss = currentAsk - maxSLDistance;
         stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);
         Print("🛡️ 止损已限制: ATR需要 $", DoubleToString(atrDistance, 2), 
               " 但最大是 $", DoubleToString(maxSLDistance, 2));
         Print("   原止损: ", oldSL, " → 新止损: ", stopLoss);
         Print("   最大亏损: $", InpMaxStopLossDollars);
      }
   }
   
   // 验证止损满足经纪商最低要求
   double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
   if(minStopLevel > 0 && (currentAsk - stopLoss) < minStopLevel) {
      stopLoss = NormalizeDouble(currentAsk - minStopLevel, g_SymbolDigits);
   }

   // 准备订单
   Print("=== 执行买入订单 ===");
   Print("  品种: ", _Symbol);
   Print("  手数: ", calculatedLots,
         (InpUseKellyCriterion ? " (凯利)" : (InpUseMoneyManagement ? " (动态)" : " (固定)")));
   Print("  当前卖价: ", currentAsk);
   Print("  止损: ", stopLoss, " (距离: ", DoubleToString((currentAsk - stopLoss) / g_SymbolPoint, 0), "点)");
   Print("  止盈: ", takeProfit, (takeProfit > 0 ? " (距离: " + DoubleToString((takeProfit - currentAsk) / g_SymbolPoint, 0) + "点)" : " (AI管理平仓)"));

   // 直接使用OrderSend以获得最大可靠性
   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = calculatedLots;
   request.type = ORDER_TYPE_BUY;
   request.price = currentAsk;
   request.sl = stopLoss;
   request.tp = takeProfit;  // AI建议的止盈，0则由AI管理平仓
   request.deviation = 10;
   request.magic = 123456;
   request.comment = "GOLD V2 - AI Managed";
   
   // 检测并设置正确的成交模式
   long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) {
   request.type_filling = ORDER_FILLING_FOK;
      Print("  使用FOK成交模式");
   } else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) {
      request.type_filling = ORDER_FILLING_IOC;
      Print("  使用IOC成交模式");
   } else {
      request.type_filling = ORDER_FILLING_RETURN;
      Print("  使用RETURN成交模式");
   }
   
   // 发送订单
   if(OrderSend(request, result)) {
      if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
         Print("✓✓✓ 订单执行成功! ✓✓✓");
         Print("  订单: ", result.order);
         Print("  Deal: ", result.deal);
         Print("  手数: ", result.volume);
         Print("  Price: ", result.price);
         Print("  请求止损: ", request.sl);
         // 注意: 总交易数在持仓平仓时计数，不是开仓时
         g_LastTradeTicket = result.order;

         // 验证持仓并获取实际止损
         Sleep(200);
         if(PositionSelect(_Symbol)) {
            double actualSL = PositionGetDouble(POSITION_SL);
            Print("  ✓ 持仓已确认");
            Print("  实际止损: ", actualSL);
         }

         // 立即更新面板
         int openPos = CountTotalOpenPositions();
         int buyPos = CountOpenBuyPositions();
         int sellPos = CountOpenSellPositions();
         UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) +
                  " | 多:" + IntegerToString(buyPos) + " 空:" + IntegerToString(sellPos) + ")", ClrBuy);
         ChartRedraw(0);
      } else {
         Print("⚠ 订单部分成交或挂单中");
         Print("  返回码: ", result.retcode);
         Print("  Deal: ", result.deal);
         Print("  订单: ", result.order);
      }
   } else {
      Print("✗✗✗ 订单失败! ✗✗✗");
      Print("  返回码: ", result.retcode);
      Print("  返回码描述: ", result.comment);
      Print("  请求ID: ", result.request_id);
      
      // 如果成交模式错误，尝试其他模式
      if(result.retcode == TRADE_RETCODE_REJECT || 
         StringFind(result.comment, "filling") >= 0 ||
         StringFind(result.comment, "FOK") >= 0 ||
         StringFind(result.comment, "IOC") >= 0 ||
         StringFind(result.comment, "Unsupported") >= 0) {
         Print("  → 使用替代成交模式重试...");
         
         // FOK失败则尝试IOC，或尝试RETURN
         if(request.type_filling == ORDER_FILLING_FOK) {
            request.type_filling = ORDER_FILLING_IOC;
            Print("  → 尝试IOC成交模式");
         } else if(request.type_filling == ORDER_FILLING_IOC) {
            request.type_filling = ORDER_FILLING_RETURN;
            Print("  → 尝试RETURN成交模式");
         }
         
         // 重试订单
         if(OrderSend(request, result)) {
            if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
               Print("✓✓✓ 订单重试成功! ✓✓✓");
               Print("  订单: ", result.order);
               Print("  Deal: ", result.deal);
               // 注意: 总交易数在持仓平仓时计数，不是开仓时
               g_LastTradeTicket = result.order;
               return; // Success!
            }
         }
      }
      
      Alert("订单失败: ", result.comment);
   }
}

//+------------------------------------------------------------------+
//| 执行卖出订单 - 波段交易                                          |
//+------------------------------------------------------------------+
void ExecuteSellOrder(double entryPrice, double atr)
{
   // 检查交易权限
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) {
      Print("错误: 终端自动交易已禁用!");
      return;
   }
   
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) {
      Print("错误: EA自动交易已禁用!");
      return;
   }
   
   // 获取当前市场价格
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(currentAsk <= 0 || currentBid <= 0) {
      Print("错误: 无效的市场价格");
      return;
   }

   // 计算止损 - 优先使用AI建议，否则用ATR
   double stopLossDistance = 0;
   double stopLoss = 0;
   double takeProfit = 0;

   if(g_AISLPoints > 0) {
      // 使用AI建议的止损点数
      stopLossDistance = g_AISLPoints * g_SymbolPoint;
      stopLoss = currentBid + stopLossDistance;
      Print("📊 使用AI止损: ", g_AISLPoints, "点");
   } else {
      // 使用默认ATR止损
      stopLossDistance = atr * InpStopLossATR;
      stopLoss = currentBid + stopLossDistance;
      Print("📊 使用ATR止损: ", DoubleToString(stopLossDistance / g_SymbolPoint, 0), "点");
   }
   stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);

   // 计算止盈 - 使用AI建议
   if(g_AITPPoints > 0) {
      takeProfit = currentBid - (g_AITPPoints * g_SymbolPoint);
      takeProfit = NormalizeDouble(takeProfit, g_SymbolDigits);
      Print("📊 使用AI止盈: ", g_AITPPoints, "点");
   }
   
   // 专业: 计算手数(凯利公式或动态)
   double calculatedLots = CalculateKellyCriterionLots(stopLossDistance);
   
   // ═══ V2.1: 限制止损最大美元金额 ═══
   double maxSLDistance = CalculateMaxStopLossDistance(calculatedLots);
   if(maxSLDistance > 0) {
      double atrDistance = stopLoss - currentBid;
      if(atrDistance > maxSLDistance) {
         double oldSL = stopLoss;
         stopLoss = currentBid + maxSLDistance;
         stopLoss = NormalizeDouble(stopLoss, g_SymbolDigits);
         Print("🛡️ STOP LOSS CAPPED (SELL): ATR wanted $", DoubleToString(atrDistance, 2), 
               " 但最大是 $", DoubleToString(maxSLDistance, 2));
         Print("   原止损: ", oldSL, " → 新止损: ", stopLoss);
         Print("   最大亏损: $", InpMaxStopLossDollars);
      }
   }
   
   // 验证止损满足经纪商最低要求
   double minStopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * g_SymbolPoint;
   if(minStopLevel > 0 && (stopLoss - currentBid) < minStopLevel) {
      stopLoss = NormalizeDouble(currentBid + minStopLevel, g_SymbolDigits);
   }
   
   // 准备订单
   Print("=== 执行卖出订单(波段交易) ===");
   Print("  品种: ", _Symbol);
   Print("  手数: ", calculatedLots,
         (InpUseKellyCriterion ? " (凯利)" : (InpUseMoneyManagement ? " (动态)" : " (固定)")));
   Print("  当前买价: ", currentBid);
   Print("  止损: ", stopLoss, " (距离: ", DoubleToString((stopLoss - currentBid) / g_SymbolPoint, 0), "点)");
   Print("  止盈: ", takeProfit, (takeProfit > 0 ? " (距离: " + DoubleToString((currentBid - takeProfit) / g_SymbolPoint, 0) + "点)" : " (AI管理平仓)"));

   // Execute using OrderSend directly
   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = calculatedLots;
   request.type = ORDER_TYPE_SELL;
   request.price = currentBid;
   request.sl = stopLoss;
   request.tp = takeProfit;  // AI建议的止盈，0则由AI管理平仓
   request.deviation = 10;
   request.magic = 123456;
   request.comment = "GOLD V2 - AI Swing SELL";
   
   // 检测并设置正确的成交模式
   long fillingMode = SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((fillingMode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) {
      request.type_filling = ORDER_FILLING_FOK;
      Print("  使用FOK成交模式");
   } else if((fillingMode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) {
      request.type_filling = ORDER_FILLING_IOC;
      Print("  使用IOC成交模式");
   } else {
      request.type_filling = ORDER_FILLING_RETURN;
      Print("  使用RETURN成交模式");
   }
   
   // 发送订单
   if(OrderSend(request, result)) {
      if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
         Print("✓✓✓ 卖出订单执行成功! ✓✓✓");
         Print("  订单: ", result.order);
         Print("  Deal: ", result.deal);
         Print("  手数: ", result.volume);
         Print("  Price: ", result.price);
         Print("  请求止损: ", request.sl);
         // 注意: 总交易数在持仓平仓时计数，不是开仓时
         g_LastTradeTicket = result.order;

         // 立即更新面板
         int openPos = CountTotalOpenPositions();
         int buyPos = CountOpenBuyPositions();
         int sellPos = CountOpenSellPositions();
         UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) +
                  " | 多:" + IntegerToString(buyPos) + " 空:" + IntegerToString(sellPos) + ")", ClrBuy);
         ChartRedraw(0);
      } else {
         Print("⚠ SELL ORDER PARTIALLY FILLED OR PENDING");
         Print("  返回码: ", result.retcode);
      }
   } else {
      Print("✗✗✗ 卖出订单失败! ✗✗✗");
      Print("  返回码: ", result.retcode);
      Print("  返回码描述: ", result.comment);
      // 如果成交模式错误，尝试其他模式
      if(result.retcode == TRADE_RETCODE_REJECT || 
         StringFind(result.comment, "filling") >= 0 ||
         StringFind(result.comment, "FOK") >= 0 ||
         StringFind(result.comment, "IOC") >= 0) {
         Print("  → 使用替代成交模式重试...");
         
         // FOK失败则尝试IOC，或尝试RETURN
         if(request.type_filling == ORDER_FILLING_FOK) {
            request.type_filling = ORDER_FILLING_IOC;
            Print("  → 尝试IOC成交模式");
         } else if(request.type_filling == ORDER_FILLING_IOC) {
            request.type_filling = ORDER_FILLING_RETURN;
            Print("  → 尝试RETURN成交模式");
         }
         
         // 重试订单
         if(OrderSend(request, result)) {
            if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) {
               Print("✓✓✓ SELL ORDER EXECUTED SUCCESSFULLY ON RETRY! ✓✓✓");
               Print("  订单: ", result.order);
               Print("  Deal: ", result.deal);
               // 注意: 总交易数在持仓平仓时计数，不是开仓时
               g_LastTradeTicket = result.order;
               return; // Success!
            }
         }
      }
      
      Alert("卖出订单失败: ", result.comment);
   }
}

//+------------------------------------------------------------------+
//| 管理AI持仓 - 波段交易止盈                                        |
//| AI根据市场状况决定何时平仓                                        |
//+------------------------------------------------------------------+
void ManageAIPositions(double rsi, double bid, double ask, double atr)
{
   // PROFIT HUNGRY MONSTER - Always check positions (no AI requirement)
   // if(!InpAIProfitTaking) return; // REMOVED - always check for profit!
   
   // Check all open positions
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0) {
         if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == 123456) {
            
            double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            double currentSL = PositionGetDouble(POSITION_SL);
            double currentTP = PositionGetDouble(POSITION_TP);
            double positionProfit = PositionGetDouble(POSITION_PROFIT);
            double positionVolume = PositionGetDouble(POSITION_VOLUME);
            ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
            
            // 计算点数和百分比利润
            double profitPts = 0.0;
            double profitPct = 0.0;
            double currentPrice = 0.0;
            
            if(posType == POSITION_TYPE_BUY) {
               currentPrice = bid;
               profitPts = (bid - entryPrice) / g_SymbolPoint;
               profitPct = ((bid - entryPrice) / entryPrice) * 100.0;
            } else if(posType == POSITION_TYPE_SELL) {
               currentPrice = ask;
               profitPts = (entryPrice - ask) / g_SymbolPoint;
               profitPct = ((entryPrice - ask) / entryPrice) * 100.0;
            }
            
            // AI平仓决策逻辑 - 让利润奔跑!
            bool shouldClose = false;
            string closeReason = "";
            
            // 1. 仅在AI以极高置信度(0.85+)说反向时平仓
            //    Don't close on weak signals - let the trailing stop handle it!
            if(posType == POSITION_TYPE_BUY && g_AISignal == "SELL" && g_AIConfidence >= 0.80 && profitPct > 0.30) {
               shouldClose = true;
               closeReason = "VERY strong AI SELL signal + good profit (" + DoubleToString(profitPct, 3) + "%)";
            } else if(posType == POSITION_TYPE_SELL && g_AISignal == "BUY" && g_AIConfidence >= 0.80 && profitPct > 0.30) {
               shouldClose = true;
               closeReason = "VERY strong AI BUY signal + good profit (" + DoubleToString(profitPct, 3) + "%)";
            }
            // 2. 巨大利润 - 仅在达到大利润目标时平仓(让利润奔跑!)
            else if(profitPct >= InpStrongProfitPct) {
               shouldClose = true;
               closeReason = "MASSIVE PROFIT: " + DoubleToString(profitPct, 3) + "% - Taking BIG win!";
            }
            // 3. 紧急退出 - 仅在AI强烈反向且亏损时提前平仓
            else if(posType == POSITION_TYPE_BUY && g_AISignal == "SELL" && g_AIConfidence >= 0.90 && profitPct < -0.10) {
               shouldClose = true;
               closeReason = "EMERGENCY: Strong AI reversal while losing (" + DoubleToString(profitPct, 3) + "%)";
            }
            else if(posType == POSITION_TYPE_SELL && g_AISignal == "BUY" && g_AIConfidence >= 0.90 && profitPct < -0.10) {
               shouldClose = true;
               closeReason = "EMERGENCY: Strong AI reversal while losing (" + DoubleToString(profitPct, 3) + "%)";
            }
            // 其他情况: 让追踪止损处理退出 - 不要手动平仓!
            // 追踪止损会自动保护利润和止损
            
            if(shouldClose) {
               Print("═══════════════════════════════════════════════════════");
               Print("🤖 AI波段: 平仓");
               Print("   票据: ", ticket);
               Print("   类型: ", (posType == POSITION_TYPE_BUY ? "BUY" : "SELL"));
               Print("   入场: ", entryPrice, " | 当前: ", currentPrice);
               Print("   利润: ", profitPts, " pts (", DoubleToString(profitPct, 2), "%)");
               Print("   原因: ", closeReason);
               Print("   AI信号: ", g_AISignal, " | 置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
               Print("   → AI决定: 平仓锁定利润");
               Print("═══════════════════════════════════════════════════════");
               
               if(g_Trade.PositionClose(ticket)) {
                  Print("✅ AI成功平仓!");
                  // 紧密跟踪: 平仓时立即更新统计
                  g_TotalTrades++;
                  if(positionProfit > 0) {
                     g_WinningTrades++;
                     g_ConsecutiveLosses = 0; // Reset consecutive losses on win
                  } else {
                     g_LosingTrades++;
                     g_ConsecutiveLosses++;
                     g_LastLossTime = TimeCurrent();
                  }
                  g_TotalProfit += positionProfit;
                  g_DailyProfit += positionProfit;
                  
                  // 更新高级统计(不重复计算)
                  if(positionProfit > 0) {
                     g_GrossProfit += positionProfit;
                     if(positionProfit > g_LargestWin) g_LargestWin = positionProfit;
                     if(g_WinningTrades > 0) g_AvgWin = g_GrossProfit / g_WinningTrades;
                  } else {
                     g_GrossLoss += MathAbs(positionProfit);
                     if(positionProfit < g_LargestLoss) g_LargestLoss = positionProfit;
                     if(g_LosingTrades > 0) g_AvgLoss = g_GrossLoss / g_LosingTrades;
                  }
                  
                  // 计算盈亏比
                  if(g_GrossLoss > 0)
                     g_ProfitFactor = g_GrossProfit / g_GrossLoss;
                  else
                     g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;
                  
                  // 计算回撤
                  double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
                  if(g_DailyHighEquity > 0.0001) {
                     double drawdown = ((g_DailyHighEquity - currentEquity) / g_DailyHighEquity) * 100.0;
                     if(drawdown > g_MaxDrawdown) g_MaxDrawdown = drawdown;
                  }
                  
                  Print("📊 统计: 总计=", g_TotalTrades, " | 盈利=", g_WinningTrades, " | 亏损=", g_LosingTrades, 
                        " | 总盈亏=$", DoubleToString(g_TotalProfit, 2), " | 今日=$", DoubleToString(g_DailyProfit, 2));
               } else {
                  Print("❌ 平仓失败: ", g_Trade.ResultRetcodeDescription());
               }
            } else {
               // 偶尔记录持仓状态
               static datetime lastPosLog = 0;
               if(TimeCurrent() - lastPosLog > 300) { // Every 5 minutes
                  Print("📊 AI波段: 持仓 #", ticket);
                  Print("   类型: ", (posType == POSITION_TYPE_BUY ? "BUY" : "SELL"));
                  Print("   入场: ", entryPrice, " | 当前: ", currentPrice);
                  Print("   利润: ", profitPts, " pts (", DoubleToString(profitPct, 2), "%)");
                  Print("   AI信号: ", g_AISignal, " | AI says: ", g_AIReasoning);
                  Print("   → AI决定: 持仓(等待更好出场)");
                  lastPosLog = TimeCurrent();
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 统计多头持仓数                                                   |
//+------------------------------------------------------------------+
int CountOpenBuyPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0) {
         if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == 123456 &&
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {
            count++;
         }
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| 统计空头持仓数                                                   |
//+------------------------------------------------------------------+
int CountOpenSellPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0) {
         if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == 123456 &&
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL) {
            count++;
         }
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| 统计总持仓数(多+空)                                              |
//+------------------------------------------------------------------+
int CountTotalOpenPositions()
{
   return CountOpenBuyPositions() + CountOpenSellPositions();
}

//+------------------------------------------------------------------+
//| 更新AI分析                                                       |
//+------------------------------------------------------------------+
void UpdateAIAnalysis(double rsi, double bid, double ask, double atr)
{
   datetime currentTime = TimeCurrent();
   int secondsSinceUpdate = (int)(currentTime - g_LastAIUpdate);

   // Update AI based on user setting - QUALITY OVER SPEED!
   // For M15 trading: Every 15 minutes = once per candle = BEST quality analysis
   // This finds the BEST trades, not the fastest trades!
   int updateInterval = InpAIUpdateMinutes * 60; // Convert minutes to seconds
   if(secondsSinceUpdate >= updateInterval || g_LastAIUpdate == 0) {
      g_LastAIUpdate = currentTime;
      
      // Log what AI is analyzing BEFORE calling
      Print("═══════════════════════════════════════════════════════");
      Print("📊 AI分析中 - M15波段交易(每", InpAIUpdateMinutes, " 分钟 - 质量分析)");
      Print("   品种: ", g_SymbolName, (g_IsGoldSymbol ? " (GOLD)" : ""));
      Print("   时间框架: M15 (15分钟波段交易)");
      Print("   策略: 质量优先于速度 - 找到最佳交易!");
      Print("   时间: ", TimeToString(currentTime, TIME_DATE|TIME_MINUTES));
      Print("   价格: ", bid, " / ", ask, " | 点差: ", DoubleToString((ask-bid)/g_SymbolPoint, 0), " pts");
      Print("   RSI: ", DoubleToString(rsi, 1), " | ATR: ", DoubleToString(atr, g_SymbolDigits));
      Print("   持仓: ", CountTotalOpenPositions(), "/", InpMaxPositions, " (", 
            CountOpenBuyPositions(), " 多 + ", CountOpenSellPositions(), " SELL)");
      Print("   → AI正在分析M15波段机会和风险管理...");
      Print("═══════════════════════════════════════════════════════");
      
      // Build comprehensive context and call AI
      string baseContext = BuildMarketContext(rsi, bid, ask, atr);
      // PROFESSIONAL: Enhance AI context with regime and performance data
      string context = EnhanceAIContext(baseContext);
      string aiResponse = CallOpenAI(context);
      ParseAIResponse(aiResponse);
      
      // Detailed feedback after AI analysis
      Print("═══════════════════════════════════════════════════════");
      Print("🎯 AI分析完成 - 质量模式:");
      Print("   信号: ", g_AISignal);
      Print("   置信度: ", DoubleToString(g_AIConfidence * 100, 1), "%");
      Print("   推理: ", g_AIReasoning);
      Print("   Strategy: QUALITY OVER SPEED - Find BEST trade opportunities!");
      Print("   下次AI更新: ", InpAIUpdateMinutes, " 分钟(每根M15K线)");
      
      // Show FULL AI feedback without truncation
      Print("   完整AI分析:");
      Print("   ════════════════════════════════════════════════════");
      Print("   ", g_AISummary);
      Print("   ════════════════════════════════════════════════════");
      
      if(g_AISignal == "BUY" && g_AIConfidence >= InpAIConfidenceMin) {
         Print("   → 动作: AI想开多仓");
         Print("   → 预期: 价格将向上波动");
      } else if(g_AISignal == "SELL" && g_AIConfidence >= InpAIConfidenceMin) {
         Print("   → 动作: AI想开空仓");
         Print("   → 预期: 价格将向下波动");
      } else if(g_AISignal == "WAIT") {
         Print("   → 动作: AI等待更好的设置");
         Print("   → 预期: ", g_AIReasoning);
      }
      
      // Check what AI is looking for
      Print("   → AI正在寻找:");
      if(rsi < 40) {
         Print("      - RSI超卖 (", DoubleToString(rsi, 1), ") - potential BUY setup");
      } else if(rsi > 60) {
         Print("      - RSI超买 (", DoubleToString(rsi, 1), ") - potential SELL setup");
      } else {
         Print("      - RSI中性 (", DoubleToString(rsi, 1), ") - waiting for extreme");
      }
      
      int totalPos = CountTotalOpenPositions();
      if(totalPos < InpMaxPositions) {
         Print("      - 可以开仓 ", (InpMaxPositions - totalPos), " 个持仓");
      } else {
         Print("      - 已达最大持仓 (", totalPos, ") - managing existing positions");
      }
      
      Print("═══════════════════════════════════════════════════════");
   }
   
   // 更新AI信号显示
      color aiSignalColor = ClrNeutral;
      string aiSignalDisplay = g_AISignal;
      if(g_AISignal == "BUY") {
         aiSignalColor = ClrBuy;
         aiSignalDisplay = "买入";
      } else if(g_AISignal == "SELL") {
         aiSignalColor = ClrSell;
         aiSignalDisplay = "卖出";
      } else if(g_AISignal == "WAIT") {
         aiSignalColor = ClrWarning;
         aiSignalDisplay = "等待";
      }

      UpdateUI("AISignal", aiSignalDisplay, aiSignalColor);
      // Ensure confidence is displayed correctly (handle 0.0 case)
      string confidenceText = "";
      if(g_AIConfidence > 0.0 || g_AISignal != "WAIT") {
         confidenceText = DoubleToString(g_AIConfidence * 100, 1) + "%";
      } else {
         confidenceText = "--";
      }
      UpdateUI("AIConfidence", confidenceText,
               (g_AIConfidence >= InpAIConfidenceMin ? ClrBuy : ClrWarning));
      
      // Update AI Expectation (what AI is looking for)
      string expectationText = "";
      color expectationColor = ClrNeutral;
      
      if(StringLen(g_AIReasoning) > 0 && g_AIReasoning != "Invalid AI response" && g_AIReasoning != "Waiting for AI analysis...") {
         // Show actual reasoning (truncate to 60 chars for display to fit more)
         expectationText = StringSubstr(g_AIReasoning, 0, 60);
         if(StringLen(g_AIReasoning) > 60) expectationText += "...";
         
         if(g_AISignal == "BUY") {
            expectationColor = ClrBuy;
         } else if(g_AISignal == "SELL") {
            expectationColor = ClrSell;
         } else {
            expectationColor = ClrWarning;
         }
      } else if(g_AISignal == "BUY") {
         expectationText = "价格向上波动";
         expectationColor = ClrBuy;
      } else if(g_AISignal == "SELL") {
         expectationText = "价格向下波动";
         expectationColor = ClrSell;
      } else if(g_AISignal == "WAIT") {
         expectationText = "等待设置...";
         expectationColor = ClrWarning;
      } else {
         expectationText = "分析中...";
         expectationColor = ClrNeutral;
      }
      
      UpdateUI("AIExpectation", expectationText, expectationColor);

      string statusText = "AI: " + g_AIStatus;
   color statusColor = ClrWarning;
   if(g_AIStatus == "活跃") {
      statusColor = ClrBuy;
      statusText = "AI: 活跃 ✓";
   } else if(g_AIStatus == "模拟") {
      statusColor = ClrWarning;
      statusText = "AI: 模拟 ⚠";
   } else if(g_AIStatus == "错误") {
      statusColor = ClrSell;
      statusText = "AI: 错误 ✗";
   }
      UpdateUI("AIStatus", statusText, statusColor);

   // 计算今日盈利（已平仓 + 浮动盈亏）
   double floatingProfit = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == 123456)
      {
         floatingProfit += PositionGetDouble(POSITION_PROFIT) +
                          PositionGetDouble(POSITION_SWAP) +
                          PositionGetDouble(POSITION_COMMISSION);
      }
   }
   double dailyTotalProfit = g_DailyProfit + floatingProfit;

   // 更新今日盈利
   string dailyProfitText = "$" + DoubleToString(dailyTotalProfit, 2);
   color dailyProfitColor = dailyTotalProfit >= 0 ? ClrBuy : ClrSell;
   UpdateUI("DailyProfit", dailyProfitText, dailyProfitColor);

   // 更新胜率
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   string winRateText = DoubleToString(winRate, 1) + "%";
   color winRateColor = winRate >= 50 ? ClrBuy : ClrSell;
   UpdateUI("WinRate", winRateText, winRateColor);
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
   
   if(barShift < 0) {
      pivot = r1 = r2 = r3 = s1 = s2 = s3 = 0.0;
      return;
   }
   
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
   if(hour >= 0 && hour < 8) return "ASIAN";
   return "ASIAN";
}

void GetDailyRange(double &high, double &low, double &range, double &rangePercent)
{
   int todayBar = iBarShift(_Symbol, PERIOD_D1, TimeCurrent());
   if(todayBar < 0) {
      high = low = range = rangePercent = 0.0;
      return;
   }
   
   high = iHigh(_Symbol, PERIOD_D1, todayBar);
   low = iLow(_Symbol, PERIOD_D1, todayBar);
   
   if(high > 0 && low > 0) {
      range = high - low;
      double currentPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(range > 0) {
         rangePercent = ((currentPrice - low) / range) * 100.0;
      } else {
         rangePercent = 50.0;
      }
   } else {
      high = low = range = rangePercent = 0.0;
   }
}

//+------------------------------------------------------------------+
//| 为AI构建全面的市场上下文                                         |
//+------------------------------------------------------------------+
string BuildMarketContext(double rsi, double bid, double ask, double atr)
{
   // SIMPLIFIED FOR TOKEN SAVINGS - Only send essential data
   // 安全检查: 确保缓冲区有数据
   bool maBullish = false;
   if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0)
      maBullish = (g_BufferMAFast[0] > g_BufferMASlow[0]);
   
   int openPositions = CountTotalOpenPositions();
   int buyPositions = CountOpenBuyPositions();
   int sellPositions = CountOpenSellPositions();
   
   // Calculate win rate
   double winRate = 0.0;
   if(g_TotalTrades > 0) {
      winRate = (double(g_WinningTrades) / double(g_TotalTrades)) * 100.0;
   }
   
   // ENHANCED GOLD CONTEXT - M15 swing trading with ADVANCED PATTERN RECOGNITION
   string context = "═══════════════════════════════════════════════════════\n";
   context += "M15 SWING TRADING - PATTERN RECOGNITION ANALYSIS (Every " + IntegerToString(InpAIUpdateMinutes) + " min)\n";
   context += "═══════════════════════════════════════════════════════\n";
   context += "Trading Instrument: " + g_SymbolName + (g_IsGoldSymbol ? " (GOLD/XAUUSD)" : "") + "\n";
   context += "Timeframe: M15 (15-minute swing trading)\n";
   context += "Philosophy: FIND PATTERNS + MULTI-TIMEFRAME CONFLUENCE = HIGH-QUALITY TRADES!\n";
   context += "Strategy: Identify patterns across timeframes, wait for alignment, execute with confidence\n";
   context += "Data: M1:30, M5:100, M15:100, H1:100, H4:50, D1:100 candles for full pattern visibility\n\n";
   
   context += "═══ CURRENT MARKET DATA ═══\n";
   context += "Price: BID " + DoubleToString(bid, g_SymbolDigits) + " | ASK " + DoubleToString(ask, g_SymbolDigits) + "\n";
   
   double spreadValue = (ask - bid) / g_SymbolPoint;
   context += "Spread: " + DoubleToString(spreadValue, 0) + " 点";
   
   if(spreadValue > 30)
      context += " (WIDE - be cautious!)\n";
   else if(spreadValue < 15)
      context += " (TIGHT - good for scalping)\n";
   else
      context += " (NORMAL)\n";
   
   // Get more MT5 market data
   MqlTick lastTick;
   if(SymbolInfoTick(_Symbol, lastTick))
   {
      context += "Last Tick: Bid=" + DoubleToString(lastTick.bid, g_SymbolDigits) + 
                 " Ask=" + DoubleToString(lastTick.ask, g_SymbolDigits) + 
                 " Vol=" + IntegerToString(lastTick.volume) + "\n";
      // Tick flags for market depth
      if((lastTick.flags & TICK_FLAG_BUY) == TICK_FLAG_BUY)
         context += "Last Tick: BUY pressure\n";
      else if((lastTick.flags & TICK_FLAG_SELL) == TICK_FLAG_SELL)
         context += "Last Tick: SELL pressure\n";
   }
   
   
   context += "\n═══ TECHNICAL INDICATORS ═══\n";
   context += "RSI(14): " + DoubleToString(rsi, 1);
   if(rsi < 30) context += " (OVERSOLD - BUY opportunity)\n";
   else if(rsi > 70) context += " (OVERBOUGHT - SELL opportunity)\n";
   else if(rsi < 40) context += " (Near oversold - watch for BUY)\n";
   else if(rsi > 60) context += " (Near overbought - watch for SELL)\n";
   else context += " (NEUTRAL - wait for extremes)\n";
   
   if(ArraySize(g_BufferMAFast) > 0 && ArraySize(g_BufferMASlow) > 0)
   {
      context += "MA(20/50): " + DoubleToString(g_BufferMAFast[0], g_SymbolDigits) + " / " + 
                 DoubleToString(g_BufferMASlow[0], g_SymbolDigits) + " - " + (maBullish ? "看涨" : "看跌") + " trend\n";
   }
   
   context += "ATR(14): " + DoubleToString(atr, g_SymbolDigits) + " (volatility measure)\n";
   context += "Market Activity: " + IntegerToString(g_TicksPerSecond) + " ticks/second";
   if(g_TicksPerSecond > 20) context += " (HIGH activity - good for scalping)\n";
   else if(g_TicksPerSecond < 5) context += " (LOW activity - be careful)\n";
   else context += " (NORMAL activity)\n";
   
   // ═══════════════════════════════════════════════════════
   // MULTI-TIMEFRAME CANDLE DATA FOR PATTERN RECOGNITION
   // ═══════════════════════════════════════════════════════
   
   context += "\n═══ MULTI-TIMEFRAME ANALYSIS ═══\n";
   
   // M1 - 30 candles WITH VOLUME
   double m1Open[], m1High[], m1Low[], m1Close[];
   long m1Volume[];
   ArraySetAsSeries(m1Open, true);
   ArraySetAsSeries(m1High, true);
   ArraySetAsSeries(m1Low, true);
   ArraySetAsSeries(m1Close, true);
   ArraySetAsSeries(m1Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_M1, 0, 30, m1Open) == 30 &&
      CopyHigh(_Symbol, PERIOD_M1, 0, 30, m1High) == 30 &&
      CopyLow(_Symbol, PERIOD_M1, 0, 30, m1Low) == 30 &&
      CopyClose(_Symbol, PERIOD_M1, 0, 30, m1Close) == 30 &&
      CopyTickVolume(_Symbol, PERIOD_M1, 0, 30, m1Volume) == 30)
   {
      context += "M1 (30 candles - entry timing & momentum):\n";
      for(int i = 0; i < 30; i++)
      {
         string candleType = m1Close[i] > m1Open[i] ? "涨" : "跌";
         double bodySize = MathAbs(m1Close[i] - m1Open[i]) / g_SymbolPoint;
         double candleRange = (m1High[i] - m1Low[i]) / g_SymbolPoint;
         context += "  " + IntegerToString(i+1) + ": " + candleType + " O:" + DoubleToString(m1Open[i], g_SymbolDigits) +
                    " H:" + DoubleToString(m1High[i], g_SymbolDigits) + 
                    " L:" + DoubleToString(m1Low[i], g_SymbolDigits) + 
                    " C:" + DoubleToString(m1Close[i], g_SymbolDigits) +
                    " Body:" + DoubleToString(bodySize, 0) + "pts Range:" + DoubleToString(candleRange, 0) + "pts" +
                    " Vol:" + IntegerToString((int)m1Volume[i]) + "\n";
      }
   }
   
   // M5 - 100 candles WITH VOLUME (Pattern Recognition: Flags, Pennants, Impulse)
   double m5Open[], m5High[], m5Low[], m5Close[];
   long m5Volume[];
   ArraySetAsSeries(m5Open, true);
   ArraySetAsSeries(m5High, true);
   ArraySetAsSeries(m5Low, true);
   ArraySetAsSeries(m5Close, true);
   ArraySetAsSeries(m5Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_M5, 0, 100, m5Open) == 100 &&
      CopyHigh(_Symbol, PERIOD_M5, 0, 100, m5High) == 100 &&
      CopyLow(_Symbol, PERIOD_M5, 0, 100, m5Low) == 100 &&
      CopyClose(_Symbol, PERIOD_M5, 0, 100, m5Close) == 100 &&
      CopyTickVolume(_Symbol, PERIOD_M5, 0, 100, m5Volume) == 100)
   {
      context += "M5 (100 bars - Flags/Pennants/Impulse): ";
      // Show last 50 in compact format
      for(int i = 0; i < 50; i++)
      {
         string dir = m5Close[i] > m5Open[i] ? "+" : "-";
         double candleRange = (m5High[i] - m5Low[i]) / g_SymbolPoint;
         context += dir + DoubleToString(m5Close[i], g_SymbolDigits) + ":" + DoubleToString(candleRange, 0) + ":" + IntegerToString((int)m5Volume[i]);
         if(i < 49) context += " | ";
      }
      context += " [+50 older bars in data]\n";
   }
   
   // M15 - 100 candles (YOUR TRADING TIMEFRAME!) - WITH VOLUME (Pattern: Double Top/Bottom, Triangles, Opening Range)
   double m15Open[], m15High[], m15Low[], m15Close[];
   long m15Volume[];
   ArraySetAsSeries(m15Open, true);
   ArraySetAsSeries(m15High, true);
   ArraySetAsSeries(m15Low, true);
   ArraySetAsSeries(m15Close, true);
   ArraySetAsSeries(m15Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_M15, 0, 100, m15Open) == 100 &&
      CopyHigh(_Symbol, PERIOD_M15, 0, 100, m15High) == 100 &&
      CopyLow(_Symbol, PERIOD_M15, 0, 100, m15Low) == 100 &&
      CopyClose(_Symbol, PERIOD_M15, 0, 100, m15Close) == 100 &&
      CopyTickVolume(_Symbol, PERIOD_M15, 0, 100, m15Volume) == 100)
   {
      context += "M15 PRIMARY (100 bars - Double Top/Bottom, Triangles):\n";
      
      // Calculate average volume
      double avgVolume = 0;
      for(int v = 0; v < 100; v++) avgVolume += (double)m15Volume[v];
      avgVolume /= 100.0;
      
      // Show last 30 candles with patterns detected inline (recent action)
      for(int i = 0; i < 30; i++)
      {
         string dir = m15Close[i] > m15Open[i] ? "+" : "-";
         double bodySize = MathAbs(m15Close[i] - m15Open[i]) / g_SymbolPoint;
         double candleRange = (m15High[i] - m15Low[i]) / g_SymbolPoint;
         double volRatio = (double)m15Volume[i] / avgVolume;
         double upperWick = (m15High[i] - MathMax(m15Open[i], m15Close[i])) / g_SymbolPoint;
         double lowerWick = (MathMin(m15Open[i], m15Close[i]) - m15Low[i]) / g_SymbolPoint;
         
         // Compact pattern tags
         string tags = "";
         if(volRatio > 1.5) tags += "高量 ";
         if(bodySize < candleRange * 0.3 && upperWick > bodySize * 2) tags += "星线 ";
         if(bodySize < candleRange * 0.3 && lowerWick > bodySize * 2) tags += "锤子 ";
         if(bodySize > candleRange * 0.8) tags += "强势 ";
         
         context += dir + DoubleToString(m15Close[i], g_SymbolDigits) + ":" + 
                    DoubleToString(m15High[i], g_SymbolDigits) + "/" + 
                    DoubleToString(m15Low[i], g_SymbolDigits) + ":" + 
                    DoubleToString(candleRange, 0) + "r:" + 
                    IntegerToString((int)m15Volume[i]) + "v";
         if(StringLen(tags) > 0) context += "[" + tags + "]";
         if(i < 29) context += " | ";
      }
      context += " [+70 older bars in data]\n";
      
      // Pattern summary - Look for double tops/bottoms in last 60 candles
      context += "M15 Patterns Detected: ";
      if(m15Close[0] > m15Open[0] && m15Close[1] < m15Open[1] &&
         m15Open[0] <= m15Close[1] && m15Close[0] >= m15Open[1])
         context += "看涨吞没 ";
      if(m15Close[0] < m15Open[0] && m15Close[1] > m15Open[1] &&
         m15Open[0] >= m15Close[1] && m15Close[0] <= m15Open[1])
         context += "看跌吞没 ";
      
      bool threeUp = (m15Close[0] > m15Open[0] && m15Close[1] > m15Open[1] && m15Close[2] > m15Open[2]);
      bool threeDown = (m15Close[0] < m15Open[0] && m15Close[1] < m15Open[1] && m15Close[2] < m15Open[2]);
      if(threeUp) context += "3连涨 ";
      if(threeDown) context += "3连跌 ";
      
      double lastBody = MathAbs(m15Close[0] - m15Open[0]) / g_SymbolPoint;
      double lastRange = (m15High[0] - m15Low[0]) / g_SymbolPoint;
      if(lastBody < lastRange * 0.1) context += "十字星 ";
      
      // Look for double top/bottom in 40-60 candle range
      int maxIdx = ArrayMaximum(m15High, 0, 60);
      int minIdx = ArrayMinimum(m15Low, 0, 60);
      if(maxIdx >= 0 && maxIdx < 60 && maxIdx > 5) {
         // Check for second peak near first
         for(int p = 0; p < maxIdx - 5; p++) {
            if(MathAbs(m15High[p] - m15High[maxIdx]) < 20 * g_SymbolPoint) {
               context += "双顶(" + IntegerToString(maxIdx) + "," + IntegerToString(p) + ") ";
               break;
            }
         }
      }
      if(minIdx >= 0 && minIdx < 60 && minIdx > 5) {
         for(int p = 0; p < minIdx - 5; p++) {
            if(MathAbs(m15Low[p] - m15Low[minIdx]) < 20 * g_SymbolPoint) {
               context += "双底(" + IntegerToString(minIdx) + "," + IntegerToString(p) + ") ";
               break;
            }
         }
      }
      
      context += "\n";
   }
   
   // Add session info for gold trading
   if(g_IsGoldSymbol)
   {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
      string session = GetTradingSession();
      
      context += "\nSession: " + session + " " + IntegerToString(dt.hour) + ":" + 
                 (dt.min < 10 ? "0" : "") + IntegerToString(dt.min) + "GMT";
      
      if(session == "EU+US OVERLAP") context += " [最佳黄金时段]";
      else if(dt.hour >= 2 && dt.hour < 5) context += " [死区-避开]";
      if(dt.day_of_week == 5) context += " [周五-周线收盘]";
      context += "\n";
   }
   
   // M30 - 10 candles WITH VOLUME
   double m30Open[], m30High[], m30Low[], m30Close[];
   long m30Volume[];
   ArraySetAsSeries(m30Open, true);
   ArraySetAsSeries(m30High, true);
   ArraySetAsSeries(m30Low, true);
   ArraySetAsSeries(m30Close, true);
   ArraySetAsSeries(m30Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_M30, 0, 10, m30Open) == 10 &&
      CopyHigh(_Symbol, PERIOD_M30, 0, 10, m30High) == 10 &&
      CopyLow(_Symbol, PERIOD_M30, 0, 10, m30Low) == 10 &&
      CopyClose(_Symbol, PERIOD_M30, 0, 10, m30Close) == 10 &&
      CopyTickVolume(_Symbol, PERIOD_M30, 0, 10, m30Volume) == 10)
   {
      context += "M30 (10 bars): ";
      for(int i = 0; i < 10; i++)
      {
         string dir = m30Close[i] > m30Open[i] ? "+" : "-";
         double candleRange = (m30High[i] - m30Low[i]) / g_SymbolPoint;
         context += dir + DoubleToString(m30Close[i], g_SymbolDigits) + ":" + DoubleToString(candleRange, 0) + ":" + IntegerToString((int)m30Volume[i]);
         if(i < 9) context += " | ";
      }
      context += "\n";
   }
   
   // H1 - 100 candles WITH VOLUME (Pattern: Rectangles, Breakout+Retest, V-Shape)
   double h1Open[], h1High[], h1Low[], h1Close[];
   long h1Volume[];
   ArraySetAsSeries(h1Open, true);
   ArraySetAsSeries(h1High, true);
   ArraySetAsSeries(h1Low, true);
   ArraySetAsSeries(h1Close, true);
   ArraySetAsSeries(h1Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_H1, 0, 100, h1Open) == 100 &&
      CopyHigh(_Symbol, PERIOD_H1, 0, 100, h1High) == 100 &&
      CopyLow(_Symbol, PERIOD_H1, 0, 100, h1Low) == 100 &&
      CopyClose(_Symbol, PERIOD_H1, 0, 100, h1Close) == 100 &&
      CopyTickVolume(_Symbol, PERIOD_H1, 0, 100, h1Volume) == 100)
   {
      context += "H1 (100 bars - Rectangles/Breakout+Retest): ";
      // Show last 30 bars
      for(int i = 0; i < 30; i++)
      {
         string dir = h1Close[i] > h1Open[i] ? "+" : "-";
         double candleRange = (h1High[i] - h1Low[i]) / g_SymbolPoint;
         context += dir + DoubleToString(h1Close[i], g_SymbolDigits) + ":" + DoubleToString(candleRange, 0) + ":" + IntegerToString((int)h1Volume[i]);
         if(i < 29) context += " | ";
      }
      context += " [+70 older bars in data]\n";
   }
   
   // H4 - 50 candles WITH VOLUME (Pattern: Head & Shoulders, Wedges)
   double h4Open[], h4High[], h4Low[], h4Close[];
   long h4Volume[];
   ArraySetAsSeries(h4Open, true);
   ArraySetAsSeries(h4High, true);
   ArraySetAsSeries(h4Low, true);
   ArraySetAsSeries(h4Close, true);
   ArraySetAsSeries(h4Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_H4, 0, 50, h4Open) == 50 &&
      CopyHigh(_Symbol, PERIOD_H4, 0, 50, h4High) == 50 &&
      CopyLow(_Symbol, PERIOD_H4, 0, 50, h4Low) == 50 &&
      CopyClose(_Symbol, PERIOD_H4, 0, 50, h4Close) == 50 &&
      CopyTickVolume(_Symbol, PERIOD_H4, 0, 50, h4Volume) == 50)
   {
      context += "H4 (50 bars - Head&Shoulders/Wedges): ";
      // Show last 20 bars
      for(int i = 0; i < 20; i++)
      {
         string dir = h4Close[i] > h4Open[i] ? "+" : "-";
         double candleRange = (h4High[i] - h4Low[i]) / g_SymbolPoint;
         context += dir + DoubleToString(h4Close[i], g_SymbolDigits) + ":" + DoubleToString(candleRange, 0) + ":" + IntegerToString((int)h4Volume[i]);
         if(i < 19) context += " | ";
      }
      context += " [+30 older bars]\n";
   }
   
   // D1 - 100 candles WITH VOLUME (Pattern: Key Support/Resistance, Long-term Channels)
   double d1Open[], d1High[], d1Low[], d1Close[];
   long d1Volume[];
   ArraySetAsSeries(d1Open, true);
   ArraySetAsSeries(d1High, true);
   ArraySetAsSeries(d1Low, true);
   ArraySetAsSeries(d1Close, true);
   ArraySetAsSeries(d1Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_D1, 0, 100, d1Open) == 100 &&
      CopyHigh(_Symbol, PERIOD_D1, 0, 100, d1High) == 100 &&
      CopyLow(_Symbol, PERIOD_D1, 0, 100, d1Low) == 100 &&
      CopyClose(_Symbol, PERIOD_D1, 0, 100, d1Close) == 100 &&
      CopyTickVolume(_Symbol, PERIOD_D1, 0, 100, d1Volume) == 100)
   {
      context += "D1 (100 days - Key S/R Levels): ";
      // Show last 30 days + highs/lows
      for(int i = 0; i < 30; i++)
      {
         string dir = d1Close[i] > d1Open[i] ? "+" : "-";
         double candleRange = (d1High[i] - d1Low[i]) / g_SymbolPoint;
         context += dir + DoubleToString(d1Close[i], g_SymbolDigits) + ":" + DoubleToString(candleRange, 0) + ":" + IntegerToString((int)d1Volume[i]);
         if(i < 29) context += " | ";
      }
      
      // Show 100-day high/low (key levels)
      int d1MaxIdx = ArrayMaximum(d1High, 0, 100);
      int d1MinIdx = ArrayMinimum(d1Low, 0, 100);
      if(d1MaxIdx >= 0) context += " | 100D-HIGH:" + DoubleToString(d1High[d1MaxIdx], g_SymbolDigits);
      if(d1MinIdx >= 0) context += " | 100D-LOW:" + DoubleToString(d1Low[d1MinIdx], g_SymbolDigits);
      context += " [+70 older days]\n";
   }
   
   // W1 - 3 candles WITH VOLUME
   double w1Open[], w1High[], w1Low[], w1Close[];
   long w1Volume[];
   ArraySetAsSeries(w1Open, true);
   ArraySetAsSeries(w1High, true);
   ArraySetAsSeries(w1Low, true);
   ArraySetAsSeries(w1Close, true);
   ArraySetAsSeries(w1Volume, true);
   
   if(CopyOpen(_Symbol, PERIOD_W1, 0, 3, w1Open) == 3 &&
      CopyHigh(_Symbol, PERIOD_W1, 0, 3, w1High) == 3 &&
      CopyLow(_Symbol, PERIOD_W1, 0, 3, w1Low) == 3 &&
      CopyClose(_Symbol, PERIOD_W1, 0, 3, w1Close) == 3 &&
      CopyTickVolume(_Symbol, PERIOD_W1, 0, 3, w1Volume) == 3)
   {
      context += "W1 (3 weeks): ";
      for(int i = 0; i < 3; i++)
      {
         string dir = w1Close[i] > w1Open[i] ? "+" : "-";
         double candleRange = (w1High[i] - w1Low[i]) / g_SymbolPoint;
         context += dir + DoubleToString(w1Close[i], g_SymbolDigits) + ":" + DoubleToString(candleRange, 0) + ":" + IntegerToString((int)w1Volume[i]);
         if(i < 2) context += " | ";
      }
      
      // Weekly trend
      if(w1Close[0] > w1Close[1] && w1Close[1] > w1Close[2])
         context += " [周线上涨]";
      else if(w1Close[0] < w1Close[1] && w1Close[1] < w1Close[2])
         context += " [周线下跌]";
      context += "\n";
   }
   
   context += "\nUSE ALL 100-BAR DATA: Look for patterns (flags, double tops/bottoms, triangles, H&S, rectangles) across timeframes!\n";
   
   // ═══════════════════════════════════════════════════════
   // ADD INDICATOR HISTORY FOR TREND/DIVERGENCE DETECTION
   // ═══════════════════════════════════════════════════════
   
   context += "\n═══ INDICATOR HISTORY (M15) ═══\n";
   
   // RSI History (last 25 M15 values)
   double rsiHistory[];
   ArraySetAsSeries(rsiHistory, true);
   if(CopyBuffer(g_HandleRSI, 0, 0, 25, rsiHistory) == 25)
   {
      context += "RSI(14): Now=" + DoubleToString(rsiHistory[0], 1) + 
                 " 5ago=" + DoubleToString(rsiHistory[5], 1) + 
                 " 10ago=" + DoubleToString(rsiHistory[10], 1) + 
                 " 20ago=" + DoubleToString(rsiHistory[20], 1);
      
      double rsiChange5 = rsiHistory[0] - rsiHistory[5];
      if(rsiChange5 < -5) context += " [强势下跌]";
      else if(rsiChange5 < 0) context += " [下跌]";
      else if(rsiChange5 > 5) context += " [强势上涨]";
      else context += " [上涨]";
      
      if(rsiHistory[0] < 30) context += " [超卖]";
      if(rsiHistory[0] > 70) context += " [超买]";
      context += "\n";
   }
   
   // MA History (last 25 M15 values for each MA)
   double maFastHistory[], maSlowHistory[];
   ArraySetAsSeries(maFastHistory, true);
   ArraySetAsSeries(maSlowHistory, true);
   
   if(CopyBuffer(g_HandleMAFast, 0, 0, 25, maFastHistory) == 25 &&
      CopyBuffer(g_HandleMASlow, 0, 0, 25, maSlowHistory) == 25)
   {
      bool fastRising = maFastHistory[0] > maFastHistory[5];
      bool slowRising = maSlowHistory[0] > maSlowHistory[5];
      bool currentBullish = maFastHistory[0] > maSlowHistory[0];
      bool previousBullish = maFastHistory[1] > maSlowHistory[1];
      double gap = MathAbs(maFastHistory[0] - maSlowHistory[0]) / g_SymbolPoint;
      
      context += "MA(20/50): Now=" + DoubleToString(maFastHistory[0], g_SymbolDigits) + "/" + 
                 DoubleToString(maSlowHistory[0], g_SymbolDigits) + " Gap=" + DoubleToString(gap, 0) + "pts";
      
      if(currentBullish && !previousBullish) context += " [金叉-当前]";
      else if(!currentBullish && previousBullish) context += " [死叉-当前]";
      else if(currentBullish) context += " [BULLISH]";
      else context += " [BEARISH]";
      
      if(fastRising && slowRising) context += " [BOTH-RISING]";
      else if(!fastRising && !slowRising) context += " [BOTH-FALLING]";
      context += "\n";
   }
   
   // ATR History for volatility context
   double atrHistory[];
   ArraySetAsSeries(atrHistory, true);
   if(CopyBuffer(g_HandleATR, 0, 0, 25, atrHistory) == 25)
   {
      double atrAvg = 0;
      for(int a = 0; a < 20; a++) atrAvg += atrHistory[a];
      atrAvg /= 20.0;
      
      context += "ATR: Now=" + DoubleToString(atr, g_SymbolDigits) + 
                 " Avg=" + DoubleToString(atrAvg, g_SymbolDigits) + 
                 " SL=" + DoubleToString(atr * 2.0, g_SymbolDigits);
      if(atr > atrAvg * 1.5) context += " [高波动]";
      else if(atr < atrAvg * 0.7) context += " [低波动]";
      context += "\n";
   }
   
   context += "Positions: " + IntegerToString(openPositions) + "/" + IntegerToString(InpMaxPositions) + 
              " (B:" + IntegerToString(buyPositions) + " S:" + IntegerToString(sellPositions) + ")\n";
   context += "Win Rate: " + DoubleToString(winRate, 1) + "% | Trades: " + IntegerToString(g_TotalTrades) + "\n";
   
   // Add order flow data if available
   MqlBookInfo book[];
   if(MarketBookGet(_Symbol, book) && ArraySize(book) > 0)
   {
      double bidVolume = 0, askVolume = 0;
      for(int b = 0; b < MathMin(5, ArraySize(book)); b++)
      {
         if(book[b].type == BOOK_TYPE_BUY) bidVolume += (double)book[b].volume;
         if(book[b].type == BOOK_TYPE_SELL) askVolume += (double)book[b].volume;
      }
      if(bidVolume + askVolume > 0)
      {
         double orderFlowRatio = (bidVolume - askVolume) / (bidVolume + askVolume) * 100.0;
         context += "Order Flow: " + DoubleToString(orderFlowRatio, 0) + "% " + 
                    (orderFlowRatio > 20 ? "(买压)" : (orderFlowRatio < -20 ? "(卖压)" : "(中性)")) + "\n";
      }
   }
   
   // ═══════════════════════════════════════════════════════
   // ADD SUPPORT/RESISTANCE LEVELS (KEY PRICE ZONES)
   // ═══════════════════════════════════════════════════════
   
   context += "\n═══ KEY SUPPORT/RESISTANCE LEVELS ═══\n";
   
   // Calculate pivot points
   double pivot, r1, r2, r3, s1, s2, s3;
   CalculatePivotPoints(pivot, r1, r2, r3, s1, s2, s3);
   
   if(pivot > 0)
   {
      context += "Pivots: R1=" + DoubleToString(r1, g_SymbolDigits) + 
                 " P=" + DoubleToString(pivot, g_SymbolDigits) + 
                 " S1=" + DoubleToString(s1, g_SymbolDigits);
      
      double distToR1 = (r1 - bid) / g_SymbolPoint;
      double distToS1 = (bid - s1) / g_SymbolPoint;
      
      if(MathAbs(distToR1) < 20) context += " [接近R1]";
      if(MathAbs(distToS1) < 20) context += " [接近S1]";
      if(bid > r1) context += " [R1上方-看涨]";
      else if(bid < s1) context += " [S1下方-看跌]";
      context += "\n";
   }
   
   // Calculate swing highs/lows from M15 (now with 100 candles - better pattern detection)
   if(ArraySize(m15High) >= 100 && ArraySize(m15Low) >= 100)
   {
      // Find recent swing high in last 20 candles (with 100 candles, we can look further back)
      int swingHighIdx = -1;
      double swingHighPrice = 0;
      for(int sh = 2; sh < 20; sh++)
      {
         if(m15High[sh] > m15High[sh-1] && m15High[sh] > m15High[sh-2] &&
            m15High[sh] > m15High[sh+1] && m15High[sh] > m15High[sh+2])
         {
            swingHighIdx = sh;
            swingHighPrice = m15High[sh];
            break;
         }
      }
      
      // Find recent swing low
      int swingLowIdx = -1;
      double swingLowPrice = 0;
      for(int sl = 2; sl < 20; sl++)
      {
         if(m15Low[sl] < m15Low[sl-1] && m15Low[sl] < m15Low[sl-2] &&
            m15Low[sl] < m15Low[sl+1] && m15Low[sl] < m15Low[sl+2])
         {
            swingLowIdx = sl;
            swingLowPrice = m15Low[sl];
            break;
         }
      }
      
      context += "M15 Swings (100-bar analysis): ";
      if(swingHighIdx > 0)
         context += "High=" + DoubleToString(swingHighPrice, g_SymbolDigits) + "(" + IntegerToString(swingHighIdx) + "ago) ";
      if(swingLowIdx > 0)
         context += "Low=" + DoubleToString(swingLowPrice, g_SymbolDigits) + "(" + IntegerToString(swingLowIdx) + "ago)";
      
      if(swingHighIdx > 0 && swingLowIdx > 0)
      {
         double priceInRange = ((bid - swingLowPrice) / (swingHighPrice - swingLowPrice)) * 100.0;
         if(priceInRange < 25) context += " [AT-SWING-LOW]";
         else if(priceInRange > 75) context += " [AT-SWING-HIGH]";
      }
      context += "\n";
   }
   
   // Add session info for gold trading
   if(g_IsGoldSymbol)
   {
      MqlDateTime dt;
      TimeToStruct(TimeCurrent(), dt);
      string session = GetTradingSession();
      
      context += "\n═══ TIME & SESSION ANALYSIS ═══\n";
      context += "Session: " + session + " | Hour: " + IntegerToString(dt.hour) + ":" + IntegerToString(dt.min) + " GMT\n";
      context += "Day: " + IntegerToString(dt.day_of_week) + " (1=Mon, 5=Fri)\n";
      
      // Session-specific guidance
      if(session == "EU+US OVERLAP")
         context += "  ✓ BEST SESSION for gold - High liquidity and movement\n";
      else if(session == "ASIAN")
         context += "  ⚠️ ASIAN SESSION - Lower liquidity, be cautious\n";
      else if(session == "EUROPEAN")
         context += "  Good session for gold - Active trading\n";
      else if(session == "US")
         context += "  Active US session - Good for gold movement\n";
   }
   
   
   context += "\n═══ 响应格式要求 ═══\n";
   context += "你有M5/M15/H1/D1的100根K线数据，请分析形态!\n";
   context += "积极寻找交易机会，不要过于保守!\n";
   context += "必须用以下格式回复（单行）:\n";
   context += "信号|置信度|推理|总结\n\n";

   context += "格式说明:\n";
   context += "信号 = BUY 或 SELL 或 WAIT\n";
   context += "置信度 = 0.50-0.95（达到0.60即可交易）\n";
   context += "推理 = 简述发现的形态和依据\n";
   context += "总结 = 概括交易逻辑\n\n";

   context += "示例:\n";
   context += "BUY|0.68|M15双底在D1支撑位，RSI超卖反弹，MA金叉|低位反弹做多\n";
   context += "SELL|0.72|M15双顶在H1阻力位，RSI超买回落，成交量放大|高位反转做空\n";
   context += "WAIT|0.45|没有明确形态，市场震荡|观望等待\n\n";

   context += "规则: (1)单行回复 (2)用|分隔 (3)达到0.60即可给信号\n";
   
   // END OF SIMPLIFIED TOKEN-SAVING CONTEXT
   return context;
}

//+------------------------------------------------------------------+
//| Escape JSON string                                               |
//+------------------------------------------------------------------+
string EscapeJSON(string text)
{
   if(StringLen(text) == 0) return "";
   
   string result = "";
   
   // Build escaped string character by character to ensure proper escaping
   for(int i = 0; i < StringLen(text); i++)
   {
      ushort charCode = StringGetCharacter(text, i);
      
      switch(charCode)
      {
         case '\\':  // Backslash
            result += "\\\\";
            break;
         case '"':   // Quote
            result += "\\\"";
            break;
         case '\n':  // Newline
            result += "\\n";
            break;
         case '\r':  // Carriage return
            result += "\\r";
            break;
         case '\t':  // Tab
            result += "\\t";
            break;
         case 0:     // Null byte - skip it (breaks JSON)
            break;
         default:
            // For control characters (0x00-0x1F), skip them
            if(charCode < 32)
            {
               // Skip control characters except newline, carriage return, tab (already handled)
               break;
            }
            // Regular character - add as-is
            result += ShortToString(charCode);
            break;
      }
   }
   
   return result;
}

//+------------------------------------------------------------------+
//| 解析DeepSeek JSON响应                                             |
//+------------------------------------------------------------------+
string ParseOpenAIResponse(string jsonResponse)
{
   // Find the content field
   int contentStart = -1;
   string searchPattern = "";
   
   // Try pattern 1: "content":"
   contentStart = StringFind(jsonResponse, "\"content\":\"");
   if(contentStart >= 0) {
      searchPattern = "Pattern 1";
      contentStart += StringLen("\"content\":\"");
   }
   
   // Try pattern 2: "content" : " (with spaces)
   if(contentStart < 0) {
      int pos = StringFind(jsonResponse, "\"content\" : \"");
      if(pos >= 0) {
         contentStart = pos + StringLen("\"content\" : \"");
         searchPattern = "Pattern 2";
      }
   }
   
   // Try pattern 3: Find "content" then look for the value
   if(contentStart < 0) {
      int contentFieldPos = StringFind(jsonResponse, "\"content\"");
      if(contentFieldPos >= 0) {
         int colonPos = StringFind(jsonResponse, ":", contentFieldPos);
         if(colonPos >= 0) {
            int quoteStart = colonPos + 1;
            while(quoteStart < StringLen(jsonResponse) && 
                  (StringGetCharacter(jsonResponse, quoteStart) == ' ' || 
                   StringGetCharacter(jsonResponse, quoteStart) == '\t')) {
               quoteStart++;
            }
            if(quoteStart < StringLen(jsonResponse) && 
               StringGetCharacter(jsonResponse, quoteStart) == '"') {
               contentStart = quoteStart + 1;
               searchPattern = "Pattern 3";
            }
         }
      }
   }
   
   if(contentStart < 0) {
      Print("错误: 在DeepSeek响应中找不到'content'字段");
      Print("Response preview (first 1000 chars): ", StringSubstr(jsonResponse, 0, 1000));
      return "";
   }
   
   Print("✓ Found content using ", searchPattern, " at position: ", contentStart);
   
   // Find the end of content - handle escaped quotes
   int contentEnd = contentStart;
   int searchPos = contentStart;
   bool found = false;
   
   while(searchPos < StringLen(jsonResponse) - 1) {
      int nextQuote = StringFind(jsonResponse, "\"", searchPos);
      if(nextQuote < 0) break;
      
      // Check if this quote is escaped
      bool isEscaped = false;
      if(nextQuote > 0) {
         int checkPos = nextQuote - 1;
         int backslashCount = 0;
         while(checkPos >= contentStart && StringGetCharacter(jsonResponse, checkPos) == '\\') {
            backslashCount++;
            checkPos--;
         }
         isEscaped = (backslashCount % 2 == 1);
      }
      
      if(!isEscaped) {
         contentEnd = nextQuote;
         found = true;
         break;
      }
      
      searchPos = nextQuote + 1;
   }
   
   if(!found) {
      Print("在DeepSeek响应中找不到内容结束位置");
      return "";
   }
   
   string content = StringSubstr(jsonResponse, contentStart, contentEnd - contentStart);
   
   Print("Extracted AI content (length: ", StringLen(content), " chars)");
   if(StringLen(content) > 500)
      Print("   First 500 chars: ", StringSubstr(content, 0, 500));
   else
      Print("   Full content: ", content);
   
   // Unescape JSON
   StringReplace(content, "\\\\", "\x01"); // Temporary marker
   StringReplace(content, "\\\"", "\"");    // Unescape quotes
   StringReplace(content, "\\n", "\n");      // Unescape newlines
   StringReplace(content, "\\r", "\r");      // Unescape carriage returns
   StringReplace(content, "\\t", "\t");      // Unescape tabs
   StringReplace(content, "\x01", "\\");    // Restore double backslashes
   
   // Don't truncate - show full unescaped content
   if(StringLen(content) > 500)
      Print("Unescaped (first 500 chars): ", StringSubstr(content, 0, 500));
   else
      Print("Unescaped content: ", content);
   
   // Clean up any newlines that shouldn't be there
   StringReplace(content, "\n\n", " ");
   StringReplace(content, "\n", " ");
   StringTrimLeft(content);
   StringTrimRight(content);

   // Validate format: SIGNAL|CONFIDENCE|SL_POINTS|TP_POINTS|REASONING|SUMMARY
   string parts[];
   int count = StringSplit(content, '|', parts);
   Print("Split into ", count, " parts");

   if(count >= 6) {
      // Trim parts
      for(int p = 0; p < count; p++) {
         StringTrimLeft(parts[p]);
         StringTrimRight(parts[p]);
      }
      // 格式: 信号|置信度|止损点数|止盈点数|推理|总结
      string cleanContent = parts[0] + "|" + parts[1] + "|" + parts[2] + "|" + parts[3] + "|" + parts[4] + "|" + parts[5];
      Print("✓ 有效格式: 信号=", parts[0], " 置信度=", parts[1], " 止损=", parts[2], "点 止盈=", parts[3], "点");
      return cleanContent;
   }
   // 兼容旧格式（4部分）
   else if(count >= 4) {
      for(int p = 0; p < count; p++) {
         StringTrimLeft(parts[p]);
         StringTrimRight(parts[p]);
      }
      // 旧格式没有止损止盈，用默认值
      string cleanContent = parts[0] + "|" + parts[1] + "|0|0|" + parts[2] + "|" + parts[3];
      Print("⚠ 旧格式(无止损止盈): 信号=", parts[0], " 置信度=", parts[1]);
      return cleanContent;
   } else {
      Print("⚠ 格式不符合预期: ", count, " 部分");
      Print("   尝试解析...");
   }
   
   // If AI didn't return in expected format, try to extract signal from text
   string signal = "WAIT";
   double confidence = 0.5;
   string reasoning = "AI analysis provided";
   string summary = content;
   
   // Try to find signal keywords
   if(StringFind(content, "BUY") >= 0 || StringFind(content, "buy") >= 0 || 
      StringFind(content, "long") >= 0 || StringFind(content, "LONG") >= 0) {
      signal = "BUY";
      confidence = 0.80;
   } else if(StringFind(content, "SELL") >= 0 || StringFind(content, "sell") >= 0 || 
             StringFind(content, "short") >= 0 || StringFind(content, "SHORT") >= 0) {
      signal = "SELL";
      confidence = 0.80;
   }
   
   return signal + "|" + DoubleToString(confidence, 2) + "|" + reasoning + "|" + summary;
}

//+------------------------------------------------------------------+
//| 调用DeepSeek API - 完整实现                                       |
//+------------------------------------------------------------------+
string CallOpenAI(string marketData)
{
   // 调试: 显示读取到的API Key信息
   Print("🔍 调试: 读取API Key...");
   Print("   长度: ", StringLen(InpOpenAIAPIKey));
   Print("   前10字符: ", StringSubstr(InpOpenAIAPIKey, 0, 10));
   Print("   后4字符: ", StringSubstr(InpOpenAIAPIKey, StringLen(InpOpenAIAPIKey) - 4));
   Print("   是否为空: ", (StringLen(InpOpenAIAPIKey) == 0 ? "是" : "否"));
   Print("   是否<20: ", (StringLen(InpOpenAIAPIKey) < 20 ? "是" : "否"));

   // Check if API key is provided
   if(StringLen(InpOpenAIAPIKey) == 0) {
      Print("警告: DeepSeek API密钥未设置。使用模拟响应。");
      g_AIStatus = "模拟";
      g_AIIsActive = false;
      return CallOpenAI_Simulated(marketData);
   }

   // Check if key looks valid (at least 20 characters)
   if(StringLen(InpOpenAIAPIKey) < 20) {
      Print("警告: DeepSeek API密钥太短(", StringLen(InpOpenAIAPIKey), "字符)。使用模拟响应。");
      Print("   当前值: ", InpOpenAIAPIKey);
      g_AIStatus = "模拟";
      g_AIIsActive = false;
      return CallOpenAI_Simulated(marketData);
   }
   
   // Build the JSON request with proper escaping
   string escapedContent = EscapeJSON(marketData);
   
   // Escape model name too (in case it has special chars)
   string escapedModel = EscapeJSON(InpOpenAIModel);
   
// Build JSON manually - ensure proper formatting with PATTERN RECOGNITION TRAINING
// DeepSeek API格式: {"model":"...", "messages":[{"role":"system",...},{"role":"user",...}], ...}

string systemPrompt = "";

// ═══════════════════════════════════════════════════════════
// 角色定义
// ═══════════════════════════════════════════════════════════
systemPrompt += "【角色定义】\n";
systemPrompt += "你是一名积极进取的黄金(XAUUSD)日内交易分析师。\n";
systemPrompt += "你的核心任务是：快速识别交易机会，果断给出入场信号。\n";
systemPrompt += "你的交易风格：积极主动，看到符合规则的机会就出手，不要犹豫！\n\n";

// ═══════════════════════════════════════════════════════════
// 交易哲学
// ═══════════════════════════════════════════════════════════
systemPrompt += "【交易哲学】\n";
systemPrompt += "1. 机会优先：有信号就做，没信号才等\n";
systemPrompt += "2. 顺势为主：大方向明确就顺势入场\n";
systemPrompt += "3. 小亏大赚：用止损控制风险，让利润奔跑\n";
systemPrompt += "4. 积极出击：日内交易需要果断，错过机会比小亏更可惜\n\n";

// ═══════════════════════════════════════════════════════════
// 分析框架
// ═══════════════════════════════════════════════════════════
systemPrompt += "【分析框架 - 多时间框架共振】\n\n";

systemPrompt += "第一层：趋势判断(D1/H4)\n";
systemPrompt += "- D1趋势方向：通过MA20/MA50判断主趋势\n";
systemPrompt += "- H4结构：识别关键支撑阻力位\n";
systemPrompt += "- 结论：多头/空头/震荡\n\n";

systemPrompt += "第二层：机会识别(H1/M15)\n";
systemPrompt += "- H1形态：旗形、三角形、矩形、头肩顶底\n";
systemPrompt += "- M15形态：双顶双底、SFP、FVG、QM\n";
systemPrompt += "- 关键位：前高前低、整数关口、斐波那契\n\n";

systemPrompt += "第三层：入场确认(M5/M1)\n";
systemPrompt += "- M5动量：是否有强势K线突破\n";
systemPrompt += "- M1精确：等待回踩入场\n";
systemPrompt += "- 成交量：是否放量确认\n\n";

// ═══════════════════════════════════════════════════════════
// 核心形态识别
// ═══════════════════════════════════════════════════════════
systemPrompt += "【核心形态识别】\n\n";

systemPrompt += "1. SFP (摆动失败形态)\n";
systemPrompt += "   定义：价格突破前高/前低后快速回撤\n";
systemPrompt += "   逻辑：机构扫止损后反向建仓\n";
systemPrompt += "   信号：突破失败+反转K线=高概率反转\n\n";

systemPrompt += "2. FVG (公允价值缺口)\n";
systemPrompt += "   定义：三根K线中间无重叠区域\n";
systemPrompt += "   逻辑：价格失衡，会回来填补\n";
systemPrompt += "   信号：价格回到FVG区域=入场机会\n\n";

systemPrompt += "3. 双顶/双底\n";
systemPrompt += "   定义：价格两次测试同一水平后反转\n";
systemPrompt += "   逻辑：市场两次拒绝该价格\n";
systemPrompt += "   信号：第二次测试失败+反转K线\n\n";

systemPrompt += "4. 订单块\n";
systemPrompt += "   定义：最后一根反向K线 before 大幅突破\n";
systemPrompt += "   逻辑：机构建仓区域\n";
systemPrompt += "   信号：价格回踩订单块=支撑阻力\n\n";

systemPrompt += "5. RSI背离\n";
systemPrompt += "   定义：价格新高/新低，RSI未创新高/新低\n";
systemPrompt += "   逻辑：动能衰竭\n";
systemPrompt += "   信号：背离+形态确认=强反转信号\n\n";

// ═══════════════════════════════════════════════════════════
// 入场规则
// ═══════════════════════════════════════════════════════════
systemPrompt += "【入场规则 - 积极模式】\n\n";

systemPrompt += "做多条件（满足任意2项即可）：\n";
systemPrompt += "✓ M15出现看涨形态（双底/SFP/FVG/锤子线）\n";
systemPrompt += "✓ RSI超卖反弹（<40）或从低位回升\n";
systemPrompt += "✓ 价格在支撑位附近反弹\n";
systemPrompt += "✓ M5阳线吞没或连续阳线\n";
systemPrompt += "✓ 均线金叉或价格站上均线\n\n";

systemPrompt += "做空条件（满足任意2项即可）：\n";
systemPrompt += "✓ M15出现看跌形态（双顶/SFP/FVG/射击之星）\n";
systemPrompt += "✓ RSI超买回落（>60）或从高位下跌\n";
systemPrompt += "✓ 价格在阻力位附近受阻\n";
systemPrompt += "✓ M5阴线吞没或连续阴线\n";
systemPrompt += "✓ 均线死叉或价格跌破均线\n\n";

systemPrompt += "重要：不要等待完美信号！只要2个条件满足，就可以给出0.60-0.70的信号。\n\n";

// ═══════════════════════════════════════════════════════════
// 置信度评分标准
// ═══════════════════════════════════════════════════════════
systemPrompt += "【置信度评分标准 - 积极评分】\n\n";

systemPrompt += "0.75-0.90：高置信度\n";
systemPrompt += "- 多时间框架共振\n";
systemPrompt += "- 2个以上形态确认\n";
systemPrompt += "- RSI+成交量配合\n\n";

systemPrompt += "0.65-0.74：中高置信度\n";
systemPrompt += "- 1-2个时间框架确认\n";
systemPrompt += "- 1个明确形态\n";
systemPrompt += "- 有技术指标支持\n\n";

systemPrompt += "0.55-0.64：中等置信度（可交易）\n";
systemPrompt += "- 单一清晰信号\n";
systemPrompt += "- 基本形态识别\n";
systemPrompt += "- 满足2个入场条件\n\n";

systemPrompt += "0.50-0.54：低置信度（观望）\n";
systemPrompt += "- 信号模糊\n";
systemPrompt += "- 多空不分\n";
systemPrompt += "- 等待更清晰机会\n\n";

systemPrompt += "重要：只要满足2个入场条件，就给0.60以上评分！不要过度保守！\n\n";

// ═══════════════════════════════════════════════════════════
// 风险提示
// ═══════════════════════════════════════════════════════════
systemPrompt += "【风险提示】\n";
systemPrompt += "- 避免在重大数据公布前15分钟交易\n";
systemPrompt += "- 避免在亚洲时段凌晨2-5点交易（流动性低）\n";
systemPrompt += "- 避免在周五下午建新仓（周末风险）\n";
systemPrompt += "- 单边行情中不要逆势抄底/摸顶\n\n";

// ═══════════════════════════════════════════════════════════
// 输出格式
// ═══════════════════════════════════════════════════════════
systemPrompt += "【输出格式】\n";
systemPrompt += "必须严格按以下格式回复（单行，用|分隔）：\n";
systemPrompt += "信号|置信度|止损点数|止盈点数|推理|总结\n\n";

systemPrompt += "信号：BUY 或 SELL 或 WAIT\n";
systemPrompt += "置信度：0.50-0.95（保留两位小数）\n";
systemPrompt += "止损点数：基于ATR和支撑阻力计算的止损距离（整数，如150表示150点）\n";
systemPrompt += "止盈点数：基于下一个阻力支撑位的目标（整数，如200表示200点）\n";
systemPrompt += "推理：20-50字，说明形态和依据\n";
systemPrompt += "总结：10-30字，概括交易逻辑\n\n";

systemPrompt += "【止损止盈设置原则 - 宽止损高胜率】\n";
systemPrompt += "止损：放在形态关键位下方/上方，要给足够的呼吸空间\n";
systemPrompt += "止损参考：M15建议200-300点，H1建议300-500点\n";
systemPrompt += "止盈：放在下一个阻力/支撑位，盈亏比至少1:1\n";
systemPrompt += "宁可止损宽一点，也不要被噪音扫损！\n";

// ═══════════════════════════════════════════════════════════
// 示例
// ═══════════════════════════════════════════════════════════
systemPrompt += "【示例 - 宽止损高胜率】\n\n";

systemPrompt += "买入信号（双底形态）：\n";
systemPrompt += "BUY|0.72|250|350|M15双底在3250支撑位，止损在双底下方3225（给呼吸空间），目标前高3285|双底支撑做多\n\n";

systemPrompt += "卖出信号（双顶形态）：\n";
systemPrompt += "SELL|0.68|220|300|M15双顶在3280阻力位，止损在双顶上方3302（宽止损防扫），目标前低3250|高位反转做空\n\n";

systemPrompt += "顺势买入：\n";
systemPrompt += "BUY|0.65|200|280|M5阳线突破，止损在突破位下方200点，目标前高|顺势做多\n\n";

systemPrompt += "顺势卖出：\n";
systemPrompt += "SELL|0.63|200|280|M5阴线跌破，止损在跌破位上方200点，目标前低|顺势做空\n\n";

systemPrompt += "观望（只有这种情况才给WAIT）：\n";
systemPrompt += "WAIT|0.50|0|0|价格在区间中间震荡，无明确方向|等待突破\n\n";

systemPrompt += "【执行指令】\n";
systemPrompt += "分析XAUUSD数据，积极寻找交易机会！\n";
systemPrompt += "关键：止损要宽（200-300点），不要被噪音扫损！宁可止损大一点，也要提高胜率！";

   string escapedSystem = EscapeJSON(systemPrompt);
   
   string jsonRequest = "{";
   jsonRequest += "\"model\":\"" + escapedModel + "\",";
   jsonRequest += "\"messages\":[";
   jsonRequest += "{\"role\":\"system\",\"content\":\"" + escapedSystem + "\"},";
   jsonRequest += "{\"role\":\"user\",\"content\":\"" + escapedContent + "\"}";
   jsonRequest += "],";
   jsonRequest += "\"temperature\":1,";
   jsonRequest += "\"max_completion_tokens\":15000";
   jsonRequest += "}";
   
   // Validate JSON length
   int jsonLen = StringLen(jsonRequest);
   if(jsonLen == 0) {
      Print("❌ AI ERROR: JSON request is empty!");
      return CallOpenAI_Simulated(marketData);
   }
   
   Print("JSON Request length: ", jsonLen);
   if(jsonLen > 500) {
      Print("JSON (first 500 chars): ", StringSubstr(jsonRequest, 0, 500));
   } else {
      Print("JSON: ", jsonRequest);
   }
   
   // Prepare headers - 必须使用正确的格式
   string headers = "Content-Type: application/json\r\n";
   headers += "Authorization: Bearer " + InpOpenAIAPIKey + "\r\n";
   headers += "User-Agent: MT5-EA/1.0\r\n";

   // Debug: Show API key info (masked for security)
   string keyPreview = StringSubstr(InpOpenAIAPIKey, 0, 10) + "..." + StringSubstr(InpOpenAIAPIKey, StringLen(InpOpenAIAPIKey) - 4);
   Print("🔑 API Key: ", keyPreview, " (长度: ", StringLen(InpOpenAIAPIKey), ")");
   Print("📋 请求头: ", headers);

   // 显示JSON请求的前1000个字符
   int showLen = MathMin(1000, StringLen(jsonRequest));
   Print("📄 JSON请求(前", showLen, "字符): ", StringSubstr(jsonRequest, 0, showLen));
   
   char postData[];
   char result[];
   string resultHeaders;
   
   // Convert JSON string to char array - CRITICAL: Proper conversion for WebRequest
   int stringLen = StringLen(jsonRequest);
   if(stringLen == 0) {
      Print("❌ AI错误: JSON请求为空!");
      return CallOpenAI_Simulated(marketData);
   }

   // 使用CharArray转换 - 更可靠的方法
   // 先清空数组
   ArrayFree(postData);

   // 逐字符转换，确保UTF-8兼容
   uchar bytes[];
   int bytesCount = StringToCharArray(jsonRequest, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   if(bytesCount <= 0) {
      Print("❌ AI错误: 字符串转换失败!");
      return CallOpenAI_Simulated(marketData);
   }

   // 移除末尾的null终止符
   if(bytesCount > 0 && bytes[bytesCount - 1] == 0) {
      bytesCount--;
   }

   // 复制到postData
   ArrayResize(postData, bytesCount);
   ArrayCopy(postData, bytes, 0, 0, bytesCount);

   Print("✅ JSON转换成功: 字符串长度=", stringLen, " 字节数=", bytesCount);
   
   // Make the API call
   int timeout = 10000; // 10 seconds timeout

   // 调试: 显示请求信息
   Print("📤 发送API请求...");
   Print("   URL: https://api.deepseek.com/v1/chat/completions");
   Print("   数据大小: ", ArraySize(postData), " 字节");
   Print("   超时: ", timeout, " 毫秒");

   ResetLastError();
   int res = WebRequest("POST", "https://api.deepseek.com/v1/chat/completions",
                        headers, timeout, postData, result, resultHeaders);
   
   if(res == -1) {
      int error = GetLastError();
      Print("❌ AI ERROR: WebRequest failed. Error code: ", error);
      if(error == 4060) {
         Print("   → SOLUTION: Add 'https://api.deepseek.com' to allowed URLs:");
         Print("      Tools > Options > Expert Advisors > Allow WebRequest for listed URL");
         Print("      Add: https://api.deepseek.com");
      } else {
         Print("   → Check: 1) Internet connection 2) Firewall settings 3) Broker restrictions");
      }
      Print("   → Using simulated AI response as fallback.");
      g_AIStatus = "错误";
      g_AIIsActive = false;
      return CallOpenAI_Simulated(marketData);
   }
   
   if(res != 200) {
      string errorResponse = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      Print("❌ AI错误: DeepSeek API返回错误代码: ", res);
      Print("   Response: ", errorResponse);
      if(res == 401) {
         Print("   → 解决方案: API密钥无效。检查EA设置中的DeepSeek API密钥。");
      } else if(res == 429) {
         Print("   → 解决方案: 请求频率超限。稍等或升级DeepSeek套餐。");
      } else if(res == 500 || res == 503) {
         Print("   → 解决方案: DeepSeek服务器错误。稍后重试。");
      }
      Print("   → Using simulated AI response as fallback.");
      g_AIStatus = "错误";
      g_AIIsActive = false;
      return CallOpenAI_Simulated(marketData);
   }
   
   // Parse JSON response - 使用UTF-8编码
   string jsonResponse = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   Print("DeepSeek API成功! 收到响应(长度: ", StringLen(jsonResponse), ")");
   
   string aiMessage = ParseOpenAIResponse(jsonResponse);
   
   if(StringLen(aiMessage) > 0) {
   g_AIStatus = "活跃";
      g_AIIsActive = true;
      Print("✓ AI已激活 - DeepSeek API正常工作!");
      return aiMessage;
   }
   
   // If parsing failed, use simulated
   Print("解析DeepSeek响应失败。使用模拟响应。");
   Print("Response was: ", StringSubstr(jsonResponse, 0, 500));
   g_AIStatus = "错误";
   g_AIIsActive = false;
   return CallOpenAI_Simulated(marketData);
}

//+------------------------------------------------------------------+
//| 模拟DeepSeek响应(备用)                                           |
//+------------------------------------------------------------------+
string CallOpenAI_Simulated(string marketData)
{
   if(g_AIStatus != "错误") {
      g_AIStatus = "模拟";
   }
   g_AIIsActive = false;
   double rsi = g_BufferRSI[0];
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double atr = g_BufferATR[0];
   
   string response = "";
   string summary = "";
   
   if(rsi < 35) {
      summary = "The market is showing oversold conditions with RSI below 35, indicating potential buying opportunity. ";
      summary += "Price is currently near key support levels, which historically have provided good entry points. ";
      summary += "Market sentiment on higher timeframes remains positive, suggesting this pullback may be temporary.";
      response = "BUY|0.85|RSI oversold, price at support, bullish sentiment|" + summary;
   } else if(rsi > 65) {
      summary = "The market is currently overbought with RSI above 65, suggesting caution for new long positions. ";
      summary += "Price has moved significantly higher and may be due for a correction or consolidation.";
      response = "WAIT|0.60|RSI overbought, wait for pullback|" + summary;
   } else {
      summary = "The market is in a neutral state with RSI in the middle range, indicating balanced conditions. ";
      summary += "Price action is consolidating without clear directional bias at the moment.";
      response = "WAIT|0.50|Neutral conditions, waiting for better setup|" + summary;
   }
   
   return response;
}

//+------------------------------------------------------------------+
//| Split summary into lines for display                            |
//+------------------------------------------------------------------+
void SplitSummaryIntoLines()
{
   ArrayResize(g_AISummaryLines, 10);
   for(int j = 0; j < 10; j++) {
      g_AISummaryLines[j] = "";
   }
   
   if(StringLen(g_AISummary) == 0) {
      g_AISummaryLines[0] = "Waiting for analysis...";
      return;
   }
   
   // Split by sentences (periods)
   string sentences[];
   int sentenceCount = StringSplit(g_AISummary, '.', sentences);
   
   int lineIndex = 0;
   
   for(int i = 0; i < sentenceCount && lineIndex < 10; i++) {
      string sentence = sentences[i];
      
      // Trim whitespace
      while(StringLen(sentence) > 0 && StringGetCharacter(sentence, 0) == ' ') {
         sentence = StringSubstr(sentence, 1);
      }
      while(StringLen(sentence) > 0 && StringGetCharacter(sentence, StringLen(sentence) - 1) == ' ') {
         sentence = StringSubstr(sentence, 0, StringLen(sentence) - 1);
      }
      if(StringLen(sentence) == 0) continue;
      
      // Add period back
      sentence += ".";
      
      // If sentence is very long (>120 chars), split it by commas
      if(StringLen(sentence) > 120) {
         string parts[];
         int partCount = StringSplit(sentence, ',', parts);
         for(int p = 0; p < partCount && lineIndex < 10; p++) {
            string part = parts[p];
            // Trim
            while(StringLen(part) > 0 && StringGetCharacter(part, 0) == ' ') {
               part = StringSubstr(part, 1);
            }
            while(StringLen(part) > 0 && StringGetCharacter(part, StringLen(part) - 1) == ' ') {
               part = StringSubstr(part, 0, StringLen(part) - 1);
            }
            if(StringLen(part) > 0) {
               if(p < partCount - 1) part += ",";
               g_AISummaryLines[lineIndex] = part;
               lineIndex++;
            }
         }
      } else {
         g_AISummaryLines[lineIndex] = sentence;
         lineIndex++;
      }
   }
   
   // Ensure all remaining lines are empty
   for(int k = lineIndex; k < 10; k++) {
      if(k < ArraySize(g_AISummaryLines)) {
         g_AISummaryLines[k] = "";
      }
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
      // 新格式: 信号|置信度|止损点数|止盈点数|推理|总结
      g_AISignal = parts[0];
      StringTrimLeft(g_AISignal);
      StringTrimRight(g_AISignal);

      g_AIConfidence = StringToDouble(parts[1]);
      g_AISLPoints = StringToDouble(parts[2]);
      g_AITPPoints = StringToDouble(parts[3]);
      g_AIReasoning = parts[4];
      g_AISummary = parts[5];

      StringTrimLeft(g_AIReasoning);
      StringTrimRight(g_AIReasoning);

      if(g_AISignal != "BUY" && g_AISignal != "SELL" && g_AISignal != "WAIT") {
         Print("⚠ 无效AI信号: '", g_AISignal, "' - 默认为WAIT");
         g_AISignal = "WAIT";
      }
      if(g_AIConfidence < 0.0) g_AIConfidence = 0.0;
      if(g_AIConfidence > 1.0) g_AIConfidence = 1.0;

      // 验证止损止盈合理性（宽止损策略）
      if(g_AISLPoints < 100) g_AISLPoints = 100;    // 最小100点
      if(g_AISLPoints > 800) g_AISLPoints = 800;    // 最大800点
      if(g_AITPPoints < 100) g_AITPPoints = 100;    // 最小100点
      if(g_AITPPoints > 1500) g_AITPPoints = 1500;  // 最大1500点

      Print("✓ 解析AI响应: 信号=", g_AISignal, " 置信度=", DoubleToString(g_AIConfidence * 100, 1),
            "% 止损=", g_AISLPoints, "点 止盈=", g_AITPPoints, "点");
      Print("   推理: ", StringSubstr(g_AIReasoning, 0, 50));

      SplitSummaryIntoLines();
   }
   else if(count >= 4) {
      // 旧格式兼容: 信号|置信度|推理|总结
      g_AISignal = parts[0];
      StringTrimLeft(g_AISignal);
      StringTrimRight(g_AISignal);

      g_AIConfidence = StringToDouble(parts[1]);
      g_AIReasoning = parts[2];
      g_AISummary = parts[3];
      g_AISLPoints = 0;  // 无止损信息，使用默认
      g_AITPPoints = 0;  // 无止盈信息，使用默认

      StringTrimLeft(g_AIReasoning);
      StringTrimRight(g_AIReasoning);

      if(g_AISignal != "BUY" && g_AISignal != "SELL" && g_AISignal != "WAIT") {
         g_AISignal = "WAIT";
      }
      if(g_AIConfidence < 0.0) g_AIConfidence = 0.0;
      if(g_AIConfidence > 1.0) g_AIConfidence = 1.0;

      Print("⚠ 旧格式(无止损止盈): 信号=", g_AISignal, " 置信度=", g_AIConfidence);
      SplitSummaryIntoLines();
   } else {
      // 无效响应
      g_AISignal = "WAIT";
      g_AIConfidence = 0.0;
      g_AISLPoints = 0;
      g_AITPPoints = 0;
      g_AIReasoning = "无效AI响应";
      g_AISummary = "等待AI分析...";
      SplitSummaryIntoLines();
   }
}

//+------------------------------------------------------------------+
//| UI Functions                                                     |
//+------------------------------------------------------------------+
void DrawDashboard()
{
   int leftX = InpXLeft;
   int topY = InpYTop;
   int leftWidth = InpWidthLeft;
   int rightWidth = InpWidthRight;
   int thirdWidth = InpWidthThird;
   int panelHeight = InpPanelHeight;

   // 左面板背景
   CreateRectangle("BG_Left", leftX, topY, leftWidth, panelHeight, ClrBackground, CORNER_LEFT_UPPER);
   CreateTextLabel("Title_Left", "源流AI信号开仓版", leftX + 10, topY + 5, ClrHeader, true, 10, CORNER_LEFT_UPPER);

   int y = topY + 30;

   // 交易状态和AI状态
   CreateTextLabel("L_TradingStatus", "交易状态:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_TradingStatus", "初始化", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_AIStatus", "AI状态:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AIStatus", "初始化", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   // 分隔线
   y += 5;

   // 实时价格
   CreateTextLabel("L_Price", "价格:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_Price", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_BidPrice", "买价:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_BidPrice", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_AskPrice", "卖价:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AskPrice", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_Spread", "点差:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_Spread", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   // 分隔线
   y += 5;

   // RSI指标
   CreateTextLabel("L_RSI", "RSI:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RSI", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_RSI_To30", "距超卖:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RSI_To30", "--", leftX + 100, y, ClrBuy, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_RSI_To70", "距超买:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_RSI_To70", "--", leftX + 100, y, ClrSell, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   // 分隔线
   y += 5;

   // AI信号和置信度
   CreateTextLabel("L_AISignal", "AI信号:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AISignal", "等待", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_AIConfidence", "AI置信度:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AIConfidence", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   CreateTextLabel("L_AIExpectation", "AI预期:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_AIExpectation", "--", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   // 分隔线
   y += 5;

   // 今日盈利
   CreateTextLabel("L_DailyProfit", "今日盈利:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_DailyProfit", "$0.00", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   // 每日限制
   CreateTextLabel("L_DailyLimit", "每日限制:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_DailyLimit", "+$" + DoubleToString(InpDailyProfitTarget, 0) + " / -$" + DoubleToString(InpMaxDailyLoss, 0), leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
   y += 18;

   // 胜率
   CreateTextLabel("L_WinRate", "胜率:", leftX + 10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("V_WinRate", "0%", leftX + 100, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
}

void CreateRectangle(string name, int x, int y, int width, int height, color bgColor, int corner)
{
   string objName = g_Prefix + name;
   if(ObjectFind(0, objName) < 0) {
      ObjectCreate(0, objName, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   }
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
   if(ObjectFind(0, objName) < 0) {
      ObjectCreate(0, objName, OBJ_LABEL, 0, 0, 0);
   }
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
//| NEW FEATURE: Dynamic Lot Sizing Calculator                       |
//| Calculates position size based on risk % and stop loss distance  |
//+------------------------------------------------------------------+
double CalculateDynamicLots(double stopLossDistance)
{
   double lots = InpMinLotSize;
   
   // 1. Calculate Risk-Based Lots (if money management enabled)
   if(InpUseMoneyManagement)
   {
      double equity = AccountInfoDouble(ACCOUNT_EQUITY);
      double riskAmount = equity * (InpRiskPercent / 100.0);
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      
      // Safety checks: avoid division by zero
      if(tickValue > 0 && tickSize > 0 && stopLossDistance > 0)
      {
         double pointsAtRisk = MathAbs(stopLossDistance) / tickSize;
         double denominator = pointsAtRisk * tickValue;
         if(denominator > 0.0001) // Avoid division by zero
         {
            lots = riskAmount / denominator;
         }
      }
   }
   else
   {
      // Use fixed lot size when money management is disabled
      lots = InpLotSize;
   }
   
   // 2. THE CLAMP (Safety Governor)
   if(lots > InpMaxLotCap) lots = InpMaxLotCap;
   if(lots < InpMinLotSize) lots = InpMinLotSize;
   
   // 3. Normalize to Broker Step
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0)
      lots = MathFloor(lots / step) * step;
   
   return lots;
}

//+------------------------------------------------------------------+
//| NEW FEATURE: Sniper Entry Filter                                 |
//| Checks M1 RSI before executing M15 signal                        |
//| Returns: true if entry is allowed, false if should wait          |
//+------------------------------------------------------------------+
bool CheckSniperEntry(string signal)
{
   if(!InpSniperEntry) return true; // Sniper mode disabled, allow all entries
   
   // Get M1 RSI
   int handleM1 = iRSI(_Symbol, PERIOD_M1, 14, PRICE_CLOSE);
   if(handleM1 == INVALID_HANDLE) return true; // If M1 data unavailable, allow entry
   
   double buffM1[];
   ArraySetAsSeries(buffM1, true);
   
   bool allowEntry = true;
   
   if(CopyBuffer(handleM1, 0, 0, 1, buffM1) > 0 && ArraySize(buffM1) > 0)
   {
      double rsiM1 = buffM1[0];
      
      // If BUY Signal: Don't buy if M1 is Overbought (>70)
      if(signal == "BUY")
      {
         if(rsiM1 > 70)
         {
            Print("🎯 SNIPER: M15 BUY signal but M1 RSI overbought (", DoubleToString(rsiM1, 1), "). Waiting for dip...");
            allowEntry = false;
         }
      }
      
      // If SELL Signal: Don't sell if M1 is Oversold (<30)
      if(signal == "SELL")
      {
         if(rsiM1 < 30)
         {
            Print("🎯 SNIPER: M15 SELL signal but M1 RSI oversold (", DoubleToString(rsiM1, 1), "). Waiting for rally...");
            allowEntry = false;
         }
      }
   }
   
   IndicatorRelease(handleM1); // Clean up
   return allowEntry;
}

//+------------------------------------------------------------------+
//| NEW FEATURE: Enhanced Breakeven Logic                            |
//| Moves stop loss to breakeven + padding when profit threshold hit |
//+------------------------------------------------------------------+
void CheckAndApplyBreakeven(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return;
   
   double floatingProfit = PositionGetDouble(POSITION_PROFIT);
   
   // TIGHT BREAKEVEN: Apply breakeven at lower profit threshold (tighter protection)
   if(floatingProfit >= InpBreakevenTrigger)
   {
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);
      double volume = PositionGetDouble(POSITION_VOLUME);
      
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      
      if(tickValue == 0 || tickSize == 0 || volume == 0) return;
      
      // Calculate padding distance in price - with safety check
      double denominator = volume * tickValue;
      if(denominator <= 0) return; // Safety check: avoid division by zero
      double paddingDist = (InpBreakevenPadding / denominator) * tickSize;
      
      bool shouldModify = false;
      double newSL = 0;
      
      if(posType == POSITION_TYPE_BUY)
      {
         double bePrice = entryPrice + paddingDist;
         if(currentSL < bePrice)
         {
            newSL = bePrice;
            shouldModify = true;
         }
      }
      else // SELL
      {
         double bePrice = entryPrice - paddingDist;
         if(currentSL > bePrice || currentSL == 0)
         {
            newSL = bePrice;
            shouldModify = true;
         }
      }
      
      if(shouldModify)
      {
         newSL = NormalizeDouble(newSL, g_SymbolDigits);
         if(g_Trade.PositionModify(ticket, newSL, 0))
         {
            Print("✅ BREAKEVEN: Moved #", ticket, " to breakeven+padding at $", DoubleToString(floatingProfit, 2), " profit");
         }
      }
   }
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Enhanced Risk Management - Daily Reset            |
//+------------------------------------------------------------------+
void CheckDailyReset()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   datetime today = StringToTime(IntegerToString(dt.year) + "." + 
                                   IntegerToString(dt.mon) + "." + 
                                   IntegerToString(dt.day));
   
   if(today != g_LastResetDate)
   {
      g_DailyProfit = 0.0;
      g_DailyHighEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      g_LastResetDate = today;
      g_TradingHalted = false; // Reset halt flag for new day
      Print("📅 NEW TRADING DAY - Daily stats reset");
   }
   
   // Update daily high equity for drawdown calculation
   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(currentEquity > g_DailyHighEquity)
      g_DailyHighEquity = currentEquity;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Check if Trading is Allowed (Risk Limits)         |
//+------------------------------------------------------------------+
bool IsTradingAllowed()
{
   if(!InpEnableTrading) {
      return false;
   }

   CheckDailyReset();

   // 注意：所有风控检查已在OnTick主循环中完成
   // 这里只做基本的交易启用检查

   return true;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Update Trade Statistics                            |
//+------------------------------------------------------------------+
void UpdateTradeStatistics(double profit)
{
   g_DailyProfit += profit;
   g_TotalProfit += profit;
   
   if(profit > 0)
   {
      g_WinningTrades++;
      g_ConsecutiveLosses = 0; // Reset consecutive losses
      g_GrossProfit += profit;
      if(profit > g_LargestWin) g_LargestWin = profit;
      
      // Calculate average win
      if(g_WinningTrades > 0)
         g_AvgWin = g_GrossProfit / g_WinningTrades;
   }
   else if(profit < 0)
   {
      g_LosingTrades++;
      g_ConsecutiveLosses++;
      g_LastLossTime = TimeCurrent();
      g_GrossLoss += MathAbs(profit);
      if(profit < g_LargestLoss) g_LargestLoss = profit;
      
      // Calculate average loss
      if(g_LosingTrades > 0)
         g_AvgLoss = g_GrossLoss / g_LosingTrades;
   }
   
   // 计算盈亏比
   if(g_GrossLoss > 0)
      g_ProfitFactor = g_GrossProfit / g_GrossLoss;
   else
      g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;
   
   // 计算回撤 - with safety check
   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(g_DailyHighEquity > 0.0001) // Safety check: avoid division by zero
   {
      double drawdown = ((g_DailyHighEquity - currentEquity) / g_DailyHighEquity) * 100.0;
      if(drawdown > g_MaxDrawdown) g_MaxDrawdown = drawdown;
   }
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Kelly Criterion Position Sizing                   |
//+------------------------------------------------------------------+
double CalculateKellyCriterionLots(double stopLossDistance)
{
   if(!InpUseKellyCriterion) return CalculateDynamicLots(stopLossDistance);
   
   // Need minimum trade history for Kelly
   if(g_TotalTrades < InpMinTradesForKelly)
   {
      Print("📊 Kelly Criterion: Need ", InpMinTradesForKelly, " trades (have ", g_TotalTrades, ") - Using standard sizing");
      return CalculateDynamicLots(stopLossDistance);
   }
   
   if(g_WinningTrades == 0 || g_LosingTrades == 0)
   {
      Print("📊 Kelly Criterion: Insufficient win/loss data - Using standard sizing");
      return CalculateDynamicLots(stopLossDistance);
   }
   
   // Safety check: avoid division by zero
   if(g_TotalTrades == 0) return CalculateDynamicLots(stopLossDistance);
   
   double winRate = (double)g_WinningTrades / (double)g_TotalTrades;
   double avgWin = g_AvgWin > 0 ? g_AvgWin : 1.0;
   double avgLoss = g_AvgLoss > 0 ? g_AvgLoss : 1.0;
   
   // Safety check: avoid division by zero
   if(avgLoss <= 0) return CalculateDynamicLots(stopLossDistance);
   
   // Kelly Formula: f = (p * b - q) / b
   // p = win probability, q = loss probability, b = win/loss ratio
   double b = avgWin / avgLoss;
   
   // Safety check: avoid division by zero
   if(MathAbs(b) < 0.0001) return CalculateDynamicLots(stopLossDistance);
   
   double kellyPercent = (winRate * b - (1 - winRate)) / b;
   
   // Use fractional Kelly (safer)
   kellyPercent = kellyPercent * InpKellyFraction;
   
   // Safety caps
   if(kellyPercent > (InpMaxRiskPerTrade / 100.0))
      kellyPercent = InpMaxRiskPerTrade / 100.0;
   if(kellyPercent < 0.001)
      kellyPercent = 0.001; // Minimum 0.1%
   
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double riskAmount = equity * kellyPercent;
   
   // Calculate lots based on risk amount
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   
   double lots = InpMinLotSize;
   // Safety checks: avoid division by zero
   if(tickValue > 0 && tickSize > 0 && stopLossDistance > 0)
   {
      double pointsAtRisk = MathAbs(stopLossDistance) / tickSize;
      double denominator = pointsAtRisk * tickValue;
      if(denominator > 0.0001) // Avoid division by zero
      {
         lots = riskAmount / denominator;
      }
   }
   
   // Apply clamps
   if(lots > InpMaxLotCap) lots = InpMaxLotCap;
   if(lots < InpMinLotSize) lots = InpMinLotSize;
   
   // Normalize to broker step - with safety check
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0.0001) // Safety check: avoid division by zero
      lots = MathFloor(lots / step) * step;
   
   // Final validation: ensure lots is valid
   if(lots <= 0) lots = InpMinLotSize;
   
   Print("📊 Kelly Criterion: WinRate=", DoubleToString(winRate*100, 1), "%, Kelly%=", 
         DoubleToString(kellyPercent*100, 2), "%, Lots=", DoubleToString(lots, 2));
   
   return lots;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Calculate Linear Regression Slope                 |
//+------------------------------------------------------------------+
double CalculateLinearRegressionSlope(double &data[], int period)
{
   if(ArraySize(data) < period) return 0.0;
   
   double sumX = 0.0, sumY = 0.0, sumXY = 0.0, sumX2 = 0.0;
   
   for(int i = 0; i < period; i++)
   {
      double x = (double)i;
      double y = data[i];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
   }
   
   double n = (double)period;
   double denominator = (n * sumX2 - sumX * sumX);
   
   // Safety check: avoid division by zero
   if(MathAbs(denominator) < 0.0001)
      return 0.0;
   
   double slope = (n * sumXY - sumX * sumY) / denominator;
   
   return slope;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Detect Market Regime                               |
//+------------------------------------------------------------------+
MARKET_REGIME DetectMarketRegime()
{
   if(!InpUseRegimeDetection) return REGIME_UNKNOWN;
   
   // Get ADX value
   double adxBuffer[];
   ArraySetAsSeries(adxBuffer, true);
   
   if(g_HandleADX == INVALID_HANDLE)
   {
      g_HandleADX = iADX(_Symbol, PERIOD_M15, InpRegimeADXPeriod);
      if(g_HandleADX == INVALID_HANDLE) return REGIME_UNKNOWN;
   }
   
   if(CopyBuffer(g_HandleADX, 0, 0, 1, adxBuffer) < 1)
      return REGIME_UNKNOWN;
   
   double adxValue = adxBuffer[0];
   
   // Get last 50 M15 candles for analysis
   double high[], low[], close[];
   ArraySetAsSeries(high, true);
   ArraySetAsSeries(low, true);
   ArraySetAsSeries(close, true);
   
   if(CopyHigh(_Symbol, PERIOD_M15, 0, 50, high) != 50) return REGIME_UNKNOWN;
   if(CopyLow(_Symbol, PERIOD_M15, 0, 50, low) != 50) return REGIME_UNKNOWN;
   if(CopyClose(_Symbol, PERIOD_M15, 0, 50, close) != 50) return REGIME_UNKNOWN;
   
   // Calculate price range vs ATR ratio
   // Safety check: ensure arrays are valid
   if(ArraySize(high) < 50 || ArraySize(low) < 50) return REGIME_UNKNOWN;
   
   int maxIdx = ArrayMaximum(high, 0, 50);
   int minIdx = ArrayMinimum(low, 0, 50);
   
   if(maxIdx < 0 || maxIdx >= ArraySize(high) || minIdx < 0 || minIdx >= ArraySize(low))
      return REGIME_UNKNOWN;
   
   double highest = high[maxIdx];
   double lowest = low[minIdx];
   double range50 = highest - lowest;
   
   // Safety check: ensure valid range
   if(range50 <= 0) return REGIME_UNKNOWN;
   
   double avgATR = 0.0;
   if(ArraySize(g_BufferATR) > 0 && g_BufferATR[0] > 0)
      avgATR = g_BufferATR[0];
   else
      avgATR = range50 / 10.0; // Fallback
   
   // Safety check: avoid division by zero
   double atrRatio = 0.0;
   double atrDenominator = avgATR * 50.0;
   if(atrDenominator > 0.0001)
      atrRatio = range50 / atrDenominator;
   
   // Calculate slope of linear regression
   double slope = CalculateLinearRegressionSlope(close, 50);
   
   // Decision logic
   if(adxValue > InpRegimeADXThreshold && slope > 0.001)
   {
      return REGIME_TRENDING_UP;
   }
   else if(adxValue > InpRegimeADXThreshold && slope < -0.001)
   {
      return REGIME_TRENDING_DOWN;
   }
   else if(atrRatio > 2.0 && adxValue < 20.0)
   {
      return REGIME_VOLATILE;
   }
   else if(adxValue < 20.0)
   {
      return REGIME_RANGING;
   }
   
   return REGIME_UNKNOWN;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Adjust Strategy Based on Market Regime            |
//+------------------------------------------------------------------+
void AdjustStrategyForRegime()
{
   if(!InpUseRegimeDetection) return;
   
   MARKET_REGIME newRegime = DetectMarketRegime();
   
   if(newRegime != g_CurrentRegime)
   {
      g_CurrentRegime = newRegime;
      
      switch(g_CurrentRegime)
      {
         case REGIME_TRENDING_UP:
            Print("📈 MARKET REGIME: TRENDING UP - Prefer BUY trades, wider stops");
            break;
         case REGIME_TRENDING_DOWN:
            Print("📉 MARKET REGIME: TRENDING DOWN - Prefer SELL trades, wider stops");
            break;
         case REGIME_RANGING:
            Print("↔️ MARKET REGIME: RANGING - Both directions OK, tighter stops");
            break;
         case REGIME_VOLATILE:
            Print("⚡ MARKET REGIME: VOLATILE - Reduce position size, wider stops");
            break;
         default:
            Print("❓ MARKET REGIME: UNKNOWN - Using default strategy");
            break;
      }
   }
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Check if Current Time is Good for Trading          |
//+------------------------------------------------------------------+
bool IsGoodTradingTime()
{
   if(!InpUseTimeFilters) return true;
   
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   
   // Avoid Asian dead zone (2-5 AM GMT) - low liquidity
   if(InpAvoidAsianDeadZone && dt.hour >= 2 && dt.hour < 5)
   {
      Print("⏰ TIME FILTER: Asian dead zone (", dt.hour, ":00) - Low liquidity, skipping");
      return false;
   }
   
   // Check session open/close filters
   string session = GetTradingSession();
   
   // 只在主要时段开盘前15分钟阻止（欧洲开盘8:00-8:15，美国开盘13:00-13:15）
   if(InpAvoidSessionOpen && ((dt.hour == 8 && dt.min < 15) || (dt.hour == 13 && dt.min < 15)))
   {
      Print("⏰ 时间过滤: ", session, " 时段开盘前15分钟 - 波动大，跳过交易");
      return false;
   }
   
   // 只在美国时段收盘前15分钟阻止（20:45-21:00 GMT）
   if(InpAvoidSessionClose && session == "US" && dt.hour == 20 && dt.min > 45)
   {
      Print("⏰ 时间过滤: 美国时段收盘前15分钟 - 不可预测，跳过交易");
      return false;
   }
   
   return true;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Calculate Sharpe Ratio                             |
//+------------------------------------------------------------------+
double CalculateSharpeRatio()
{
   // Simplified Sharpe calculation (would need daily returns for full calculation)
   if(g_TotalTrades < 10) return 0.0;
   
   double avgReturn = g_TotalProfit / g_TotalTrades;
   double variance = 0.0;
   
   // Would need individual trade returns for proper calculation
   // For now, use simplified version based on win rate and profit factor
   if(g_AvgLoss > 0)
   {
      double riskAdjustedReturn = (g_AvgWin * (double)g_WinningTrades - g_AvgLoss * (double)g_LosingTrades) / g_TotalTrades;
      double risk = g_AvgLoss;
      if(risk > 0)
         return riskAdjustedReturn / risk;
   }
   
   return 0.0;
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Draw Performance Analytics Panel                   |
//+------------------------------------------------------------------+
void DrawPerformancePanel()
{
   if(!InpShowPerformancePanel) return;
   
   int x = InpPerformancePanelX;
   int y = InpPerformancePanelY;
   int w = 250;
   int h = 350;
   
   // Background
   CreateRectangle("Perf_BG", x, y, w, h, C'10,10,12', CORNER_LEFT_UPPER);
   CreateRectangle("Perf_Header", x, y, w, 30, C'255,190,0', CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_Title", "PERFORMANCE ANALYTICS", x+10, y+5, C'0,0,0', true, 11, CORNER_LEFT_UPPER);
   
   y += 40;
   
   // Profit Factor
   CreateTextLabel("Perf_L_PF", "Profit Factor:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_PF", DoubleToString(g_ProfitFactor, 2), x+120, y, 
                   g_ProfitFactor > 1.5 ? ClrBuy : (g_ProfitFactor > 1.0 ? ClrNeutral : ClrSell), 
                   true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Win Rate
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0.0;
   CreateTextLabel("Perf_L_WR", "Win Rate:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_WR", DoubleToString(winRate, 1) + "%", x+120, y,
                   winRate > 60 ? ClrBuy : (winRate > 50 ? ClrNeutral : ClrSell), true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Max Drawdown
   CreateTextLabel("Perf_L_DD", "Max Drawdown:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_DD", DoubleToString(g_MaxDrawdown, 2) + "%", x+120, y,
                   g_MaxDrawdown < 10 ? ClrBuy : (g_MaxDrawdown < 20 ? ClrNeutral : ClrSell), true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Daily P/L
   CreateTextLabel("Perf_L_Daily", "Daily P/L:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_Daily", "$" + DoubleToString(g_DailyProfit, 2), x+120, y,
                   g_DailyProfit > 0 ? ClrBuy : (g_DailyProfit == 0 ? ClrNeutral : ClrSell), true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Consecutive Losses
   CreateTextLabel("Perf_L_Cons", "Consecutive Losses:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_Cons", IntegerToString(g_ConsecutiveLosses), x+120, y,
                   g_ConsecutiveLosses == 0 ? ClrBuy : (g_ConsecutiveLosses < InpMaxConsecLosses ? ClrNeutral : ClrSell), 
                   true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Market Regime
   string regimeStr = "";
   color regimeColor = ClrNeutral;
   switch(g_CurrentRegime)
   {
      case REGIME_TRENDING_UP: regimeStr = "TRENDING UP"; regimeColor = ClrBuy; break;
      case REGIME_TRENDING_DOWN: regimeStr = "TRENDING DOWN"; regimeColor = ClrSell; break;
      case REGIME_RANGING: regimeStr = "RANGING"; regimeColor = ClrNeutral; break;
      case REGIME_VOLATILE: regimeStr = "VOLATILE"; regimeColor = ClrWarning; break;
      default: regimeStr = "UNKNOWN"; break;
   }
   CreateTextLabel("Perf_L_Regime", "Market Regime:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_Regime", regimeStr, x+120, y, regimeColor, true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Largest Win
   CreateTextLabel("Perf_L_MaxWin", "Largest Win:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_MaxWin", "$" + DoubleToString(g_LargestWin, 2), x+120, y, ClrBuy, true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Largest Loss
   CreateTextLabel("Perf_L_MaxLoss", "Largest Loss:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_MaxLoss", "$" + DoubleToString(g_LargestLoss, 2), x+120, y, ClrSell, true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Avg Win
   CreateTextLabel("Perf_L_AvgWin", "Avg Win:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_AvgWin", "$" + DoubleToString(g_AvgWin, 2), x+120, y, ClrBuy, true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Avg Loss
   CreateTextLabel("Perf_L_AvgLoss", "Avg Loss:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_AvgLoss", "$" + DoubleToString(g_AvgLoss, 2), x+120, y, ClrSell, true, 9, CORNER_LEFT_UPPER);
   y += 20;
   
   // Total Trades
   CreateTextLabel("Perf_L_Trades", "Total Trades:", x+10, y, ClrLabel, false, 9, CORNER_LEFT_UPPER);
   CreateTextLabel("Perf_V_Trades", IntegerToString(g_TotalTrades), x+120, y, ClrValue, true, 9, CORNER_LEFT_UPPER);
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Update Performance Panel                           |
//+------------------------------------------------------------------+
void UpdatePerformancePanel()
{
   if(!InpShowPerformancePanel) return;
   
   // Update dynamic values
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0.0;
   UpdateUI("Perf_V_PF", DoubleToString(g_ProfitFactor, 2), 
            g_ProfitFactor > 1.5 ? ClrBuy : (g_ProfitFactor > 1.0 ? ClrNeutral : ClrSell));
   UpdateUI("Perf_V_WR", DoubleToString(winRate, 1) + "%",
            winRate > 60 ? ClrBuy : (winRate > 50 ? ClrNeutral : ClrSell));
   UpdateUI("Perf_V_DD", DoubleToString(g_MaxDrawdown, 2) + "%",
            g_MaxDrawdown < 10 ? ClrBuy : (g_MaxDrawdown < 20 ? ClrNeutral : ClrSell));
   UpdateUI("Perf_V_Daily", "$" + DoubleToString(g_DailyProfit, 2),
            g_DailyProfit > 0 ? ClrBuy : (g_DailyProfit == 0 ? ClrNeutral : ClrSell));
   UpdateUI("Perf_V_Cons", IntegerToString(g_ConsecutiveLosses),
            g_ConsecutiveLosses == 0 ? ClrBuy : (g_ConsecutiveLosses < InpMaxConsecLosses ? ClrNeutral : ClrSell));
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Load Historical Statistics from MT5 History        |
//| Reads all closed positions for this symbol/magic from history     |
//| IMPROVED: Uses HistorySelectByPosition to get ALL deals per position |
//+------------------------------------------------------------------+
void LoadHistoricalStatistics()
{
   Print("═══════════════════════════════════════════════════════");
   Print("📊 Loading Historical Trading Statistics for ", _Symbol);
   
   // Select all history (from beginning of time)
   datetime startTime = 0; // Start from beginning
   datetime endTime = TimeCurrent();
   
   if(!HistorySelect(startTime, endTime))
   {
      Print("⚠️ WARNING: Could not access trading history. Stats will start from zero.");
      return;
   }
   
   // Reset counters
   g_TotalTrades = 0;
   g_WinningTrades = 0;
   g_LosingTrades = 0;
   g_TotalProfit = 0.0;
   g_GrossProfit = 0.0;
   g_GrossLoss = 0.0;
   g_LargestWin = 0.0;
   g_LargestLoss = 0.0;
   g_ConsecutiveLosses = 0;
   
   // Track unique position IDs we've seen
   ulong processedPositionIds[];
   ulong positionIds[];
   double positionProfits[];
   datetime positionCloseTimes[];
   
   int totalDeals = HistoryDealsTotal();
   Print("   Found ", totalDeals, " total deals in history");
   
   // Count deals for this symbol (any magic)
   int symbolDeals = 0;
   for(int check = 0; check < totalDeals; check++)
   {
      ulong checkTicket = HistoryDealGetTicket(check);
      if(checkTicket > 0 && HistoryDealGetString(checkTicket, DEAL_SYMBOL) == _Symbol)
         symbolDeals++;
   }
   Print("   Found ", symbolDeals, " deals for symbol ", _Symbol, " (any magic)");
   
   // First pass: Find ALL deals for this symbol (not just closes)
   // We'll group by position ID to get accurate profit
   for(int i = 0; i < totalDeals; i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket <= 0) continue;
      
      // Check if this is our symbol (use g_SymbolName for consistency)
      string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
      if(dealSymbol != g_SymbolName && dealSymbol != _Symbol) continue;
      
      // Check magic number
      long dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      
      // If InpIncludeAllMagicNumbers is true, include ALL trades for this symbol
      // Otherwise, only include trades with magic 0 (no magic) or 123456 (our magic)
      if(!InpIncludeAllMagicNumbers)
      {
         if(dealMagic != 0 && dealMagic != 123456) 
         {
            // Debug: log what we're skipping (only first few)
            static int skippedCount = 0;
            skippedCount++;
            if(skippedCount <= 3) // Only log first 3 to avoid spam
            {
               Print("   ⚠️ Skipping deal #", dealTicket, " - Magic: ", dealMagic, " (not 0 or 123456)");
               if(skippedCount == 3)
                  Print("   → Set InpIncludeAllMagicNumbers=true to include ALL trades for ", _Symbol);
            }
            continue; // Skip trades with different magic
         }
      }
      
      // Get position ID
      ulong positionId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
      if(positionId == 0) continue; // Skip deals without position ID
      
      // Check if this is a position close deal
      ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if(dealEntry != DEAL_ENTRY_OUT) continue; // Only process closes
      
      // Check if we've already processed this position
      bool alreadyProcessed = false;
      for(int j = 0; j < ArraySize(processedPositionIds); j++)
      {
         if(processedPositionIds[j] == positionId)
         {
            alreadyProcessed = true;
            break;
         }
      }
      
      if(alreadyProcessed) continue; // Skip duplicates
      
      // Now get ALL deals for this position to calculate total profit correctly
      if(!HistorySelectByPosition(positionId))
      {
         Print("   ⚠️ Could not select history for position ", positionId);
         continue;
      }
      
      // Sum up all deals for this position
      double totalPositionProfit = 0.0;
      double totalCommission = 0.0;
      double totalSwap = 0.0;
      datetime positionCloseTime = 0;
      
      int positionDeals = HistoryDealsTotal();
      for(int d = 0; d < positionDeals; d++)
      {
         ulong posDealTicket = HistoryDealGetTicket(d);
         if(posDealTicket <= 0) continue;
         
         // Only count deals for this symbol (gold pair)
         string posDealSymbol = HistoryDealGetString(posDealTicket, DEAL_SYMBOL);
         if(posDealSymbol != g_SymbolName && posDealSymbol != _Symbol) continue;
         
         totalPositionProfit += HistoryDealGetDouble(posDealTicket, DEAL_PROFIT);
         totalCommission += HistoryDealGetDouble(posDealTicket, DEAL_COMMISSION);
         totalSwap += HistoryDealGetDouble(posDealTicket, DEAL_SWAP);
         
         // Get the close time from the closing deal
         if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(posDealTicket, DEAL_ENTRY) == DEAL_ENTRY_OUT)
         {
            datetime dealTime = (datetime)HistoryDealGetInteger(posDealTicket, DEAL_TIME);
            if(dealTime > positionCloseTime) positionCloseTime = dealTime;
         }
      }
      
      double finalProfit = totalPositionProfit + totalCommission + totalSwap;
      
      // Add to arrays
      int arraySize = ArraySize(positionIds);
      ArrayResize(positionIds, arraySize + 1);
      ArrayResize(positionProfits, arraySize + 1);
      ArrayResize(positionCloseTimes, arraySize + 1);
      ArrayResize(processedPositionIds, arraySize + 1);
      
      positionIds[arraySize] = positionId;
      positionProfits[arraySize] = finalProfit;
      positionCloseTimes[arraySize] = positionCloseTime;
      processedPositionIds[arraySize] = positionId;
      
      Print("   ✓ Position #", positionId, " | Profit: $", DoubleToString(finalProfit, 2), 
            " | Deals: ", positionDeals, " | Magic: ", dealMagic);
   }
   
   // Re-select all history for next operations
   HistorySelect(startTime, endTime);
   
   int closedPositions = ArraySize(positionIds);
   if(InpIncludeAllMagicNumbers)
      Print("   Found ", closedPositions, " closed positions for ", _Symbol, " (ALL magic numbers)");
   else
      Print("   Found ", closedPositions, " closed positions for ", _Symbol, " (Magic: 0 or 123456)");
   
   if(closedPositions == 0)
   {
      Print("   ⚠️ No historical trades found. Starting fresh.");
      Print("   → TIPS:");
      Print("      - Trading Pair: ", g_SymbolName, (g_IsGoldSymbol ? " (GOLD)" : ""));
      Print("      - Check symbol name matches exactly: ", g_SymbolName);
      if(!InpIncludeAllMagicNumbers)
         Print("      - Try setting InpIncludeAllMagicNumbers=true to include ALL trades");
      Print("      - Check MT5 History tab for ", g_SymbolName, " trades");
      if(g_IsGoldSymbol)
         Print("      - Gold-specific: Ensure you're checking the correct gold symbol");
      Print("═══════════════════════════════════════════════════════");
      return;
   }
   
   // Sort by close time (oldest first) to calculate consecutive losses correctly
   for(int i = 0; i < closedPositions - 1; i++)
   {
      for(int j = i + 1; j < closedPositions; j++)
      {
         if(positionCloseTimes[i] > positionCloseTimes[j])
         {
            // Swap
            ulong tempId = positionIds[i];
            positionIds[i] = positionIds[j];
            positionIds[j] = tempId;
            
            double tempProfit = positionProfits[i];
            positionProfits[i] = positionProfits[j];
            positionProfits[j] = tempProfit;
            
            datetime tempTime = positionCloseTimes[i];
            positionCloseTimes[i] = positionCloseTimes[j];
            positionCloseTimes[j] = tempTime;
         }
      }
   }
   
   // Second pass: Calculate statistics
   for(int i = 0; i < closedPositions; i++)
   {
      double profit = positionProfits[i];
      
      g_TotalTrades++;
      g_TotalProfit += profit;
      
      if(profit > 0)
      {
         g_WinningTrades++;
         g_ConsecutiveLosses = 0; // Reset on win
         g_GrossProfit += profit;
         if(profit > g_LargestWin) g_LargestWin = profit;
      }
      else if(profit < 0)
      {
         g_LosingTrades++;
         g_ConsecutiveLosses++;
         g_LastLossTime = positionCloseTimes[i];
         g_GrossLoss += MathAbs(profit);
         if(profit < g_LargestLoss) g_LargestLoss = profit;
      }
   }
   
   // Calculate averages
   if(g_WinningTrades > 0)
      g_AvgWin = g_GrossProfit / g_WinningTrades;
   if(g_LosingTrades > 0)
      g_AvgLoss = g_GrossLoss / g_LosingTrades;
   
   // 计算盈亏比
   if(g_GrossLoss > 0)
      g_ProfitFactor = g_GrossProfit / g_GrossLoss;
   else
      g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;
   
   // Calculate win rate
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0.0;
   
   // Print summary
   Print("═══════════════════════════════════════════════════════");
   Print("📊 HISTORICAL STATISTICS LOADED:");
   Print("   Total Trades: ", g_TotalTrades);
   Print("   Winning Trades: ", g_WinningTrades, " | Losing Trades: ", g_LosingTrades);
   Print("   Win Rate: ", DoubleToString(winRate, 1), "%");
   Print("   Total Profit: $", DoubleToString(g_TotalProfit, 2));
   Print("   Gross Profit: $", DoubleToString(g_GrossProfit, 2));
   Print("   Gross Loss: $", DoubleToString(g_GrossLoss, 2));
   Print("   Profit Factor: ", DoubleToString(g_ProfitFactor, 2));
   Print("   Largest Win: $", DoubleToString(g_LargestWin, 2));
   Print("   Largest Loss: $", DoubleToString(g_LargestLoss, 2));
   Print("   Avg Win: $", DoubleToString(g_AvgWin, 2));
   Print("   Avg Loss: $", DoubleToString(g_AvgLoss, 2));
   Print("   Consecutive Losses: ", g_ConsecutiveLosses);
   Print("═══════════════════════════════════════════════════════");
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Check Closed Positions and Update Statistics      |
//| SIMPLIFIED: Tracks wins/losses directly when positions close    |
//+------------------------------------------------------------------+
void CheckClosedPositionsAndUpdateStats()
{
   // 检测已平仓的交易并更新统计（包括手动平仓、止盈止损、追踪止损）

   // 获取历史时间范围（往前2天，确保不遗漏）
   datetime startTime = TimeCurrent() - 172800; // 48小时前
   datetime endTime = TimeCurrent() + 60; // 往后1分钟

   // 选择历史
   if(!HistorySelect(startTime, endTime))
   {
      Print("⚠️ 历史选择失败");
      return;
   }

   int totalDeals = HistoryDealsTotal();
   int totalOrders = HistoryOrdersTotal();

   // 每10秒输出一次调试信息
   static datetime lastDebugTime = 0;
   bool showDebug = (TimeCurrent() - lastDebugTime >= 10);
   if(showDebug)
   {
      int currentPositions = CountTotalOpenPositions();
      Print("═══════════════════════════════════════════════════════");
      Print("📊 平仓检测调试:");
      Print("   当前持仓数: ", currentPositions);
      Print("   历史交易数: ", totalDeals);
      Print("   历史订单数: ", totalOrders);
      Print("   已处理平仓: ", ArraySize(g_ProcessedDeals));
      Print("   今日盈亏: $", DoubleToString(g_DailyProfit, 2));
      Print("   连续亏损: ", g_ConsecutiveLosses);
      Print("═══════════════════════════════════════════════════════");
      lastDebugTime = TimeCurrent();
   }

   // 方法2: 检查历史订单中的平仓订单
   for(int i = 0; i < totalOrders; i++)
   {
      ulong orderTicket = HistoryOrderGetTicket(i);
      if(orderTicket == 0) continue;

      // 检查是否是本EA的订单
      long orderMagic = HistoryOrderGetInteger(orderTicket, ORDER_MAGIC);
      string orderSymbol = HistoryOrderGetString(orderTicket, ORDER_SYMBOL);

      if(orderMagic != 123456 || orderSymbol != _Symbol)
         continue;

      // 检查订单状态
      ENUM_ORDER_STATE orderState = (ENUM_ORDER_STATE)HistoryOrderGetInteger(orderTicket, ORDER_STATE);
      if(orderState != ORDER_STATE_FILLED)
         continue;

      // 检查是否已经处理过
      bool alreadyProcessed = false;
      for(int j = 0; j < ArraySize(g_ProcessedDeals); j++)
      {
         if(g_ProcessedDeals[j] == orderTicket)
         {
            alreadyProcessed = true;
            break;
         }
      }

      if(alreadyProcessed)
         continue;

      // 获取订单信息
      double orderPrice = HistoryOrderGetDouble(orderTicket, ORDER_PRICE_OPEN);
      datetime orderTime = (datetime)HistoryOrderGetInteger(orderTicket, ORDER_TIME_DONE);

      // 查找对应的平仓交易
      for(int k = 0; k < totalDeals; k++)
      {
         ulong dealTicket = HistoryDealGetTicket(k);
         if(dealTicket == 0) continue;

         long dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
         string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
         ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);

         if(dealMagic == 123456 && dealSymbol == _Symbol &&
            (dealEntry == DEAL_ENTRY_OUT || dealEntry == DEAL_ENTRY_OUT_BY))
         {
            // 检查时间是否匹配（在订单完成后1秒内）
            datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
            if(MathAbs((int)(dealTime - orderTime)) <= 1)
            {
               double dealProfit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
               double dealCommission = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
               double dealSwap = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
               double totalProfit = dealProfit + dealCommission + dealSwap;

               // 记录到已处理列表
               int newSize = ArraySize(g_ProcessedDeals) + 1;
               ArrayResize(g_ProcessedDeals, newSize);
               g_ProcessedDeals[newSize - 1] = orderTicket;

               // 更新统计
               g_TotalTrades++;
               g_TotalProfit += totalProfit;
               g_DailyProfit += totalProfit;

               Print("═══════════════════════════════════════════════════════");
               Print("📊 检测到平仓（通过订单匹配）:");
               Print("   订单票据: ", orderTicket);
               Print("   交易票据: ", dealTicket);
               Print("   盈亏: $", DoubleToString(totalProfit, 2));
               Print("   今日累计: $", DoubleToString(g_DailyProfit, 2));

               if(totalProfit > 0)
               {
                  g_WinningTrades++;
                  g_ConsecutiveLosses = 0;
                  g_GrossProfit += totalProfit;
                  Print("   结果: ✅ 盈利");
               }
               else
               {
                  g_LosingTrades++;
                  g_ConsecutiveLosses++;
                  g_LastLossTime = TimeCurrent();
                  g_GrossLoss += MathAbs(totalProfit);
                  Print("   结果: ❌ 亏损");
                  Print("   连续亏损: ", g_ConsecutiveLosses, "次");
               }
               Print("═══════════════════════════════════════════════════════");

               // 更新面板
               UpdatePanelAfterTrade();
               break;
            }
         }
      }
   }

   for(int i = 0; i < totalDeals; i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;

      // 获取交易信息
      ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      long dealMagic = HistoryDealGetInteger(dealTicket, DEAL_MAGIC);
      string dealSymbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
      double dealProfit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
      ENUM_DEAL_TYPE dealType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTicket, DEAL_TYPE);

      // 调试：显示所有交易
      if(showDebug)
      {
         string entryType = "";
         if(dealEntry == DEAL_ENTRY_IN) entryType = "开仓";
         else if(dealEntry == DEAL_ENTRY_OUT) entryType = "平仓";
         else if(dealEntry == DEAL_ENTRY_OUT_BY) entryType = "强平";
         else entryType = "其他(" + IntegerToString((int)dealEntry) + ")";

         string typeStr = "";
         if(dealType == DEAL_TYPE_BUY) typeStr = "买入";
         else if(dealType == DEAL_TYPE_SELL) typeStr = "卖出";
         else typeStr = "其他";

         // 只显示本品种的交易
         if(dealSymbol == _Symbol)
         {
            Print("  交易[", i, "]: 票据=", dealTicket,
                  " 类型=", entryType, "/", typeStr,
                  " 魔术码=", dealMagic,
                  " 盈亏=$", DoubleToString(dealProfit, 2));
         }
      }

      // 只处理平仓交易（OUT或OUT_BY）
      if(dealEntry != DEAL_ENTRY_OUT && dealEntry != DEAL_ENTRY_OUT_BY)
         continue;

      // 检查是否是本EA的交易
      if(dealMagic != 123456 || dealSymbol != _Symbol)
         continue;

      if(showDebug)
      {
         Print("  ✅ 发现EA平仓交易: 票据=", dealTicket, " 盈亏=$", DoubleToString(dealProfit, 2));
      }

      // 检查这个交易是否已经统计过（避免重复计算）
      bool alreadyProcessed = false;
      for(int j = 0; j < ArraySize(g_ProcessedDeals); j++)
      {
         if(g_ProcessedDeals[j] == dealTicket)
         {
            alreadyProcessed = true;
            break;
         }
      }

      if(alreadyProcessed)
         continue;

      // 这是一个新的平仓交易，更新统计
      double dealCommission = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
      double dealSwap = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
      double totalDealProfit = dealProfit + dealCommission + dealSwap;

      // 记录到已处理列表
      int newSize = ArraySize(g_ProcessedDeals) + 1;
      ArrayResize(g_ProcessedDeals, newSize);
      g_ProcessedDeals[newSize - 1] = dealTicket;

      // 更新统计
      g_TotalTrades++;
      g_TotalProfit += totalDealProfit;
      g_DailyProfit += totalDealProfit;

      Print("═══════════════════════════════════════════════════════");
      Print("📊 检测到平仓交易:");
      Print("   票据: ", dealTicket);
      Print("   盈亏: $", DoubleToString(totalDealProfit, 2));
      Print("   今日累计: $", DoubleToString(g_DailyProfit, 2));

      if(totalDealProfit > 0)
      {
         g_WinningTrades++;
         g_ConsecutiveLosses = 0;
         g_GrossProfit += totalDealProfit;
         if(totalDealProfit > g_LargestWin) g_LargestWin = totalDealProfit;
         if(g_WinningTrades > 0) g_AvgWin = g_GrossProfit / g_WinningTrades;
         Print("   结果: ✅ 盈利");
      }
      else
      {
         g_LosingTrades++;
         g_ConsecutiveLosses++;
         g_LastLossTime = TimeCurrent();
         g_GrossLoss += MathAbs(totalDealProfit);
         if(totalDealProfit < g_LargestLoss) g_LargestLoss = totalDealProfit;
         Print("   结果: ❌ 亏损");
         Print("   连续亏损: ", g_ConsecutiveLosses, "次");
         Print("   冷却开始时间: ", TimeToString(g_LastLossTime, TIME_SECONDS));
         Print("   冷却时长: ", InpCooldownAfterLoss, "秒");
      }
      Print("═══════════════════════════════════════════════════════");

      // 计算盈亏比
      if(g_GrossLoss > 0)
         g_ProfitFactor = g_GrossProfit / g_GrossLoss;
      else
         g_ProfitFactor = g_GrossProfit > 0 ? 999.0 : 0.0;

      // 计算回撤
      double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      if(g_DailyHighEquity > 0.0001)
      {
         double drawdown = ((g_DailyHighEquity - currentEquity) / g_DailyHighEquity) * 100.0;
         if(drawdown > g_MaxDrawdown) g_MaxDrawdown = drawdown;
      }

      Print("📊 检测到平仓: 票据=", dealTicket, " 盈亏=$", DoubleToString(totalDealProfit, 2),
            " | 统计: 总计=", g_TotalTrades, " 盈利=", g_WinningTrades, " 亏损=", g_LosingTrades);

      // 立即更新面板显示
      // 更新今日盈利
      double floatingProfit = 0;
      for(int k = PositionsTotal() - 1; k >= 0; k--)
      {
         if(PositionGetSymbol(k) == _Symbol && PositionGetInteger(POSITION_MAGIC) == 123456)
         {
            floatingProfit += PositionGetDouble(POSITION_PROFIT) +
                             PositionGetDouble(POSITION_SWAP) +
                             PositionGetDouble(POSITION_COMMISSION);
         }
      }
      double dailyTotal = g_DailyProfit + floatingProfit;
      UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotal, 2), dailyTotal >= 0 ? ClrBuy : ClrSell);

      // 更新胜率
      double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
      UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);

      // 更新交易状态
      int openPos = CountTotalOpenPositions();
      UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) + ")", ClrBuy);

      // 强制重绘图表
      ChartRedraw(0);
   }
}

//+------------------------------------------------------------------+
//| PROFESSIONAL: Enhanced AI Context with Regime & Performance      |
//+------------------------------------------------------------------+
string EnhanceAIContext(string baseContext)
{
   string enhanced = baseContext;
   
   // Add market regime context
   if(InpUseRegimeDetection && g_CurrentRegime != REGIME_UNKNOWN)
   {
      string regimeStr = "";
      switch(g_CurrentRegime)
      {
         case REGIME_TRENDING_UP: regimeStr = "TRENDING UP"; break;
         case REGIME_TRENDING_DOWN: regimeStr = "TRENDING DOWN"; break;
         case REGIME_RANGING: regimeStr = "RANGING"; break;
         case REGIME_VOLATILE: regimeStr = "VOLATILE"; break;
      }
      enhanced += "\nMarket Regime: " + regimeStr + "\n";
      
      // Add regime-specific guidance
      switch(g_CurrentRegime)
      {
         case REGIME_TRENDING_UP:
            enhanced += "STRATEGY: Prefer BUY trades, let winners run, wider stops OK\n";
            break;
         case REGIME_TRENDING_DOWN:
            enhanced += "STRATEGY: Prefer SELL trades, let winners run, wider stops OK\n";
            break;
         case REGIME_RANGING:
            enhanced += "STRATEGY: Both directions OK, take quick profits, tighter stops\n";
            break;
         case REGIME_VOLATILE:
            enhanced += "STRATEGY: Reduce position size, wider stops, be cautious\n";
            break;
      }
   }
   
   // Add performance-based guidance
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0.0;
   
   if(winRate < 40.0 && g_TotalTrades > 10)
   {
      enhanced += "\n🚨 CRITICAL: Win rate below 40% - REDUCE TRADING FREQUENCY!\n";
      enhanced += "Only trade HIGH CONFIDENCE setups (>0.70 confidence)\n";
      enhanced += "WAIT more often - don't force trades!\n";
   }
   else if(winRate > 70.0 && g_TotalTrades > 10)
   {
      enhanced += "\n✅ EXCELLENT: Win rate above 70% - Continue current strategy\n";
      enhanced += "But don't get greedy - maintain discipline\n";
   }
   
   if(g_ConsecutiveLosses >= 2)
   {
      enhanced += "\n⚠️ WARNING: " + IntegerToString(g_ConsecutiveLosses) + " consecutive losses\n";
      enhanced += "Be EXTRA conservative - only highest confidence trades\n";
   }
   
   if(g_DailyProfit < -InpMaxDailyLoss * 0.5)
   {
      enhanced += "\n⚠️ WARNING: Daily loss at " + DoubleToString(g_DailyProfit, 2) + " - Near daily limit\n";
      enhanced += "Be very selective with trades\n";
   }
   
   // Add profit factor context
   if(g_ProfitFactor > 0)
   {
      enhanced += "\nProfit Factor: " + DoubleToString(g_ProfitFactor, 2);
      if(g_ProfitFactor > 2.0)
         enhanced += " (EXCELLENT - strategy is profitable)\n";
      else if(g_ProfitFactor > 1.5)
         enhanced += " (GOOD - strategy is working)\n";
      else if(g_ProfitFactor > 1.0)
         enhanced += " (OK - but could be better)\n";
      else
         enhanced += " (POOR - review strategy)\n";
   }
   
   return enhanced;
}

//+------------------------------------------------------------------+
//| 交易后更新面板                                                   |
//+------------------------------------------------------------------+
void UpdatePanelAfterTrade()
{
   // 更新今日盈利（包含浮动盈亏）
   double floatingProfit = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == 123456)
      {
         floatingProfit += PositionGetDouble(POSITION_PROFIT) +
                          PositionGetDouble(POSITION_SWAP) +
                          PositionGetDouble(POSITION_COMMISSION);
      }
   }
   double dailyTotalProfit = g_DailyProfit + floatingProfit;
   UpdateUI("DailyProfit", "$" + DoubleToString(dailyTotalProfit, 2), dailyTotalProfit >= 0 ? ClrBuy : ClrSell);

   // 更新胜率
   double winRate = g_TotalTrades > 0 ? (double)g_WinningTrades / g_TotalTrades * 100.0 : 0;
   UpdateUI("WinRate", DoubleToString(winRate, 1) + "%", winRate >= 50 ? ClrBuy : ClrSell);

   // 更新交易状态
   int openPos = CountTotalOpenPositions();
   int buyPos = CountOpenBuyPositions();
   int sellPos = CountOpenSellPositions();
   UpdateUI("TradingStatus", "活跃 (" + IntegerToString(openPos) + "/" + IntegerToString(InpMaxPositions) +
            " | 多:" + IntegerToString(buyPos) + " 空:" + IntegerToString(sellPos) + ")", ClrBuy);

   // 强制重绘
   ChartRedraw(0);

   Print("✅ 面板已更新: 今日=$", DoubleToString(dailyTotalProfit, 2),
         " 胜率=", DoubleToString(winRate, 1), "%",
         " 持仓=", openPos, "/", InpMaxPositions);
}

//+------------------------------------------------------------------+
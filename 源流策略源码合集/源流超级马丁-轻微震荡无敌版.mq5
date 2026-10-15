//+------------------------------------------------------------------+
//|                                               源流超级马丁 v1.00   |
//|                                    网格马丁 + 双向挂单 + 追踪止损    |
//|                                         原作者: Capella (1mt5.com) |
//|                                       MQL5汉化重构: 源流量化        |
//+------------------------------------------------------------------+
#property copyright "源流量化 - 超级马丁EA"
#property version   "1.00"
#property description "双向网格马丁策略 | 多级追踪止损 | RSI过滤"
#property description "风险警告: 马丁策略有爆仓风险，请小仓位运行"

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>

//+------------------------------------------------------------------+
//| 输入参数 — 基础设置                                                |
//+------------------------------------------------------------------+
input group "===== 基础设置 ====="
input bool   InpDelete_Orders           = true;       // 定时清仓
input int    InpDeleteHour              = 20;         // 清仓时间(小时)
input bool   InpAllow_BUY               = true;       // 允许多头
input bool   InpAllow_SELL              = true;       // 允许空头
input bool   InpEA_FirstOrder           = true;       // EA主动开首单
input bool   InpOpenOnTrend             = false;      // 顺势加仓

input group "===== 网格参数 ====="
input int    InpFirstStep               = 10;         // 首单距离(点)
input int    InpMinPriceDist            = 30;         // 最小价格距离(点)
input int    InpMoveStep                = 5;          // 挂单移动步长(点)
input int    InpDistBetweenOrders       = 30;         // 订单间距(点)

input group "===== 风控参数 ====="
input double InpMaxAllowedLoss          = 100000.0;   // 最大允许亏损
input double InpCloseLossByDD           = 10.0;       // 回撤强平阈值
input double InpLossForClosing          = 100000.0;   // 单方向亏损强平

input group "===== 手数参数 ====="
input double InpOrderLotsize            = 0.1;        // 起始手数
input double InpIncreaseLotsize         = 0.0;        // 每次加仓手数
input double InpMultiplyLotsize         = 1.5;        // 手数倍增系数
input int    InpRoundLotsize            = 2;          // 手数小数位

input group "===== 止盈参数 ====="
input double InpProfitClose2Dir         = 10.0;       // 双向总盈利平仓
input double InpProfitClose1Dir         = 50.0;       // 单方向盈利平仓
input int    InpAutoCalcProfit          = 50;         // 自动计算盈利(0=手动)
input double InpLossClose               = 100000.0;   // 亏损平仓阈值

input group "===== 追踪止损 ====="
input int    InpTrailingType            = 1;          // 追踪类型(0=关 1=K线 2=分形 3=点数)
input int    InpTrailingStep            = 0;          // 追踪步长(点)
input int    InpMinTrailProfit          = 10;         // 最小追踪盈利(点)
input int    InpPaddingFractals         = 0;          // 分形/K线间距
input int    InpTF_Fractals             = 15;         // 分形/K线周期

input group "===== RSI过滤 ====="
input bool   InpOpenOnIndicators        = false;      // RSI过滤首单
input int    InpOversoldZone            = 15;         // 超卖区
input int    InpOverboughtZone          = 85;         // 超买区
input int    InpRSI_Period              = 5;          // RSI周期
input int    InpTF_Indicator            = 0;          // RSI周期(0=当前)

input group "===== 交易时间 ====="
input int    InpStartHour               = 0;          // 开始小时
input int    InpEndHour                 = 24;         // 结束小时

input group "===== 其他 ====="
input int    InpMagic                   = 777;        // 魔术号
input int    InpFontSize                = 8;          // 面板字体大小
input color  InpColorInfo               = clrLightGray; // 面板文字颜色
input int    InpStoploss                = 0;          // 固定止损(点,0=关闭)
input int    InpTakeprofit              = 0;          // 固定止盈(点,0=关闭)

//+------------------------------------------------------------------+
//| 全局变量                                                           |
//+------------------------------------------------------------------+
CTrade   g_trade;
int      g_pointMult = 1;                  // 点数倍率(3/5位经纪商=10)
int      g_stopLevel = 0;                  // 平台止损限制
double   g_tickValue = 0.0;                // 每点价值
int      g_accountNum = 0;                 // 账号
bool     g_isReal = false;                 // 实盘/模拟
string   g_currency = "";                  // 账户货币

// 指标句柄
int      g_hRSI = INVALID_HANDLE;
int      g_hFractals = INVALID_HANDLE;

// 挂单追踪
int      g_buyStopTicket = 0;              // 多头挂单号
int      g_sellStopTicket = 0;             // 空头挂单号
double   g_buyStopPrice = 0.0;             // 多头挂单价
double   g_sellStopPrice = 0.0;            // 空头挂单价

// 今日统计
double   g_todayProfit = 0.0;              // 今日累计盈利
double   g_todayMaxDD = 0.0;               // 今日最大浮亏(负数)
string   g_todayDate = "";                 // 今日日期(用于重置)

// 内部可修改参数 (MQL5的input只读, 需要运行时副本)
int      g_TF_Fractals;                    // 规范化后的分形周期
int      g_DistBetweenOrders;              // 订单间距
int      g_FirstStep;                      // 首单距离
double   g_CloseLossByDD;                  // 回撤强平(负数)
double   g_MaxAllowedLoss;                 // 最大允许亏损(负数)
double   g_LossForClosing;                 // 单方向强平(负数)

//+------------------------------------------------------------------+
//| 时间框架转换 (MQL4整数值 → MQL5枚举)                                |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES ToTF(int mql4tf)
{
   switch(mql4tf)
   {
      case 0:     return PERIOD_CURRENT;
      case 1:     return PERIOD_M1;
      case 5:     return PERIOD_M5;
      case 15:    return PERIOD_M15;
      case 30:    return PERIOD_M30;
      case 60:    return PERIOD_H1;
      case 240:   return PERIOD_H4;
      case 1440:  return PERIOD_D1;
      case 10080: return PERIOD_W1;
      case 43200: return PERIOD_MN1;
      default:    return PERIOD_CURRENT;
   }
}

//+------------------------------------------------------------------+
//| 时间框架规范化 (向上取整到标准值)                                    |
//+------------------------------------------------------------------+
int NormalizeTF(int tf)
{
   if(tf > 43200) return 0;
   if(tf > 10080) return 43200;
   if(tf > 1440)  return 10080;
   if(tf > 240)   return 1440;
   if(tf > 60)    return 240;
   if(tf > 30)    return 60;
   if(tf > 15)    return 30;
   if(tf > 5)     return 15;
   if(tf > 1)     return 5;
   if(tf == 1)    return 1;
   if(tf == 0)    return (int)PeriodSeconds(_Period) / 60;
   return 0;
}

//+------------------------------------------------------------------+
//| 时间框架名称                                                       |
//+------------------------------------------------------------------+
string TFName(int tf)
{
   switch(tf) { case 1: return "M1"; case 5: return "M5"; case 15: return "M15";
      case 30: return "M30"; case 60: return "H1"; case 240: return "H4";
      case 1440: return "D1"; case 10080: return "W1"; case 43200: return "MN1"; }
   return "未知周期";
}

//+------------------------------------------------------------------+
//| 颜色辅助                                                           |
//+------------------------------------------------------------------+
color IfColor(bool cond, color t, color f) { return cond ? t : f; }

//+------------------------------------------------------------------+
//| 交易时间检查                                                       |
//+------------------------------------------------------------------+
bool IsTradingHours()
{
   int sh = InpStartHour, eh = InpEndHour;
   if(sh == 0) sh = 24;
   if(eh == 0) eh = 24;
   MqlDateTime dt; TimeCurrent(dt); int h = dt.hour;
   if(h == 0) h = 24;
   if(sh < eh)  return !(h < sh || h >= eh);
   if(sh > eh)  return !(h < sh && h >= eh);
   return true;
}

//+------------------------------------------------------------------+
//| 获取RSI值                                                          |
//+------------------------------------------------------------------+
double GetRSI()
{
   double buf[1];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(g_hRSI, 0, 0, 1, buf) > 0) return buf[0];
   return 50.0;
}

//+------------------------------------------------------------------+
//| 计算追踪止损价位 (原 f0_833)                                        |
//+------------------------------------------------------------------+
double CalcTrailingLevel(int dir, double price, double trailType)
{
   double result = 0.0;
   ENUM_TIMEFRAMES tf = ToTF(g_TF_Fractals);

   if(trailType > 2.0)  // 点数模式
   {
      if(dir == 1)  result = NormalizeDouble(price - trailType * _Point, _Digits);
      else          result = NormalizeDouble(price + trailType * _Point, _Digits);
   }
   else if(trailType == 2.0)  // 分形模式
   {
      if(dir == 1)
      {
         for(int i = 1; i < 100; i++)
         {
            double buf[1]; ArraySetAsSeries(buf, true);
            if(CopyBuffer(g_hFractals, 0, i, 1, buf) > 0 && buf[0] != 0.0)
            {
               result = buf[0] - InpPaddingFractals * _Point;
               if(price - g_stopLevel * _Point > result) break;
            }
         }
         // 画箭头
         ObjectDelete(0, "FR_Buy"); ObjectCreate(0, "FR_Buy", OBJ_ARROW, 0, 0, 0);
         ObjectSetInteger(0, "FR_Buy", OBJPROP_ARROWCODE, 218);
         ObjectSetInteger(0, "FR_Buy", OBJPROP_COLOR, clrRed);
      }
      else
      {
         for(int i = 1; i < 100; i++)
         {
            double buf[1]; ArraySetAsSeries(buf, true);
            if(CopyBuffer(g_hFractals, 1, i, 1, buf) > 0 && buf[0] != 0.0)
            {
               result = buf[0] + InpPaddingFractals * _Point;
               if(price + g_stopLevel * _Point < result) break;
            }
         }
         ObjectDelete(0, "FR_Sell"); ObjectCreate(0, "FR_Sell", OBJ_ARROW, 0, 0, 0);
         ObjectSetInteger(0, "FR_Sell", OBJPROP_ARROWCODE, 217);
         ObjectSetInteger(0, "FR_Sell", OBJPROP_COLOR, clrRed);
      }
   }
   else if(trailType == 1.0)  // K线高低点模式
   {
      if(dir == 1)
      {
         for(int i = 1; i < 500; i++)
         {
            double low[1]; ArraySetAsSeries(low, true);
            if(CopyLow(_Symbol, tf, i, 1, low) > 0)
            {
               result = NormalizeDouble(low[0] - InpPaddingFractals * _Point, _Digits);
               if(result != 0.0 && price - g_stopLevel * _Point > result) break;
            }
         }
         ObjectDelete(0, "FR_Buy"); ObjectCreate(0, "FR_Buy", OBJ_ARROW, 0, 0, 0);
         ObjectSetInteger(0, "FR_Buy", OBJPROP_ARROWCODE, 159);
         ObjectSetInteger(0, "FR_Buy", OBJPROP_COLOR, clrRed);
      }
      else
      {
         for(int i = 1; i < 500; i++)
         {
            double high[1]; ArraySetAsSeries(high, true);
            if(CopyHigh(_Symbol, tf, i, 1, high) > 0)
            {
               result = NormalizeDouble(high[0] + InpPaddingFractals * _Point, _Digits);
               if(result != 0.0 && price + g_stopLevel * _Point < result) break;
            }
         }
         ObjectDelete(0, "FR_Sell"); ObjectCreate(0, "FR_Sell", OBJ_ARROW, 0, 0, 0);
         ObjectSetInteger(0, "FR_Sell", OBJPROP_ARROWCODE, 159);
         ObjectSetInteger(0, "FR_Sell", OBJPROP_COLOR, clrRed);
      }
   }

   // 画止损线
   if(dir == 1 && result != 0.0)
   {
      ObjectDelete(0, "SL_Buy");
      ObjectCreate(0, "SL_Buy", OBJ_ARROW, 0, TimeCurrent() + 60 * PeriodSeconds(_Period), result, 0, 0);
      ObjectSetInteger(0, "SL_Buy", OBJPROP_ARROWCODE, 6);
      ObjectSetInteger(0, "SL_Buy", OBJPROP_COLOR, clrBlue);
   }
   if(dir == -1 && result != 0.0)
   {
      ObjectDelete(0, "SL_Sell");
      ObjectCreate(0, "SL_Sell", OBJ_ARROW, 0, TimeCurrent() + 60 * PeriodSeconds(_Period), result, 0, 0);
      ObjectSetInteger(0, "SL_Sell", OBJPROP_ARROWCODE, 6);
      ObjectSetInteger(0, "SL_Sell", OBJPROP_COLOR, clrPink);
   }

   return result;
}

//+------------------------------------------------------------------+
//| 平仓指定方向 (原 f0_1880)                                          |
//| ai_dir: 1=多头, -1=空头, 0=全部                                   |
//+------------------------------------------------------------------+
bool CloseDirection(int ai_dir)
{
   int retry = 0;
   bool ok = true;

   while(true)  // 无限重试直到全平
   {
      for(int i = OrdersTotal() - 1; i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
         if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;

         ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);

         // 市价单平仓
         if((type == ORDER_TYPE_BUY  && (ai_dir == 1 || ai_dir == 0)) ||
            (type == ORDER_TYPE_SELL && (ai_dir == -1 || ai_dir == 0)))
         {
            double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
            double price = (type == ORDER_TYPE_BUY) ? bid : ask;
            g_trade.PositionClose(ticket);
            if(g_trade.ResultRetcode() == TRADE_RETCODE_DONE)
               Comment("已平仓 #", ticket, " 盈亏=", g_trade.ResultPrice());
            else
            {
               int err = (int)g_trade.ResultRetcode();
               if(err == TRADE_RETCODE_REJECT || err == 129)
                  { Comment("价格错误 ", TimeCurrent()); {MqlTick _t; SymbolInfoTick(_Symbol, _t);}; continue; }
               if(err == 146)
                  { continue; Sleep(2000); continue; }
               Comment("平仓错误 ", err, " #", ticket);
            }
         }

         // 挂单删除
         if((type == ORDER_TYPE_BUY_STOP  && (ai_dir == 1 || ai_dir == 0)) ||
            (type == ORDER_TYPE_SELL_STOP && (ai_dir == -1 || ai_dir == 0)))
            g_trade.OrderDelete(ticket);
      }

      // 验证是否全部清理完毕
      int remaining = 0;
      for(int i = OrdersTotal() - 1; i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
         if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
         ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_BUY_STOP)
            if(ai_dir == 1 || ai_dir == 0) remaining++;
         if(type == ORDER_TYPE_SELL || type == ORDER_TYPE_SELL_STOP)
            if(ai_dir == -1 || ai_dir == 0) remaining++;
      }
      if(remaining == 0) break;

      retry++;
      if(retry > 10)
      {
         Alert(_Symbol, " 平仓失败! 仍有 ", remaining, " 单残留");
         return false;
      }
      Sleep(1000);
      {MqlTick _t; SymbolInfoTick(_Symbol, _t);};
   }
   return true;
}

//+------------------------------------------------------------------+
//| 删除所有挂单                                                       |
//+------------------------------------------------------------------+
void DeleteAllPending()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type == ORDER_TYPE_BUY_STOP || type == ORDER_TYPE_SELL_STOP)
         g_trade.OrderDelete(ticket);
   }
}

//+------------------------------------------------------------------+
//| 更新信息面板                                                       |
//+------------------------------------------------------------------+
void UpdatePanel(int spacing, int layers, double todayProfit, double todayMaxDD,
                 bool blocked, bool ddActive,
                 double buyAvg, double buyLots, double sellAvg, double sellLots)
{
   ObjectSetString(0, "YU_L0", OBJPROP_TEXT, StringFormat("间距     %d点", spacing));
   ObjectSetString(0, "YU_L1", OBJPROP_TEXT, StringFormat("层数     %d层", layers));
   ObjectSetString(0, "YU_L2", OBJPROP_TEXT, StringFormat("盈亏     %+.0f %s", todayProfit, todayProfit >= 0 ? "▲" : "▼"));
   ObjectSetInteger(0, "YU_L2", OBJPROP_COLOR, todayProfit >= 0 ? C'100,200,120' : C'230,100,100');
   ObjectSetString(0, "YU_L3", OBJPROP_TEXT, StringFormat("浮亏     %.0f", todayMaxDD));
   ObjectSetInteger(0, "YU_L3", OBJPROP_COLOR, todayMaxDD < 0 ? C'230,150,80' : C'130,130,140');

   // 精准平仓价: avg + 系数×点值 (与止盈计算完全一致)
   double _dist = InpAutoCalcProfit * _Point;
   if(buyLots > 0)
   {
      double _tpB = NormalizeDouble(buyAvg + _dist, _Digits);
      ObjectSetString(0, "YU_TP_B", OBJPROP_TEXT, StringFormat("多平仓   %.2f", _tpB));
      ObjectSetInteger(0, "YU_TP_B", OBJPROP_COLOR, C'100,190,230');
   }
   else
   {
      ObjectSetString(0, "YU_TP_B", OBJPROP_TEXT, "多平仓   ---");
      ObjectSetInteger(0, "YU_TP_B", OBJPROP_COLOR, C'80,80,90');
   }

   if(sellLots > 0)
   {
      double _tpS = NormalizeDouble(sellAvg - _dist, _Digits);
      ObjectSetString(0, "YU_TP_S", OBJPROP_TEXT, StringFormat("空平仓   %.2f", _tpS));
      ObjectSetInteger(0, "YU_TP_S", OBJPROP_COLOR, C'230,140,140');
   }
   else
   {
      ObjectSetString(0, "YU_TP_S", OBJPROP_TEXT, "空平仓   ---");
      ObjectSetInteger(0, "YU_TP_S", OBJPROP_COLOR, C'80,80,90');
   }

   string st;
   if(ddActive || blocked) st = "⚠ 暂停";
   else if(layers > 0)     st = "● 持仓";
   else                    st = "○ 等待";
   ObjectSetString(0, "YU_State", OBJPROP_TEXT, "状态     " + st);
   ObjectSetInteger(0, "YU_State", OBJPROP_COLOR, (ddActive || blocked) ? C'240,160,60' :
                                               layers > 0 ? C'100,200,120' : C'130,130,140');
}

//+------------------------------------------------------------------+
//| 创建信息面板 (GUI) — 左上角                                         |
//+------------------------------------------------------------------+
void CreatePanel()
{
   int fs = InpFontSize;
   int x0 = 6, y = 4;
   int lh = fs + 5;
   int bw = 170;  // 面板宽

   #define MK(name, yy, txt, c) \
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0); \
      ObjectSetInteger(0, name, OBJPROP_CORNER, 0); \
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x0); \
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, yy); \
      ObjectSetString(0, name, OBJPROP_TEXT, txt); \
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fs); \
      ObjectSetInteger(0, name, OBJPROP_COLOR, c);

   // 背景面板 (置后，不挡住按钮)
   ObjectCreate(0, "YU_BG", OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, "YU_BG", OBJPROP_CORNER, 0);
   ObjectSetInteger(0, "YU_BG", OBJPROP_XDISTANCE, 0);
   ObjectSetInteger(0, "YU_BG", OBJPROP_YDISTANCE, 0);
   ObjectSetInteger(0, "YU_BG", OBJPROP_XSIZE, bw);
   ObjectSetInteger(0, "YU_BG", OBJPROP_YSIZE, lh * 9 + 28);
   ObjectSetInteger(0, "YU_BG", OBJPROP_BGCOLOR, C'18,20,26');
   ObjectSetInteger(0, "YU_BG", OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, "YU_BG", OBJPROP_COLOR, C'60,65,75');
   ObjectSetInteger(0, "YU_BG", OBJPROP_BACK, true);    // 置后
   ObjectSetInteger(0, "YU_BG", OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, "YU_BG", OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, "YU_BG", OBJPROP_ZORDER, 0);

   // 标题
   MK("YU_Title", y, "◆ 源流超级马丁", C'240,200,100');   y += lh + 3;

   // 数据区
   MK("YU_L0", y, "间距     ---", C'180,185,190');         y += lh;
   MK("YU_L1", y, "层数     ---", C'180,185,190');         y += lh;
   MK("YU_L2", y, "盈亏     ---", C'180,185,190');         y += lh;
   MK("YU_L3", y, "浮亏     ---", C'180,185,190');         y += lh + 3;

   // 平仓价
   MK("YU_TP_B", y, "多平仓   ---", C'100,190,230');       y += lh;
   MK("YU_TP_S", y, "空平仓   ---", C'230,140,140');       y += lh + 3;

   // 状态
   MK("YU_State", y, "状态     就绪", C'150,155,165');

   // 一键平仓按钮 (面板底部, 先删后建确保属性生效)
   y += lh + 2;
   ObjectDelete(0, "YU_CloseBtn");
   ObjectCreate(0, "YU_CloseBtn", OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_CORNER, 0);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_XDISTANCE, 8);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_XSIZE, bw - 16);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_YSIZE, 22);
   ObjectSetString(0, "YU_CloseBtn", OBJPROP_TEXT, "一键平仓");
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_FONTSIZE, 10);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_COLOR, clrWhite);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_BGCOLOR, C'180,35,35');
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_BORDER_COLOR, C'220,50,50');
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_STATE, 0);
   ObjectSetInteger(0, "YU_CloseBtn", OBJPROP_ZORDER, 10);
   ChartRedraw(0);

   #undef MK
}

void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
   if(id == CHARTEVENT_OBJECT_CLICK && sparam == "YU_CloseBtn")
   {
      Print("🛑 一键平仓触发...");

      // 先收集所有要处理的ticket (避免边删边遍历导致漏单)
      ulong posTickets[100];  int pc = 0;
      ulong ordTickets[100];  int oc = 0;

      for(int i = OrdersTotal() - 1; i >= 0; i--)
      {
         ulong t = OrderGetTicket(i);
         if(t == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
         ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         if(ty == ORDER_TYPE_BUY || ty == ORDER_TYPE_SELL)
            { if(pc < 100) posTickets[pc++] = t; }
         else
            { if(oc < 100) ordTickets[oc++] = t; }
      }

      // 全部平仓
      for(int i = 0; i < pc; i++) g_trade.PositionClose(posTickets[i]);
      // 全部删挂单
      for(int i = 0; i < oc; i++) g_trade.OrderDelete(ordTickets[i]);

      Print("✅ 一键平仓完成: 平", pc, "单, 删", oc, "挂单");
   }
}

//+------------------------------------------------------------------+
//| EA初始化                                                           |
//+------------------------------------------------------------------+
int OnInit()
{
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(30);  // MQL4原版 gi_316=30

   // 检测点数倍率
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   g_pointMult = (digits == 5 || digits == 3) ? 10 : 1;

   g_tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   g_stopLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   g_accountNum = (int)AccountInfoInteger(ACCOUNT_LOGIN);
   g_currency = " " + AccountInfoString(ACCOUNT_CURRENCY);
   g_isReal = !(bool)MQLInfoInteger(MQL_TESTER);

   // 规范化时间框架 (input只读, 存入可修改的全局变量)
   g_TF_Fractals = NormalizeTF(InpTF_Fractals);

   // 校验间距参数 (从input复制到可修改的g_变量)
   g_DistBetweenOrders = InpDistBetweenOrders;
   if(g_DistBetweenOrders < g_stopLevel)
   {
      Alert("订单间距(", g_DistBetweenOrders, ")小于平台要求(", g_stopLevel, ")，已自动修正");
      g_DistBetweenOrders = g_stopLevel;
   }
   g_FirstStep = InpFirstStep;
   if(g_FirstStep < g_stopLevel)
   {
      Alert("首单距离(", g_FirstStep, ")小于平台要求(", g_stopLevel, ")，已自动修正");
      g_FirstStep = g_stopLevel;
   }

   // 创建指标句柄
   ENUM_TIMEFRAMES indTF = ToTF(InpTF_Indicator);
   g_hRSI = iRSI(_Symbol, indTF, InpRSI_Period, PRICE_CLOSE);
   g_hFractals = iFractals(_Symbol, ToTF(g_TF_Fractals));

   // 内部变量转换(转为负数, 方便比较)
   g_CloseLossByDD = -MathAbs(InpCloseLossByDD);
   g_MaxAllowedLoss = -MathAbs(InpMaxAllowedLoss);
   g_LossForClosing = -MathAbs(InpLossForClosing);

   // 扫描已有持仓(重启后恢复管理)
   int _existing = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong t = OrderGetTicket(i);
      if(t == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      _existing++;
   }
   if(_existing > 0) Print("📋 检测到 ", _existing, " 个已有持仓/挂单, 已接管");

   // 创建GUI (含一键平仓按钮)
   CreatePanel();

   Print("✅ 源流超级马丁 v1.0 初始化完成 | 品种: ", _Symbol,
         " | 魔术号: ", InpMagic, " | 方向: ",
         (InpAllow_BUY ? "多" : ""), (InpAllow_SELL ? "空" : ""));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EA退出                                                             |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   ObjectsDeleteAll(0, "YU_");
   if(g_hRSI != INVALID_HANDLE) IndicatorRelease(g_hRSI);
   if(g_hFractals != INVALID_HANDLE) IndicatorRelease(g_hFractals);
   Print("👋 源流超级马丁已卸载");
}

//+------------------------------------------------------------------+
//| 主逻辑 Tick                                                        |
//+------------------------------------------------------------------+
void OnTick()
{
   // 定时清仓
   MqlDateTime _dt; TimeCurrent(_dt);
   if(InpDelete_Orders && _dt.hour == InpDeleteHour)
      DeleteAllPending();

   // 每100tick输出一次心跳
   static int _diag = 0; _diag++;
   if(_diag % 100 == 1)
      Print("💓 马丁tick#", _diag, " 品种=", _Symbol, " ask=", SymbolInfoDouble(_Symbol, SYMBOL_ASK));

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // ---- 统计现有持仓和挂单 ----
   int    buyCnt = 0, sellCnt = 0, buyStopCnt = 0, sellStopCnt = 0;
   double buyProfit = 0.0, sellProfit = 0.0;
   double buyLots = 0.0, sellLots = 0.0;
   double buyWeightedPrice = 0.0, sellWeightedPrice = 0.0;
   double buyHighest = 0.0, buyLowest = 0.0;  // 最高/最低多头开仓价
   double sellHighest = 0.0, sellLowest = 0.0;

   g_buyStopTicket = 0;  g_buyStopPrice = 0.0;
   g_sellStopTicket = 0; g_sellStopPrice = 0.0;

   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;

      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      double op = OrderGetDouble(ORDER_PRICE_OPEN);
      double lots = OrderGetDouble(ORDER_VOLUME_CURRENT);
      double sl = OrderGetDouble(ORDER_SL);
      double tp = OrderGetDouble(ORDER_TP);

      if(type == ORDER_TYPE_BUY_STOP)
      {
         buyStopCnt++;
         if(g_buyStopPrice < op || g_buyStopPrice == 0.0) { g_buyStopPrice = op; g_buyStopTicket = (int)ticket; }
      }
      if(type == ORDER_TYPE_SELL_STOP)
      {
         sellStopCnt++;
         if(g_sellStopPrice > op || g_sellStopPrice == 0.0) { g_sellStopPrice = op; g_sellStopTicket = (int)ticket; }
      }

      if(type == ORDER_TYPE_BUY)
      {
         buyCnt++;
         buyLots += lots;
         buyWeightedPrice += op * lots;
         PositionSelectByTicket(ticket);
         buyProfit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP) + PositionGetDouble(POSITION_COMMISSION);
         if(g_buyStopPrice < op || g_buyStopPrice == 0.0) g_buyStopPrice = op;
         if(buyLowest > op || buyLowest == 0.0) buyLowest = op;
         if(buyHighest < op || buyHighest == 0.0) buyHighest = op;

         // 固定止损止盈
         double newSL = sl, newTP = tp;
         if(sl == 0.0 && InpStoploss >= g_stopLevel && InpStoploss != 0)
            newSL = NormalizeDouble(op - InpStoploss * _Point, _Digits);
         if(tp == 0.0 && InpTakeprofit >= g_stopLevel && InpTakeprofit != 0)
            newTP = NormalizeDouble(op + InpTakeprofit * _Point, _Digits);
         if(newSL > sl || newTP != tp)
            if(!g_trade.OrderModify(ticket, op, newSL, newTP, ORDER_TIME_GTC, 0))
               Print("修改买单SL/TP失败: ", GetLastError());
      }

      if(type == ORDER_TYPE_SELL)
      {
         sellCnt++;
         sellLots += lots;
         sellWeightedPrice += op * lots;
         PositionSelectByTicket(ticket);
         sellProfit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP) + PositionGetDouble(POSITION_COMMISSION);
         if(g_sellStopPrice > op || g_sellStopPrice == 0.0) g_sellStopPrice = op;
         if(sellLowest > op || sellLowest == 0.0) sellLowest = op;
         if(sellHighest < op || sellHighest == 0.0) sellHighest = op;

         double newSL = sl, newTP = tp;
         if(sl == 0.0 && InpStoploss >= g_stopLevel && InpStoploss != 0)
            newSL = NormalizeDouble(op + InpStoploss * _Point, _Digits);
         if(tp == 0.0 && InpTakeprofit >= g_stopLevel && InpTakeprofit != 0)
            newTP = NormalizeDouble(op - InpTakeprofit * _Point, _Digits);
         if(newSL < sl || (sl == 0.0 && newSL != 0.0) || newTP != tp)
            if(!g_trade.OrderModify(ticket, op, newSL, newTP, ORDER_TIME_GTC, 0))
               Print("修改卖单SL/TP失败: ", GetLastError());
      }
   }

   // 均价
   double buyAvg = (buyLots > 0) ? NormalizeDouble(buyWeightedPrice / buyLots, _Digits) : 0.0;
   double sellAvg = (sellLots > 0) ? NormalizeDouble(sellWeightedPrice / sellLots, _Digits) : 0.0;

   // 画均价线
   ObjectDelete(0, "SLb"); ObjectDelete(0, "SLs");
   if(buyCnt > 0)
   {
      ObjectCreate(0, "SLb", OBJ_ARROW, 0, TimeCurrent(), buyAvg, 0, 0);
      ObjectSetInteger(0, "SLb", OBJPROP_ARROWCODE, 6);
      ObjectSetInteger(0, "SLb", OBJPROP_COLOR, clrBlue);
   }
   if(sellCnt > 0)
   {
      ObjectCreate(0, "SLs", OBJ_ARROW, 0, TimeCurrent(), sellAvg, 0, 0);
      ObjectSetInteger(0, "SLs", OBJPROP_ARROWCODE, 6);
      ObjectSetInteger(0, "SLs", OBJPROP_COLOR, clrRed);
   }

   // ---- 追踪止损 ----
   if(InpTrailingType != 0)
   {
      for(int i = OrdersTotal() - 1; i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
         if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;

         ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         double op = OrderGetDouble(ORDER_PRICE_OPEN);
         double sl = NormalizeDouble(OrderGetDouble(ORDER_SL), _Digits);

         if(type == ORDER_TYPE_BUY)
         {
            double trailLevel = CalcTrailingLevel(1, bid, InpTrailingType);
            if(trailLevel >= buyAvg + InpMinTrailProfit * _Point &&
               trailLevel > sl + InpTrailingStep * _Point &&
               (bid - trailLevel) / _Point > g_stopLevel)
            {
               double newSL = trailLevel;
               if(newSL > sl)
                  if(!g_trade.OrderModify(ticket, op, newSL, OrderGetDouble(ORDER_TP), ORDER_TIME_GTC, 0))
                     Print("追踪止损(多)失败: ", GetLastError());
            }
         }

         if(type == ORDER_TYPE_SELL)
         {
            double trailLevel = CalcTrailingLevel(-1, ask, InpTrailingType);
            if(trailLevel <= sellAvg - InpMinTrailProfit * _Point &&
               (trailLevel < sl - InpTrailingStep * _Point || (sl == 0.0 && (trailLevel - ask) / _Point > g_stopLevel)))
            {
               double newSL = trailLevel;
               if(newSL < sl || (sl == 0.0 && newSL != 0.0))
                  if(!g_trade.OrderModify(ticket, op, newSL, OrderGetDouble(ORDER_TP), ORDER_TIME_GTC, 0))
                     Print("追踪止损(空)失败: ", GetLastError());
            }
         }
      }
   }

   // ---- 计算止盈阈值 ----
   double closeBuyProfit = 0.0, closeSellProfit = 0.0;
   if(InpAutoCalcProfit == 0)
   {
      closeBuyProfit = InpProfitClose1Dir;
      closeSellProfit = InpProfitClose1Dir;
   }
   else
   {
      if(buyLots == 0.0) closeBuyProfit = InpOrderLotsize * InpAutoCalcProfit * g_tickValue;
      else                closeBuyProfit = buyLots * InpAutoCalcProfit * g_tickValue;
      if(sellLots == 0.0) closeSellProfit = InpOrderLotsize * InpAutoCalcProfit * g_tickValue;
      else                closeSellProfit = sellLots * InpAutoCalcProfit * g_tickValue;
   }

   bool ddActive = (buyProfit <= g_CloseLossByDD && sellProfit <= g_CloseLossByDD);  // 双向都亏损才算回撤

   // ---- 止盈平仓 ----
   // 双向总盈利平仓(优先)
   if(buyProfit + sellProfit >= InpProfitClose2Dir)
   {
      Print("✅ 双向止盈 ", buyProfit + sellProfit, " > ", InpProfitClose2Dir);
      CloseDirection(0); return;
   }
   // 回撤安全时,单向止盈
   if(!ddActive)
   {
      if(buyProfit >= closeBuyProfit)  { Print("✅ 多头止盈 ", buyProfit); CloseDirection(1); return; }
      if(sellProfit >= closeSellProfit) { Print("✅ 空头止盈 ", sellProfit); CloseDirection(-1); return; }
   }

   // ---- 亏损强平 ----
   if(buyProfit <= g_LossForClosing)
   {
      Print("🛑 多头亏损强平 ", buyProfit, " <= ", g_LossForClosing);
      CloseDirection(1);
      return;
   }
   if(sellProfit <= g_LossForClosing)
   {
      Print("🛑 空头亏损强平 ", sellProfit, " <= ", g_LossForClosing);
      CloseDirection(-1);
      return;
   }

   // ---- 判断是否禁止开仓方向 ----
   bool buyBlocked = (buyProfit <= g_MaxAllowedLoss);
   bool sellBlocked = (sellProfit <= g_MaxAllowedLoss);

   // ---- RSI 信号 ----
   double rsi = GetRSI();

   // ---- 首次诊断 ----
   static bool _once = false;
   if(!_once) { _once = true;
      double _rsi = GetRSI();
      Print("🔍 马丁首次诊断 | buyStopCnt=", buyStopCnt, " buyProfit=", buyProfit,
            " > g_MaxAllowedLoss=", g_MaxAllowedLoss, "? ", (buyProfit > g_MaxAllowedLoss),
            " | sellStopCnt=", sellStopCnt, " sellProfit=", sellProfit,
            " | RSI=", _rsi, " oversold=", InpOversoldZone,
            " | FirstStep=", g_FirstStep, " DistOrders=", g_DistBetweenOrders);
   }

   // ---- 多头挂单 ----
   if(buyStopCnt == 0 && buyProfit > g_MaxAllowedLoss && InpAllow_BUY)
   {
      double orderPrice = 0.0;
      if(buyCnt == 0)
      {
         // 首单: RSI超卖或有信号才开
         if(rsi < InpOversoldZone || !InpOpenOnIndicators)
            orderPrice = NormalizeDouble(ask + g_FirstStep * _Point, _Digits);
      }
      else
      {
         // 加仓: 保持最小距离, 网格间距
         orderPrice = NormalizeDouble(ask + InpMinPriceDist * _Point, _Digits);
         if(orderPrice < NormalizeDouble(buyLowest - g_DistBetweenOrders * _Point, _Digits))
            orderPrice = NormalizeDouble(ask + g_DistBetweenOrders * _Point, _Digits);
      }

      if(orderPrice != 0.0)
      {
         bool allow = (buyCnt == 0) ||
                      (buyCnt > 0 && buyHighest > 0 && orderPrice >= NormalizeDouble(buyHighest + g_DistBetweenOrders * _Point, _Digits) && InpOpenOnTrend) ||
                      (g_buyStopPrice != 0.0 && orderPrice >= NormalizeDouble(g_buyStopPrice + g_DistBetweenOrders * _Point, _Digits)) ||
                      (buyLowest > 0 && orderPrice <= NormalizeDouble(buyLowest - g_DistBetweenOrders * _Point, _Digits));

         if(allow)
         {
            double lot = (buyCnt == 0) ? InpOrderLotsize :
                         NormalizeDouble(InpOrderLotsize * MathPow(InpMultiplyLotsize, buyCnt) + buyCnt * InpIncreaseLotsize, InpRoundLotsize);

            // MQL5的OrderCalcMargin对挂单返回0, 改用SymbolInfoDouble获取单笔保证金
            double marginPerLot = SymbolInfoDouble(_Symbol, SYMBOL_MARGIN_INITIAL);
            if(marginPerLot <= 0.0) marginPerLot = 1000.0; // 兜底
            if(lot * marginPerLot < AccountInfoDouble(ACCOUNT_MARGIN_FREE) || buyCnt == 0)
            {
               if(InpEA_FirstOrder || buyCnt > 0)
                  {
                     if(IsTradingHours())
                     {
                        g_trade.BuyStop(lot, orderPrice, _Symbol, 0, 0, ORDER_TIME_GTC, 0, "YU_Martin");
                        if(g_trade.ResultRetcode() != TRADE_RETCODE_DONE)
                           Print("❌ BuyStop挂单失败: ", g_trade.ResultRetcode());
                     }
                     else Comment("⏸ 非交易时段, BuyStop暂停");
                  }
               else Comment("⚠ 保证金不足, 无法下BuyStop 手数=", DoubleToString(lot, 2));
            }
         }
      }
   }

   // ---- 空头挂单 ----
   if(sellStopCnt == 0 && sellProfit > g_MaxAllowedLoss && InpAllow_SELL)
   {
      double orderPrice = 0.0;
      if(sellCnt == 0)
      {
         if(rsi > InpOverboughtZone || !InpOpenOnIndicators)
            orderPrice = NormalizeDouble(bid - g_FirstStep * _Point, _Digits);
      }
      else
      {
         orderPrice = NormalizeDouble(bid - InpMinPriceDist * _Point, _Digits);
         if(orderPrice < NormalizeDouble(sellHighest + g_DistBetweenOrders * _Point, _Digits))
            orderPrice = NormalizeDouble(bid - g_DistBetweenOrders * _Point, _Digits);
      }

      if(orderPrice != 0.0)
      {
         bool allow = (sellCnt == 0) ||
                      (sellCnt > 0 && g_sellStopPrice != 0.0 && orderPrice <= NormalizeDouble(g_sellStopPrice - g_DistBetweenOrders * _Point, _Digits) && InpOpenOnTrend) ||
                      (sellHighest > 0 && orderPrice >= NormalizeDouble(sellHighest + g_DistBetweenOrders * _Point, _Digits));

         if(allow)
         {
            double lot = (sellCnt == 0) ? InpOrderLotsize :
                         NormalizeDouble(InpOrderLotsize * MathPow(InpMultiplyLotsize, sellCnt) + sellCnt * InpIncreaseLotsize, InpRoundLotsize);

            // MQL5的OrderCalcMargin对挂单返回0, 改用SymbolInfoDouble获取单笔保证金
            double marginPerLot = SymbolInfoDouble(_Symbol, SYMBOL_MARGIN_INITIAL);
            if(marginPerLot <= 0.0) marginPerLot = 1000.0;
            if(lot * marginPerLot < AccountInfoDouble(ACCOUNT_MARGIN_FREE) || sellCnt == 0)
            {
               if(InpEA_FirstOrder || sellCnt > 0)
                  {
                     if(IsTradingHours())
                     {
                        g_trade.SellStop(lot, orderPrice, _Symbol, 0, 0, ORDER_TIME_GTC, 0, "YU_Martin");
                        if(g_trade.ResultRetcode() != TRADE_RETCODE_DONE)
                           Print("❌ SellStop挂单失败: ", g_trade.ResultRetcode());
                     }
                     else Comment("⏸ 非交易时段, SellStop暂停");
                  }
               else Comment("⚠ 保证金不足, 无法下SellStop 手数=", DoubleToString(lot, 2));
            }
         }
      }
   }

   // ---- 移动现有挂单 (步进追踪) ----
   if(g_buyStopTicket != 0 && InpAllow_BUY)
   {
      double targetPrice = 0.0;
      if(buyCnt == 0) targetPrice = NormalizeDouble(ask + g_FirstStep * _Point, _Digits);
      else            targetPrice = NormalizeDouble(ask + InpMinPriceDist * _Point, _Digits);

      if(NormalizeDouble(g_buyStopPrice - InpMoveStep * _Point, _Digits) > targetPrice &&
         (buyLowest == 0.0 || targetPrice <= NormalizeDouble(buyLowest - g_DistBetweenOrders * _Point, _Digits)) ||
         (buyHighest > 0 && targetPrice >= NormalizeDouble(buyHighest + g_DistBetweenOrders * _Point, _Digits)))
      {
         if(!g_trade.OrderModify(g_buyStopTicket, targetPrice, 0, 0, ORDER_TIME_GTC, 0))
            Print("❌ 移动BuyStop失败: ", GetLastError(), " ", g_buyStopPrice, "→", targetPrice);
      }
   }

   if(g_sellStopTicket != 0 && InpAllow_SELL)
   {
      double targetPrice = 0.0;
      if(sellCnt == 0) targetPrice = NormalizeDouble(bid - g_FirstStep * _Point, _Digits);
      else             targetPrice = NormalizeDouble(bid - InpMinPriceDist * _Point, _Digits);

      if(NormalizeDouble(g_sellStopPrice + InpMoveStep * _Point, _Digits) < targetPrice &&
         (sellHighest == 0.0 || targetPrice >= NormalizeDouble(sellHighest + g_DistBetweenOrders * _Point, _Digits)) ||
         (sellLowest > 0 && targetPrice <= NormalizeDouble(g_sellStopPrice - g_DistBetweenOrders * _Point, _Digits)))
      {
         if(!g_trade.OrderModify(g_sellStopTicket, targetPrice, 0, 0, ORDER_TIME_GTC, 0))
            Print("❌ 移动SellStop失败: ", GetLastError(), " ", g_sellStopPrice, "→", targetPrice);
      }
   }

   // ---- 每日重置 ----
   MqlDateTime _now; TimeCurrent(_now);
   string _today = StringFormat("%04d.%02d.%02d", _now.year, _now.mon, _now.day);
   if(g_todayDate != _today)
   {
      g_todayDate = _today;
      g_todayProfit = 0.0;
      g_todayMaxDD = 0.0;
   }
   double _totalP = buyProfit + sellProfit;
   if(_totalP < g_todayMaxDD) g_todayMaxDD = _totalP;
   g_todayProfit = _totalP;

   // ---- 更新面板 ----
   int _layers = MathMax(buyCnt, sellCnt);
   double _buyAvg = (buyLots > 0) ? NormalizeDouble(buyWeightedPrice / buyLots, _Digits) : 0.0;
   double _sellAvg = (sellLots > 0) ? NormalizeDouble(sellWeightedPrice / sellLots, _Digits) : 0.0;
   UpdatePanel(g_DistBetweenOrders, _layers, g_todayProfit, g_todayMaxDD,
               buyBlocked || sellBlocked, ddActive, _buyAvg, buyLots, _sellAvg, sellLots);
}
//+------------------------------------------------------------------+
//|                            END OF FILE                            |
//+------------------------------------------------------------------+

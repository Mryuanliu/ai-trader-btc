//+------------------------------------------------------------------+
//|                                          源流智能过滤马丁.mq5     |
//|                              基于 Caius Killer 3.6 改写为 MQL5    |
//|                              版权 2025, 原始作者: 1mt5.com        |
//+------------------------------------------------------------------+
#property copyright "源流智能过滤马丁 - MQL5 版本"
#property link      "https://www.1mt5.com"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>
#include <Trade\SymbolInfo.mqh>

//--- MQL4 兼容常量定义
#define OP_BUY   POSITION_TYPE_BUY
#define OP_SELL  POSITION_TYPE_SELL

//--- 错误代码常量（与MQ4一致）
#define ERR_TRADE_SERVER_BUSY   4
#define ERR_TRADE_CONTEXT_BUSY  146
#define ERR_BROKER_BUSY         137
#define ERR_OFF_QUOTES          136
#define ERR_INVALID_PRICE       129
#define ERR_REQUOTE             138
#define ERR_TRADE_TIMEOUT       128

//+------------------------------------------------------------------+
//| 通用设置                                                          |
//+------------------------------------------------------------------+
input string   InpSeparator1       = "===== 通用设置 =====";          // Vx:1mt5.com
input double   Inp风险比           = 0.001;                           // 风险比
input double   Inp轻仓止盈ATR     = 0.5;                             // 1-2层:止盈=均价偏移+ATR×此值
input double   Inp中仓止盈ATR     = 0.3;                             // 3-4层:保本+ATR×此值(微利)
input double   Inp深仓止盈ATR     = 0.1;                             // 5+层:保本+ATR×此值(逃生)
input int      Inp保本激活层数     = 3;                               // 超过此层数启动保本+移动止盈
input bool     Inp启用移动止盈     = true;                            // 启用移动止盈
input double   Inp移动止盈启动     = 0.6;                             // 达目标60%后启动移动止盈
input double   Inp移动止盈回撤     = 0.3;                             // 移动止盈从峰值回撤此比例平仓
input bool     Inp启用部分平仓     = true;                            // 到目标时先部分平仓锁利
input double   Inp部分平仓比例     = 0.7;                             // 部分平仓比例(0.7=平70%留30%追)
input int      Inp距离             = 20;                              // 距离(点)
input double   Inp基础加仓距离     = 10.0;                            // 基础加仓距离(点)
input double   Inp马丁倍率         = 1.3;                             // 马丁倍率
input int      Inp固定止损         = 100000;                          // 固定止损(美元)
input double   Inp百分比止损       = 100;                             // 百分比止损(%)
input int      Inp开始时间         = 0;                               // 交易开始时间(小时)
input int      Inp停止时间         = 23;                              // 交易停止时间(小时)

//+------------------------------------------------------------------+
//| 趋势方向开仓开关                                                  |
//+------------------------------------------------------------------+
input string   InpSeparator3       = "===== 趋势方向开仓开关 =====";  // 趋势方向开仓
input bool     Inp启用趋势方向开仓 = false;                           // 启用趋势方向开仓

//+------------------------------------------------------------------+
//| 动态加仓设置                                                      |
//+------------------------------------------------------------------+
input string   InpSeparator2       = "===== 动态加仓设置 =====";      // 动态加仓设置
input bool     Inp启用动态加仓距离 = false;                           // 启用动态调整加仓距离
input double   Inp波动系数         = 0.2;                             // 波动敏感系数(0.1-1.0)
input int      InpATR周期          = 7;                               // ATR计算周期
input int      InpADX周期          = 12;                              // ADX计算周期
input double   InpADX阈值          = 25;                              // ADX阈值

//+------------------------------------------------------------------+
//| 趋势过滤设置                                                      |
//+------------------------------------------------------------------+
input string   InpSeparator6       = "===== 趋势过滤设置 =====";      // 趋势过滤设置
input bool     Inp启用趋势过滤     = false;                           // 启用趋势过滤
input int      Inp趋势均线周期     = 50;                              // 趋势均线周期
input int      InpBB周期           = 20;                              // 布林带周期
input double   InpBB偏差           = 2.0;                             // 布林带标准差倍数
input int      InpRSI周期          = 14;                              // RSI周期
input double   InpRSI超买          = 70;                              // RSI超买阈值
input double   InpRSI超卖          = 30;                              // RSI超卖阈值

//+------------------------------------------------------------------+
//| 递增倍数加仓设置                                                  |
//+------------------------------------------------------------------+
input string   InpSeparator5       = "===== 递增倍数加仓设置 =====";  // 递增倍数加仓
input bool     Inp启用递增马丁     = false;                           // 启用递增倍数加仓
input double   Inp初始倍数         = 1.0;                             // 初始倍数
input double   Inp递增步长         = 0.1;                             // 递增步长
input double   Inp最大倍数         = 1.5;                             // 最大倍数
input int      Inp基础手数单数     = 3;                               // 基础手数单数(前N单不加倍)

//+------------------------------------------------------------------+
//| 面板设置                                                          |
//+------------------------------------------------------------------+
input string   InpSeparator4       = "===== 面板设置 =====";          // 面板设置
input color    Inp多单线颜色       = clrBlue;                         // 多单线颜色
input color    Inp空单线颜色       = clrRed;                          // 空单线颜色
input bool     Inp显示信息面板     = true;                            // 显示信息面板
input color    Inp文本颜色         = clrWhite;                        // 文本颜色
input color    Inp数据颜色         = clrYellow;                       // 信息数据颜色
input color    Inp面板背景色       = clrBlack;                        // 面板背景颜色
input int      Inp字体大小         = 8;                               // 字体大小
input int      Inp魔术码           = 2025;                            // 魔术码

//+------------------------------------------------------------------+
//| 账户类型设置                                                      |
//+------------------------------------------------------------------+
input string   InpSeparator11      = "===== 账户类型设置 =====";      // 账户类型设置
input bool     Inp美分账户         = true;                            // 美分账户模式(余额/100,金额×100)

//+------------------------------------------------------------------+
//| 回测设置                                                          |
//+------------------------------------------------------------------+
input string   InpSeparator0       = "===== 回测设置 =====";          // 回测设置
input bool     Inp忽略时间过滤     = true;                            // 回测时忽略时间限制
input double   Inp每日收益限制     = 50;                              // 每日收益限制(美元)

//+------------------------------------------------------------------+
//| AI趋势学习设置                                                    |
//+------------------------------------------------------------------+
input string   InpSeparator7       = "===== AI趋势学习设置 =====";    // AI趋势学习设置
input bool     Inp启用AI趋势学习   = true;                            // 启用AI趋势学习
input int      Inp学习周期         = 1000;                            // 历史数据学习周期
input int      Inp预测周期         = 20;                              // 未来预测周期
input double   Inp学习率           = 0.01;                            // 学习率(0.001-0.1)
input int      Inp神经网络层数     = 3;                               // 神经网络隐藏层数
input int      Inp每层神经元       = 10;                              // 每层神经元数量

//+------------------------------------------------------------------+
//| 订单流分析设置                                                    |
//+------------------------------------------------------------------+
input string   InpSeparator8       = "===== 订单流分析设置 =====";    // 订单流分析设置
input bool     Inp启用订单流分析   = true;                            // 启用订单流分析
input double   Inp订单流权重       = 0.6;                             // 订单流分析权重(0.1-1.0)
input double   Inp技术指标权重     = 0.4;                             // 技术指标权重(0.1-1.0)
input double   Inp订单流阈值       = 0.0;                             // 订单流阈值(保留)

//+------------------------------------------------------------------+
//| MACD指标设置                                                      |
//+------------------------------------------------------------------+
input string   InpSeparator9       = "===== MACD指标设置 =====";      // MACD指标设置
input int      InpMACD快线         = 5;                               // MACD快线周期
input int      InpMACD慢线         = 10;                              // MACD慢线周期
input int      InpMACD信号线       = 5;                               // MACD信号线周期
input double   InpMACD权重         = 0.2;                             // MACD权重(0.1-1.0)

//+------------------------------------------------------------------+
//| 系统权重设置                                                      |
//+------------------------------------------------------------------+
input string   InpSeparator10      = "===== 系统权重设置 =====";      // 系统权重设置
input double   Inp趋势系统权重     = 0.4;                             // 趋势系统权重(0.1-1.0)
input double   InpAI系统权重       = 0.3;                             // AI系统权重(0.1-1.0)

//+------------------------------------------------------------------+
//| 数据结构：订单流数据                                              |
//+------------------------------------------------------------------+
struct S订单流数据
{
   double 买入力量;           // 买入力量
   double 卖出力量;           // 卖出力量
   string 分析原因;           // 分析原因
};

//+------------------------------------------------------------------+
//| 数据结构：动态权重                                                |
//+------------------------------------------------------------------+
struct S动态权重
{
   double 趋势权重;
   double 订单流权重;
   double AI权重;
};

//+------------------------------------------------------------------+
//| 数据结构：AI趋势学习器（神经网络）                                |
//+------------------------------------------------------------------+
struct SAI趋势学习器
{
   double 权重[];              // 权重矩阵
   double 偏置[];              // 偏置项
   double 动量[];              // 动量
   double 上次预测;            // 上次预测值
   bool   已初始化;            // 初始化标志

   //--- 初始化神经网络
   void 初始化()
   {
      if(已初始化) return;
      ArrayResize(权重, Inp神经网络层数 * Inp每层神经元);
      ArrayResize(偏置, Inp神经网络层数);
      ArrayResize(动量, Inp神经网络层数 * Inp每层神经元);

      // 随机初始化权重
      for(int i = 0; i < ArraySize(权重); i++)
         权重[i] = 0.1 * (MathRand() / 32767.0 - 0.5);
      for(int i = 0; i < Inp神经网络层数; i++)
         偏置[i] = 0.1 * (MathRand() / 32767.0 - 0.5);

      已初始化 = true;
   }

   //--- Sigmoid 激活函数
   double Sigmoid(double x)
   {
      return 1.0 / (1.0 + MathExp(-x));
   }

   //--- 预测趋势（前向传播）
   double 预测趋势(double &特征[])
   {
      if(!已初始化) return 0.5;

      double 层输出[];
      ArrayResize(层输出, Inp每层神经元);

      // 复制输入特征
      for(int i = 0; i < Inp每层神经元; i++)
         层输出[i] = 特征[i];

      // 前向传播
      for(int 层 = 0; 层 < Inp神经网络层数; 层++)
      {
         double 下一层输出[];
         ArrayResize(下一层输出, Inp每层神经元);

         for(int 神经元 = 0; 神经元 < Inp每层神经元; 神经元++)
         {
            double 求和 = 0;
            for(int i = 0; i < Inp每层神经元; i++)
               求和 += 权重[层 * Inp每层神经元 + i] * 层输出[i];
            求和 += 偏置[层];
            下一层输出[神经元] = Sigmoid(求和);
         }

         // 更新当前层输出
         for(int i = 0; i < Inp每层神经元; i++)
            层输出[i] = 下一层输出[i];
      }

      // 最终输出为最后一层的平均值
      double 输出 = 0;
      for(int i = 0; i < Inp每层神经元; i++)
         输出 += 层输出[i];
      输出 /= Inp每层神经元;

      上次预测 = 输出;
      return 输出;
   }

   //--- 训练网络（反向传播）
   void 训练(double &特征[], double 目标值)
   {
      if(!已初始化) return;

      double 预测值 = 预测趋势(特征);
      double 误差 = 目标值 - 预测值;

      // 反向传播
      for(int i = Inp神经网络层数 - 1; i >= 0; i--)
      {
         for(int j = 0; j < Inp每层神经元; j++)
         {
            int 索引 = i * Inp每层神经元 + j;
            double 增量 = 误差 * Inp学习率;
            权重[索引] += 增量 * 特征[j] + 0.9 * 动量[索引];
            动量[索引] = 增量 * 特征[j];
         }
         偏置[i] += 误差 * Inp学习率;
      }
   }
};

//+------------------------------------------------------------------+
//| 全局变量                                                          |
//+------------------------------------------------------------------+

//--- 交易对象
CTrade         g_交易;                   // 交易操作对象
CPositionInfo  g_仓位信息;               // 仓位信息对象
CSymbolInfo    g_品种信息;               // 品种信息对象

//--- 指标句柄
int g_h布林带   = INVALID_HANDLE;        // 布林带指标句柄
int g_hRSI      = INVALID_HANDLE;        // RSI指标句柄
int g_hADX      = INVALID_HANDLE;        // ADX指标句柄
int g_hATR      = INVALID_HANDLE;        // ATR指标句柄
int g_hMA趋势   = INVALID_HANDLE;       // 趋势均线句柄
int g_hMA快     = INVALID_HANDLE;        // 快速均线句柄
int g_hMA慢     = INVALID_HANDLE;        // 慢速均线句柄
int g_hMACD     = INVALID_HANDLE;        // MACD指标句柄

//--- 指标值
double g_布林上轨, g_布林中轨, g_布林下轨;
double g_RSI值, g_ADX值, g_ATR值;
double g_正向DI, g_负向DI;
double g_MA趋势, g_MA快, g_MA慢;
double g_MACD主线, g_信号线;
double g_fastMA, g_slowMA;             // 用于均线交叉判断

//--- 趋势与信号状态
string g_趋势状态   = "";
color  g_趋势颜色   = clrGray;
string g_信号状态   = "";
string g_市场状态   = "";
color  g_状态颜色   = clrGray;
string g_RSI状态    = "";
string g_布林带状态  = "";
string g_均线状态    = "";
string g_ADX状态     = "";
string g_MACD状态    = "";
string g_订单注释    = "源流智能过滤马丁";

//--- 交易变量
double g_基础手数   = 0;
double g_新手数     = 0;
double g_新利润率    = 0;
double g_买入价格线  = 0;
double g_卖出价格线  = 0;
int    g_点数乘数   = 1;

//--- 递增马丁变量
int    g_马丁加仓计数 = 0;
double g_当前倍数     = 1.0;

//--- 动态加仓变量
double g_当前加仓距离  = 0;
datetime g_上次加仓时间 = 0;

//--- 斐波那契变量
double g_斐波高点   = 0;
double g_斐波低点   = 0;
double g_斐波38     = 0;
double g_斐波50     = 0;
double g_斐波61     = 0;

//--- 最大浮亏追踪
double g_今日最大浮亏   = 0;
double g_昨日最大浮亏   = 0;
double g_本周最大浮亏   = 0;
double g_本月最大浮亏   = 0;

//--- 订单流数据
S订单流数据 g_订单流;

//--- AI学习器
SAI趋势学习器 g_AI学习器;

//--- 品种属性缓存
double g_最小手数, g_最大手数, g_手数步长, g_点值;
string g_品种名称;
int    g_小数位数;
double g_点;

//--- Tick计数器
int g_tick计数器 = 0;

//--- 每日利润限制检查
double g_当日利润 = 0;

//--- 移动止盈追踪
double g_移动止盈峰值 = 0;      // 本轮持仓达到的最高利润率
bool   g_移动止盈激活 = false;   // 移动止盈是否已激活

//--- 美分账户转换
const double CENT_FACTOR = 100.0;  // 美分转换因子

//+------------------------------------------------------------------+
//| 辅助函数：获取有效余额（美分模式下除100）                         |
//+------------------------------------------------------------------+
double 获取有效余额()
{
   double 余额 = AccountInfoDouble(ACCOUNT_BALANCE);
   if(Inp美分账户)
      return 余额 / CENT_FACTOR;
   return 余额;
}

//+------------------------------------------------------------------+
//| 辅助函数：获取有效金额（美分模式下除100）                         |
//+------------------------------------------------------------------+
double 获取有效金额(double 金额)
{
   if(Inp美分账户)
      return 金额 / CENT_FACTOR;
   return 金额;
}

//+------------------------------------------------------------------+
//| 辅助函数：转换为账户金额（美分模式下乘100）                       |
//+------------------------------------------------------------------+
double 转账户金额(double 美元金额)
{
   if(Inp美分账户)
      return 美元金额 * CENT_FACTOR;
   return 美元金额;
}

//+------------------------------------------------------------------+
//| 辅助函数：获取有效TickValue（美分模式下除100）                    |
//+------------------------------------------------------------------+
double 获取有效TickValue()
{
   double tv = g_品种信息.TickValue();
   if(Inp美分账户)
      return tv / CENT_FACTOR;
   return tv;
}

//+------------------------------------------------------------------+
//| 辅助函数：计算加权平均开仓价（指定方向，手数加权）               |
//+------------------------------------------------------------------+
double 计算加权均价(int 方向)
{
   double 总手数 = 0, 加权总价 = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            (int)g_仓位信息.PositionType() == 方向)
         {
            double vol = g_仓位信息.Volume();
            加权总价 += g_仓位信息.PriceOpen() * vol;
            总手数 += vol;
         }
      }
   }
   if(总手数 <= 0) return 0;
   return 加权总价 / 总手数;
}

//+------------------------------------------------------------------+
//| 辅助函数：部分平仓（按比例平掉指定方向的订单）                   |
//+------------------------------------------------------------------+
void 部分平仓(int 方向, double 比例)
{
   if(比例 <= 0 || 比例 > 1.0) return;

   // 先收集该方向所有持仓
   ulong 票据[];
   double 手数[];
   int 计数 = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            (int)g_仓位信息.PositionType() == 方向)
         {
            计数++;
         }
      }
   }

   if(计数 == 0) return;

   ArrayResize(票据, 计数);
   ArrayResize(手数, 计数);
   int idx = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            (int)g_仓位信息.PositionType() == 方向)
         {
            票据[idx] = g_仓位信息.Ticket();
            手数[idx] = g_仓位信息.Volume();
            idx++;
         }
      }
   }

   // 对亏损单优先平仓（减少浮亏），再平盈利单
   // 先按盈亏排序：亏损在前
   for(int i = 0; i < 计数 - 1; i++)
   {
      for(int j = i + 1; j < 计数; j++)
      {
         double pi = 0, pj = 0;
         if(PositionSelectByTicket(票据[i])) pi = PositionGetDouble(POSITION_PROFIT);
         if(PositionSelectByTicket(票据[j])) pj = PositionGetDouble(POSITION_PROFIT);
         if(pi > pj)  // 盈利大的排后面
         {
            ulong tmpT = 票据[i]; 票据[i] = 票据[j]; 票据[j] = tmpT;
            double tmpV = 手数[i]; 手数[i] = 手数[j]; 手数[j] = tmpV;
         }
      }
   }

   // 计算要平的总手数
   double 总手数 = 0;
   for(int i = 0; i < 计数; i++) 总手数 += 手数[i];
   double 目标平仓手数 = 总手数 * 比例;

   // 依序平仓
   double 已平手数 = 0;
   for(int i = 0; i < 计数 && 已平手数 < 目标平仓手数; i++)
   {
      if(PositionSelectByTicket(票据[i]))
      {
         带重试平仓(票据[i], 手数[i]);
         已平手数 += 手数[i];
      }
   }
}

//+------------------------------------------------------------------+
//| 辅助函数：专业三级动态止盈（ATR自适应 + 保本 + 移动止盈）      |
//| 返回：当前应使用的止盈阈值(g_新利润率单位)                       |
//| 同时更新 g_移动止盈峰值 和 g_移动止盈激活                        |
//+------------------------------------------------------------------+
double 获取专业止盈阈值()
{
   double 有效余额 = 获取有效余额();
   if(有效余额 <= 0) 有效余额 = 1.0;

   int 层数 = 获取当前持仓数();
   if(层数 <= 0) return 100.0;  // 无持仓，不会触发

   double ATR = 获取指标值(g_hATR, 0, 0);
   if(ATR <= 0) ATR = g_点 * g_点数乘数 * 5;  // 兜底

   // 判断持仓方向
   int 方向 = -1;
   if(获取持仓数(OP_BUY) > 0) 方向 = POSITION_TYPE_BUY;
   else if(获取持仓数(OP_SELL) > 0) 方向 = POSITION_TYPE_SELL;

   double 均价 = 计算加权均价(方向);
   double 当前价 = (方向 == POSITION_TYPE_BUY) ? g_品种信息.Bid() : g_品种信息.Ask();
   if(均价 <= 0) 均价 = 当前价;

   // 距保本还差多少点（价格距离，非利润率）
   double 距保本点数 = 0;
   if(方向 == POSITION_TYPE_BUY)
      距保本点数 = (均价 - 当前价) / g_点;  // 价格需涨多少点到均价(正值=亏损中)
   else
      距保本点数 = (当前价 - 均价) / g_点;

   double 目标利润率;

   if(层数 <= 2)
   {
      // === 轻仓快速止盈 ===
      // 目标：ATR×倍数 的利润，快速了结
      double 目标点数 = ATR * Inp轻仓止盈ATR / g_点;
      double 目标金额 = 目标点数 * g_点值 * g_基础手数;
      目标利润率 = 100.0 * MathMax(目标金额, 0.05) / 有效余额;
   }
   else if(层数 <= 4)
   {
      // === 中仓保本+微利 ===
      // 先确保保本，再加ATR缓冲
      double 保本金额 = MathMax(距保本点数, 0) * g_点值 * g_基础手数;
      double 缓冲金额 = (ATR * Inp中仓止盈ATR / g_点) * g_点值 * g_基础手数;
      目标利润率 = 100.0 * (保本金额 + 缓冲金额) / 有效余额;
      if(目标利润率 < 0.01) 目标利润率 = 0.01;  // 最小阈值
   }
   else
   {
      // === 深仓生存模式 ===
      // 保本优先，极小利润即可
      double 保本金额 = MathMax(距保本点数, 0) * g_点值 * g_基础手数;
      double 逃生金额 = (ATR * Inp深仓止盈ATR / g_点) * g_点值 * g_基础手数;
      目标利润率 = 100.0 * (保本金额 + 逃生金额) / 有效余额;
      if(目标利润率 < 0.005) 目标利润率 = 0.005;
   }

   // === 移动止盈逻辑 ===
   if(Inp启用移动止盈 && 层数 >= Inp保本激活层数)
   {
      if(!g_移动止盈激活 && g_新利润率 >= 目标利润率 * Inp移动止盈启动)
      {
         // 达到目标60%，激活移动止盈
         g_移动止盈激活 = true;
         g_移动止盈峰值 = g_新利润率;
      }

      if(g_移动止盈激活)
      {
         // 追踪最高利润率
         if(g_新利润率 > g_移动止盈峰值)
            g_移动止盈峰值 = g_新利润率;

         // 从峰值回撤超限 → 触发平仓
         double 回撤阈值 = g_移动止盈峰值 * (1.0 - Inp移动止盈回撤);
         if(g_新利润率 <= 回撤阈值 && g_移动止盈峰值 > 0)
         {
            return g_新利润率 + 0.0001;  // 返回极低值，立即触发
         }
      }
   }

   return 目标利润率;
}


//+------------------------------------------------------------------+
//| 专家初始化函数                                                    |
//+------------------------------------------------------------------+
int OnInit()
{
   //--- 初始化品种信息
   g_品种名称 = Symbol();
   g_品种信息.Name(g_品种名称);
   g_小数位数  = (int)g_品种信息.Digits();
   g_点        = g_品种信息.Point();
   g_最小手数  = g_品种信息.LotsMin();
   g_最大手数  = g_品种信息.LotsMax();
   g_手数步长  = g_品种信息.LotsStep();
   g_点值      = g_品种信息.TickValue();

   //--- 5位/3位小数调整
   g_点数乘数 = 1;
   if(g_小数位数 == 5 || g_小数位数 == 3)
      g_点数乘数 = 10;

   //--- 设置图表外观
   ChartSetInteger(0, CHART_MODE, CHART_CANDLES);
   ChartSetInteger(0, CHART_AUTOSCROLL, true);
   ChartSetInteger(0, CHART_SHIFT, true);
   ChartSetInteger(0, CHART_COLOR_BACKGROUND, clrBlack);
   ChartSetInteger(0, CHART_COLOR_FOREGROUND, clrWhite);
   ChartSetInteger(0, CHART_COLOR_GRID, clrNONE);
   ChartSetInteger(0, CHART_COLOR_CHART_UP, clrOrange);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN, clrMaroon);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, clrOrange);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, clrMaroon);
   ChartSetInteger(0, CHART_COLOR_CHART_LINE, clrNONE);
   ChartSetInteger(0, CHART_SHOW_VOLUMES, CHART_VOLUME_HIDE);
   ChartSetInteger(0, CHART_COLOR_ASK, clrRed);
   ChartSetInteger(0, CHART_COLOR_STOP_LEVEL, clrRed);
   ChartRedraw();

   //--- 初始化指标句柄
   g_h布林带 = iBands(g_品种名称, PERIOD_CURRENT, InpBB周期, 0, InpBB偏差, PRICE_CLOSE);
   g_hRSI    = iRSI(g_品种名称, PERIOD_CURRENT, InpRSI周期, PRICE_CLOSE);
   g_hADX    = iADX(g_品种名称, PERIOD_CURRENT, InpADX周期);
   g_hATR    = iATR(g_品种名称, PERIOD_CURRENT, InpATR周期);
   g_hMA趋势 = iMA(g_品种名称, PERIOD_CURRENT, Inp趋势均线周期, 0, MODE_SMA, PRICE_CLOSE);
   g_hMA快   = iMA(g_品种名称, PERIOD_CURRENT, 5, 0, MODE_SMA, PRICE_CLOSE);
   g_hMA慢   = iMA(g_品种名称, PERIOD_CURRENT, 20, 0, MODE_SMA, PRICE_CLOSE);
   g_hMACD   = iMACD(g_品种名称, PERIOD_CURRENT, InpMACD快线, InpMACD慢线, InpMACD信号线, PRICE_CLOSE);

   //--- 检查指标句柄
   if(g_h布林带 == INVALID_HANDLE || g_hRSI == INVALID_HANDLE ||
      g_hADX == INVALID_HANDLE    || g_hATR == INVALID_HANDLE ||
      g_hMA趋势 == INVALID_HANDLE || g_hMA快 == INVALID_HANDLE ||
      g_hMA慢 == INVALID_HANDLE   || g_hMACD == INVALID_HANDLE)
   {
      Print("指标初始化失败！");
      return(INIT_FAILED);
   }

   //--- 初始化价格线
   g_品种信息.RefreshRates();
   double ask = g_品种信息.Ask();
   double bid = g_品种信息.Bid();
   水平线创建("线_买入", ask + Inp距离 * g_点数乘数 * g_点, Inp多单线颜色);
   水平线创建("线_卖出", bid - Inp距离 * g_点数乘数 * g_点, Inp空单线颜色);

   //--- 初始化斐波那契
   计算斐波那契水平();
   绘制斐波那契水平线();

   //--- 初始化AI学习器
   if(Inp启用AI趋势学习)
   {
      Print("初始化AI趋势学习系统...");
      g_AI学习器.初始化();
      历史数据训练();
   }

   //--- 初始化交易对象
   g_交易.SetExpertMagicNumber(Inp魔术码);
   g_交易.SetDeviationInPoints(10);
   g_交易.SetTypeFilling(ORDER_FILLING_IOC);

   //--- 创建GUI面板
   if(Inp显示信息面板)
      创建GUI面板();

   Print("源流智能过滤马丁 EA 初始化成功！");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| 专家逆初始化函数                                                  |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   //--- 删除斐波那契线
   ObjectDelete(0, "斐波高点");
   ObjectDelete(0, "斐波低点");
   ObjectDelete(0, "斐波38");
   ObjectDelete(0, "斐波50");
   ObjectDelete(0, "斐波61");

   //--- 删除水平线
   ObjectDelete(0, "线_买入");
   ObjectDelete(0, "线_卖出");

   //--- 删除GUI面板
   删除GUI面板();

   //--- 释放指标句柄
   if(g_h布林带 != INVALID_HANDLE) IndicatorRelease(g_h布林带);
   if(g_hRSI    != INVALID_HANDLE) IndicatorRelease(g_hRSI);
   if(g_hADX    != INVALID_HANDLE) IndicatorRelease(g_hADX);
   if(g_hATR    != INVALID_HANDLE) IndicatorRelease(g_hATR);
   if(g_hMA趋势 != INVALID_HANDLE) IndicatorRelease(g_hMA趋势);
   if(g_hMA快   != INVALID_HANDLE) IndicatorRelease(g_hMA快);
   if(g_hMA慢   != INVALID_HANDLE) IndicatorRelease(g_hMA慢);
   if(g_hMACD   != INVALID_HANDLE) IndicatorRelease(g_hMACD);

   ChartRedraw();
}

//+------------------------------------------------------------------+
//| 图表事件处理函数                                                  |
//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam,
                  const double &dparam, const string &sparam)
{
   //--- 处理按钮点击事件
   if(id == CHARTEVENT_OBJECT_CLICK)
   {
      if(sparam == "按钮_买入")
      {
         // 点击买入按钮
         if(获取当前持仓数() == 0)
         {
            double 手数 = 计算基础手数();
            开多单(手数, "手动买入");
         }
         ObjectSetInteger(0, "按钮_买入", OBJPROP_STATE, false);
         ChartRedraw();
      }
      else if(sparam == "按钮_卖出")
      {
         // 点击卖出按钮
         if(获取当前持仓数() == 0)
         {
            double 手数 = 计算基础手数();
            开空单(手数, "手动卖出");
         }
         ObjectSetInteger(0, "按钮_卖出", OBJPROP_STATE, false);
         ChartRedraw();
      }
   }
}

//+------------------------------------------------------------------+
//| 专家报价函数（主循环）                                            |
//+------------------------------------------------------------------+
void OnTick()
{
   //--- 更新品种信息
   g_品种信息.RefreshRates();

   //--- 检查每日收益限制
   double 有效收益限制 = 转账户金额(Inp每日收益限制);
   double 每日利润 = 计算当日利润();
   if(每日利润 >= 有效收益限制)
   {
      Print("已达到每日收益限制，暂停交易");
      return;
   }

   //--- 时间过滤（与MQ4逻辑一致）
   if(!Inp忽略时间过滤)
   {
      MqlDateTime 时间结构;
      TimeCurrent(时间结构);
      int 当前小时 = 时间结构.hour;
      if(当前小时 < Inp开始时间 || 当前小时 > Inp停止时间)
         return;  // 不在交易时间内，跳过
   }

   //--- 更新最大浮亏
   double 当前浮亏 = -计算浮动盈亏();
   if(当前浮亏 > g_今日最大浮亏)   g_今日最大浮亏 = 当前浮亏;
   if(当前浮亏 > g_昨日最大浮亏)   g_昨日最大浮亏 = 当前浮亏;
   if(当前浮亏 > g_本周最大浮亏)   g_本周最大浮亏 = 当前浮亏;
   if(当前浮亏 > g_本月最大浮亏)   g_本月最大浮亏 = 当前浮亏;

   //--- 获取当前价格
   double ask = g_品种信息.Ask();
   double bid = g_品种信息.Bid();

   //--- 计算基础手数
   g_基础手数 = 计算基础手数();

   //--- 获取价格线位置
   g_买入价格线 = 水平线获取价格("线_买入");
   g_卖出价格线 = 水平线获取价格("线_卖出");

   //--- 价格线跟随逻辑
   if(ask + Inp距离 * g_点数乘数 * g_点 < g_买入价格线)
      水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
   if(bid - Inp距离 * g_点数乘数 * g_点 > g_卖出价格线)
      水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
   if(ask < g_卖出价格线 && bid - Inp距离 * g_点数乘数 * g_点 > g_买入价格线)
      水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
   if(bid > g_买入价格线 && ask + Inp距离 * g_点数乘数 * g_点 < g_卖出价格线)
      水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);

   //--- 更新指标状态
   更新指标状态();

   //--- 计算动态加仓距离
   g_当前加仓距离 = 获取动态距离();

   //--- 第一组开仓逻辑（趋势过滤前）
   int 当前持仓数 = 获取当前持仓数();

   //--- 开多单逻辑（第一组）
   if(!检查日亏损() &&
      获取开盘价(g_品种名称, PERIOD_CURRENT, 0) < 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
      bid >= g_买入价格线 &&
      获取最后持仓类型() != POSITION_TYPE_BUY &&
      当前持仓数 == 0)
   {
      // 如果启用了趋势方向开仓
      if(Inp启用趋势方向开仓 && 按趋势方向开仓())
         return;

      // 原有开多逻辑
      if(开多单(g_基础手数, g_订单注释))
      {
         水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
         重置马丁计数();
      }
   }

   //--- 开空单逻辑（第一组）
   if(!检查日亏损() &&
      获取开盘价(g_品种名称, PERIOD_CURRENT, 0) > 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
      ask <= g_卖出价格线 &&
      获取最后持仓类型() != POSITION_TYPE_SELL &&
      当前持仓数 == 0)
   {
      // 如果启用了趋势方向开仓
      if(Inp启用趋势方向开仓 && 按趋势方向开仓())
         return;

      // 原有开空逻辑
      if(开空单(g_基础手数, g_订单注释))
      {
         水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
         重置马丁计数();
      }
   }

   //--- 第二组开仓逻辑（带信号过滤）
   //--- 开多单逻辑（第二组）
   if(!检查日亏损() &&
      获取开盘价(g_品种名称, PERIOD_CURRENT, 0) < 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
      bid >= g_买入价格线 &&
      获取最后持仓类型() != POSITION_TYPE_BUY &&
      当前持仓数 == 0 &&
      g_信号状态 != "超买预警" &&
      是否应该开仓(ORDER_TYPE_BUY))
   {
      // 根据订单流分析决定开仓方向
      if(Inp启用订单流分析)
      {
         if(g_订单流.买入力量 > g_订单流.卖出力量)
         {
            if(开多单(g_基础手数, g_订单注释))
            {
               水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
               重置马丁计数();
            }
         }
         else
         {
            if(开空单(g_基础手数, g_订单注释))
            {
               水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
               重置马丁计数();
            }
         }
      }
      else
      {
         if(开多单(g_基础手数, g_订单注释))
         {
            水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
            重置马丁计数();
         }
      }
   }

   //--- 开空单逻辑（第二组）
   if(!检查日亏损() &&
      获取开盘价(g_品种名称, PERIOD_CURRENT, 0) > 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
      ask <= g_卖出价格线 &&
      获取最后持仓类型() != POSITION_TYPE_SELL &&
      当前持仓数 == 0 &&
      g_信号状态 != "超卖预警" &&
      是否应该开仓(ORDER_TYPE_SELL))
   {
      // 根据订单流分析决定开仓方向
      if(Inp启用订单流分析)
      {
         if(g_订单流.卖出力量 > g_订单流.买入力量)
         {
            if(开空单(g_基础手数, g_订单注释))
            {
               水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
               重置马丁计数();
            }
         }
         else
         {
            if(开多单(g_基础手数, g_订单注释))
            {
               水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
               重置马丁计数();
            }
         }
      }
      else
      {
         if(开空单(g_基础手数, g_订单注释))
         {
            水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
            重置马丁计数();
         }
      }
   }

   //--- 加仓逻辑
   当前持仓数 = 获取当前持仓数();
   if(当前持仓数 > 0)
   {
      g_马丁加仓计数 = 当前持仓数;

      if(Inp启用递增马丁)
      {
         // 递增倍率加仓策略
         g_新手数 = 计算递增手数(g_基础手数, g_马丁加仓计数);

         // 多头加仓
         if(获取开盘价(g_品种名称, PERIOD_CURRENT, 0) < 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
            bid >= g_买入价格线 &&
            获取持仓数(OP_BUY) > 0 &&
            ask + g_当前加仓距离 * g_点数乘数 * g_点 < 获取买入均价() &&
            趋势是否有效(1))
         {
            if(允许加仓())
            {
               if(开多单(g_新手数, g_订单注释))
                  水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
            }
         }

         // 空头加仓
         if(获取开盘价(g_品种名称, PERIOD_CURRENT, 0) > 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
            ask <= g_卖出价格线 &&
            获取持仓数(OP_SELL) > 0 &&
            bid - g_当前加仓距离 * g_点数乘数 * g_点 > 获取卖出均价() &&
            趋势是否有效(-1))
         {
            if(允许加仓())
            {
               if(开空单(g_新手数, g_订单注释))
                  水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
            }
         }
      }
      else
      {
         // 原始马丁加仓策略
         g_新手数 = 标准化手数(g_基础手数 * MathPow(Inp马丁倍率, 获取当前持仓数()));

         // 卖单加仓
         if(获取开盘价(g_品种名称, PERIOD_CURRENT, 0) > 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
            ask <= g_卖出价格线 &&
            获取持仓数(OP_SELL) > 0 &&
            bid - g_当前加仓距离 * g_点数乘数 * g_点 > 获取卖出均价())
         {
            if(允许加仓())
            {
               if(开空单(g_新手数, g_订单注释))
                  水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
            }
         }

         // 买单加仓
         if(获取开盘价(g_品种名称, PERIOD_CURRENT, 0) < 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) &&
            bid >= g_买入价格线 &&
            获取持仓数(OP_BUY) > 0 &&
            ask + g_当前加仓距离 * g_点数乘数 * g_点 < 获取买入均价())
         {
            if(允许加仓())
            {
               if(开多单(g_新手数, g_订单注释))
                  水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
            }
         }
      }
   }

   //--- 专业三级动态止盈（ATR自适应 + 保本 + 移动止盈 + 部分平仓）
   g_新利润率 = 计算浮动盈亏() / (AccountInfoDouble(ACCOUNT_BALANCE) / 100);
   double 止盈阈值 = 获取专业止盈阈值();

   // 多头止盈
   if(获取持仓数(OP_BUY) > 0 && ask <= g_卖出价格线 && g_新利润率 >= 止盈阈值)
   {
      if(Inp启用部分平仓 && 获取当前持仓数() >= Inp保本激活层数)
      {
         // 深仓：先部分平仓锁利，剩余追踪
         部分平仓(POSITION_TYPE_BUY, Inp部分平仓比例);
      }
      else
      {
         // 轻仓：全平
         平掉亏损订单();
         平掉盈利订单();
      }
      重置马丁计数();
   }

   // 空头止盈
   if(获取持仓数(OP_SELL) > 0 && bid >= g_买入价格线 && g_新利润率 >= 止盈阈值)
   {
      if(Inp启用部分平仓 && 获取当前持仓数() >= Inp保本激活层数)
      {
         部分平仓(POSITION_TYPE_SELL, Inp部分平仓比例);
      }
      else
      {
         平掉亏损订单();
         平掉盈利订单();
      }
      重置马丁计数();
   }

   // 移动止盈触发：已达峰值后回撤超限(由获取专业止盈阈值内部标记)
   if(g_移动止盈激活 && g_新利润率 <= g_移动止盈峰值 * (1.0 - Inp移动止盈回撤) && g_移动止盈峰值 > 0)
   {
      if(Inp启用部分平仓 && 获取当前持仓数() > 0)
      {
         // 剩余仓位全平
         平掉亏损订单();
         平掉盈利订单();
      }
      重置马丁计数();
   }

   //--- 全局止损检查
   全局止损平仓();

   //--- 更新GUI面板
   if(Inp显示信息面板)
   {
      if(++g_tick计数器 % 10 == 0)
         更新GUI面板();
   }

   //--- 日亏损检查
   if(检查日亏损())
      Comment("已达到每日亏损限制");
}

//+------------------------------------------------------------------+
//| 获取动态加仓距离                                                  |
//+------------------------------------------------------------------+
double 获取动态距离()
{
   double ADX值 = 获取ADX值();

   if(Inp启用动态加仓距离 && ADX值 < InpADX阈值)
      return Inp基础加仓距离 * 2;  // 趋势弱时返回2倍保守距离

   if(!Inp启用动态加仓距离)
      return Inp基础加仓距离;

   double ATR值 = 获取指标值(g_hATR, 0, 0);

   // 动态调整波动敏感系数
   double 动态系数 = Inp波动系数 * (1 + MathMin(ADX值, 50) / 100);

   double 动态距离 = Inp基础加仓距离 + (ATR值 / g_点 * 动态系数);
   动态距离 = MathMax(动态距离, Inp基础加仓距离 * 0.5);

   return NormalizeDouble(动态距离, 2);
}

//+------------------------------------------------------------------+
//| 允许加仓（频率限制，60秒间隔）                                    |
//+------------------------------------------------------------------+
bool 允许加仓()
{
   if(TimeCurrent() - g_上次加仓时间 < 60)
      return false;
   g_上次加仓时间 = TimeCurrent();
   return true;
}

//+------------------------------------------------------------------+
//| 计算基础手数                                                      |
//+------------------------------------------------------------------+
double 计算基础手数()
{
   double 有效余额 = 获取有效余额();
   double 有效点值 = 获取有效TickValue();
   double 手数 = NormalizeDouble(有效余额 / 100 * Inp风险比 / (有效点值 * 100 * g_点数乘数), 2);

   if(手数 < g_最小手数)
      手数 = g_最小手数;
   if(手数 > g_最大手数)
      手数 = g_最大手数;

   return 手数;
}

//+------------------------------------------------------------------+
//| 计算递增马丁手数                                                  |
//+------------------------------------------------------------------+
double 计算递增手数(double 基础手数, int 订单计数)
{
   if(!Inp启用递增马丁)
      return 标准化手数(基础手数 * MathPow(Inp马丁倍率, 订单计数));

   // 前N单使用基础手数
   if(订单计数 <= Inp基础手数单数)
      return 标准化手数(基础手数);

   // 计算当前组别和倍数
   int 组别 = (订单计数 - Inp基础手数单数 - 1) / 3;
   g_当前倍数 = Inp初始倍数 + (组别 * Inp递增步长);

   // 限制最大倍数
   if(g_当前倍数 > Inp最大倍数)
      g_当前倍数 = Inp最大倍数;

   // 计算手数
   double 计算手数 = 标准化手数(基础手数 * MathPow(g_当前倍数, 组别 + 1));
   if(计算手数 < g_最小手数)
      计算手数 = g_最小手数;

   return 计算手数;
}

//+------------------------------------------------------------------+
//| 标准化手数                                                        |
//+------------------------------------------------------------------+
double 标准化手数(double 手数)
{
   double 步长 = g_手数步长;
   手数 = MathFloor(手数 / 步长) * 步长;
   手数 = MathMax(手数, g_最小手数);
   手数 = MathMin(手数, g_最大手数);
   return NormalizeDouble(手数, 2);
}

//+------------------------------------------------------------------+
//| 重置马丁计数                                                      |
//+------------------------------------------------------------------+
void 重置马丁计数()
{
   g_马丁加仓计数 = 0;
   g_当前倍数 = Inp初始倍数;
   g_移动止盈峰值 = 0;
   g_移动止盈激活 = false;
}

//+------------------------------------------------------------------+
//| 开多单                                                            |
//+------------------------------------------------------------------+
bool 开多单(double 手数, string 注释)
{
   double ask = g_品种信息.Ask();
   if(g_交易.Buy(手数, g_品种名称, ask, 0, 0, 注释))
   {
      Print("开多单成功 - 手数: ", DoubleToString(手数, 2));
      return true;
   }
   else
   {
      Print("开多单失败 - 错误: ", GetLastError());
      return false;
   }
}

//+------------------------------------------------------------------+
//| 开空单                                                            |
//+------------------------------------------------------------------+
bool 开空单(double 手数, string 注释)
{
   double bid = g_品种信息.Bid();
   if(g_交易.Sell(手数, g_品种名称, bid, 0, 0, 注释))
   {
      Print("开空单成功 - 手数: ", DoubleToString(手数, 2));
      return true;
   }
   else
   {
      Print("开空单失败 - 错误: ", GetLastError());
      return false;
   }
}

//+------------------------------------------------------------------+
//| 获取当前持仓数                                                    |
//+------------------------------------------------------------------+
int 获取当前持仓数(int 类型 = -1)
{
   int 计数 = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码)
         {
            if(类型 == -1)
               计数++;
            else if(类型 == POSITION_TYPE_BUY && g_仓位信息.PositionType() == POSITION_TYPE_BUY)
               计数++;
            else if(类型 == POSITION_TYPE_SELL && g_仓位信息.PositionType() == POSITION_TYPE_SELL)
               计数++;
         }
      }
   }
   return 计数;
}

//+------------------------------------------------------------------+
//| 获取持仓数（兼容OP_BUY/OP_SELL）                                  |
//+------------------------------------------------------------------+
int 获取持仓数(int 类型)
{
   if(类型 == OP_BUY)
      return 获取当前持仓数(POSITION_TYPE_BUY);
   else if(类型 == OP_SELL)
      return 获取当前持仓数(POSITION_TYPE_SELL);
   return 获取当前持仓数(-1);
}

//+------------------------------------------------------------------+
//| 获取最后平仓订单类型（查历史订单，与MQ4逻辑一致）                 |
//| 返回: POSITION_TYPE_BUY / POSITION_TYPE_SELL / -1(无历史)        |
//+------------------------------------------------------------------+
int 获取最后持仓类型()
{
   // 先查历史已平仓订单
   HistorySelect(0, TimeCurrent());
   int 总交易 = HistoryDealsTotal();
   datetime 最新时间 = 0;
   int 最后类型 = -1;

   for(int i = 总交易 - 1; i >= 0; i--)
   {
      ulong 票据 = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(票据, DEAL_MAGIC) == Inp魔术码 &&
         HistoryDealGetString(票据, DEAL_SYMBOL) == g_品种名称)
      {
         ENUM_DEAL_ENTRY 入场类型 = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(票据, DEAL_ENTRY);
         if(入场类型 == DEAL_ENTRY_OUT || 入场类型 == DEAL_ENTRY_OUT_BY)
         {
            datetime 平仓时间 = (datetime)HistoryDealGetInteger(票据, DEAL_TIME);
            if(平仓时间 > 最新时间)
            {
               最新时间 = 平仓时间;
               ENUM_DEAL_TYPE 成交类型 = (ENUM_DEAL_TYPE)HistoryDealGetInteger(票据, DEAL_TYPE);
               // 平仓SELL单 = 原来是BUY，平仓BUY单 = 原来是SELL
               if(成交类型 == DEAL_TYPE_BUY)
                  最后类型 = POSITION_TYPE_SELL;  // 平掉空单 → 原来是空
               else if(成交类型 == DEAL_TYPE_SELL)
                  最后类型 = POSITION_TYPE_BUY;   // 平掉多单 → 原来是多
            }
         }
      }
   }

   // 如果没有历史记录，查当前持仓
   if(最后类型 == -1)
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(g_仓位信息.SelectByIndex(i))
         {
            if(g_仓位信息.Symbol() == g_品种名称 &&
               g_仓位信息.Magic() == Inp魔术码)
            {
               return (int)g_仓位信息.PositionType();
            }
         }
      }
   }

   return 最后类型;
}

//+------------------------------------------------------------------+
//| 获取最后买入订单的开仓价格（与MQ4逻辑一致）                       |
//+------------------------------------------------------------------+
double 获取买入均价()
{
   datetime 最新时间 = 0;
   double 开仓价 = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            g_仓位信息.PositionType() == POSITION_TYPE_BUY)
         {
            if(g_仓位信息.Time() > 最新时间)
            {
               最新时间 = g_仓位信息.Time();
               开仓价 = g_仓位信息.PriceOpen();
            }
         }
      }
   }
   return 开仓价;
}

//+------------------------------------------------------------------+
//| 获取最后卖出订单的开仓价格（与MQ4逻辑一致）                       |
//+------------------------------------------------------------------+
double 获取卖出均价()
{
   datetime 最新时间 = 0;
   double 开仓价 = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            g_仓位信息.PositionType() == POSITION_TYPE_SELL)
         {
            if(g_仓位信息.Time() > 最新时间)
            {
               最新时间 = g_仓位信息.Time();
               开仓价 = g_仓位信息.PriceOpen();
            }
         }
      }
   }
   return 开仓价;
}

//+------------------------------------------------------------------+
//| 计算浮动盈亏                                                      |
//+------------------------------------------------------------------+
double 计算浮动盈亏()
{
   double 盈亏 = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码)
         {
            盈亏 += g_仓位信息.Profit() + g_仓位信息.Swap() + g_仓位信息.Commission();
         }
      }
   }
   return 盈亏;
}

//+------------------------------------------------------------------+
//| 计算当日已平仓利润（与MQ4逻辑一致，不含浮动盈亏）                |
//+------------------------------------------------------------------+
double 计算当日利润()
{
   double 利润 = 0;
   datetime 今日开始 = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));

   // 今日已平仓的盈亏
   HistorySelect(今日开始, TimeCurrent());
   int 总交易 = HistoryDealsTotal();
   for(int i = 0; i < 总交易; i++)
   {
      ulong 票据 = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(票据, DEAL_MAGIC) == Inp魔术码 &&
         HistoryDealGetString(票据, DEAL_SYMBOL) == g_品种名称)
      {
         利润 += HistoryDealGetDouble(票据, DEAL_PROFIT) +
                 HistoryDealGetDouble(票据, DEAL_SWAP) +
                 HistoryDealGetDouble(票据, DEAL_COMMISSION);
      }
   }
   return 利润;
}

//+------------------------------------------------------------------+
//| 带重试机制的平仓函数（与MQ4的15次重试逻辑一致）                   |
//+------------------------------------------------------------------+
bool 带重试平仓(ulong 票据, double 手数)
{
   int 最大重试 = 15;
   for(int 尝试 = 0; 尝试 < 最大重试; 尝试++)
   {
      if(g_交易.PositionClose(票据))
         return true;

      int 错误码 = GetLastError();
      Print("平仓失败 - 票据: ", 票据, " 错误: ", 错误码, " 尝试: ", 尝试 + 1);

      // 根据错误码调整等待时间
      if(错误码 == ERR_TRADE_CONTEXT_BUSY || 错误码 == 146)
         Sleep(500);   // 交易上下文繁忙
      else if(错误码 == ERR_BROKER_BUSY || 错误码 == 137)
         Sleep(1000);  // 经纪商繁忙
      else if(错误码 == ERR_OFF_QUOTES || 错误码 == 136)
         Sleep(2000);  // 报价失效
      else if(错误码 == ERR_REQUOTE || 错误码 == 138)
         Sleep(500);   // 重新报价
      else
         Sleep(1000);  // 其他错误

      g_品种信息.RefreshRates();  // 刷新价格
   }

   Print("平仓最终失败 - 票据: ", 票据);
   return false;
}

//+------------------------------------------------------------------+
//| 平掉亏损订单（带重试机制，与MQ4逻辑一致）                        |
//+------------------------------------------------------------------+
void 平掉亏损订单()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            g_仓位信息.Profit() < 0)
         {
            带重试平仓(g_仓位信息.Ticket(), g_仓位信息.Volume());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 平掉盈利订单（带重试机制，与MQ4逻辑一致）                        |
//+------------------------------------------------------------------+
void 平掉盈利订单()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码 &&
            g_仓位信息.Profit() >= 0)
         {
            带重试平仓(g_仓位信息.Ticket(), g_仓位信息.Volume());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 全局止损平仓                                                      |
//+------------------------------------------------------------------+
void 全局止损平仓()
{
   double 净值 = AccountInfoDouble(ACCOUNT_EQUITY);
   double 余额 = AccountInfoDouble(ACCOUNT_BALANCE);
   double 浮动 = NormalizeDouble(净值 - 余额, 2);
   double 有效固定止损 = 转账户金额(Inp固定止损);
   double 百分比限额 = NormalizeDouble((Inp百分比止损 / 100) * 余额, 2);

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 &&
            g_仓位信息.Magic() == Inp魔术码)
         {
            if(浮动 <= -有效固定止损 || 浮动 <= -百分比限额)
            {
               g_交易.PositionClose(g_仓位信息.Ticket());
               Print("达到止损限额，平仓");
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 检查日亏损（检查当日已平仓累计亏损，与MQ4逻辑一致）               |
//+------------------------------------------------------------------+
bool 检查日亏损()
{
   bool 已亏损 = false;
   datetime 今日开始 = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));
   double 当日已平仓亏损 = 0;
   double 当日已平仓利润 = 0;

   HistorySelect(今日开始, TimeCurrent());
   int 总交易 = HistoryDealsTotal();

   for(int i = 0; i < 总交易; i++)
   {
      ulong 票据 = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(票据, DEAL_MAGIC) == Inp魔术码 &&
         HistoryDealGetString(票据, DEAL_SYMBOL) == g_品种名称)
      {
         double 盈亏 = HistoryDealGetDouble(票据, DEAL_PROFIT) +
                       HistoryDealGetDouble(票据, DEAL_SWAP) +
                       HistoryDealGetDouble(票据, DEAL_COMMISSION);
         if(盈亏 < 0)
            当日已平仓亏损 += 盈亏;
         else
            当日已平仓利润 += 盈亏;
      }
   }

   // 检查累计已平仓亏损是否超过限额
   double 有效固定止损限额 = 转账户金额(Inp固定止损);
   double 百分比止损限额 = (Inp百分比止损 / 100) * AccountInfoDouble(ACCOUNT_BALANCE);

   if(当日已平仓亏损 <= -有效固定止损限额 || 当日已平仓亏损 <= -百分比止损限额)
      已亏损 = true;

   return 已亏损;
}

//+------------------------------------------------------------------+
//| 按趋势方向开仓                                                   |
//+------------------------------------------------------------------+
bool 按趋势方向开仓()
{
   if(!Inp启用趋势方向开仓)
      return false;

   更新指标状态();
   计算斐波那契水平();

   double 趋势得分 = 0;
   double ask = g_品种信息.Ask();
   double bid = g_品种信息.Bid();

   // ADX趋势强度 (权重 0.35)
   if(g_ADX值 >= InpADX阈值)
      趋势得分 += 0.35 * (g_ADX值 > 30 ? 1.5 : 1);
   else
      趋势得分 += 0.35 * -1;

   // RSI超买超卖状态 (权重 0.25)
   if(g_RSI值 >= InpRSI超买)
      趋势得分 += 0.25 * -1.5;
   else if(g_RSI值 <= InpRSI超卖)
      趋势得分 += 0.25 * 1.5;

   // 布林带状态 (权重 0.25)
   if(ask >= g_布林上轨)
      趋势得分 += 0.25 * -1.2;
   else if(bid <= g_布林下轨)
      趋势得分 += 0.25 * 1.2;

   // 均线交叉状态 (权重 0.15)
   if(g_fastMA > g_slowMA)
      趋势得分 += 0.15 * 1;
   else if(g_fastMA < g_slowMA)
      趋势得分 += 0.15 * -1;

   // 斐波那契回调判断
   double 当前价格 = (ask + bid) / 2;
   string 斐波状态 = "";

   if(当前价格 > g_斐波61 && 当前价格 < g_斐波38)
   {
      if(当前价格 > g_斐波50 && g_ADX值 >= InpADX阈值)
      {
         趋势得分 += 0.2 * 1.5;
         斐波状态 = "斐波那契:强势上涨";
      }
      else
      {
         趋势得分 += 0.2 * 0.8;
         斐波状态 = "斐波那契:温和上涨";
      }
   }
   else if(当前价格 < g_斐波38 && 当前价格 > g_斐波61)
   {
      if(当前价格 < g_斐波50 && g_ADX值 >= InpADX阈值)
      {
         趋势得分 += 0.2 * -1.5;
         斐波状态 = "斐波那契:强势下跌";
      }
      else
      {
         趋势得分 += 0.2 * -0.8;
         斐波状态 = "斐波那契:温和下跌";
      }
   }
   else
   {
      斐波状态 = "斐波那契:盘整";
   }

   // 根据综合得分开仓
   if(趋势得分 > 0.5)
   {
      if(开多单(g_基础手数, g_订单注释))
      {
         水平线移动("线_卖出", bid - Inp距离 * g_点数乘数 * g_点);
         重置马丁计数();
         Print("开多仓 - 趋势得分: ", DoubleToString(趋势得分, 2), " | ", 斐波状态);
         return true;
      }
   }
   else if(趋势得分 < -0.5)
   {
      if(开空单(g_基础手数, g_订单注释))
      {
         水平线移动("线_买入", ask + Inp距离 * g_点数乘数 * g_点);
         重置马丁计数();
         Print("开空仓 - 趋势得分: ", DoubleToString(趋势得分, 2), " | ", 斐波状态);
         return true;
      }
   }

   return false;
}

//+------------------------------------------------------------------+
//| 趋势有效性判断（订单流分析）                                      |
//+------------------------------------------------------------------+
bool 趋势是否有效(int 方向)
{
   if(!Inp启用订单流分析)
      return true;

   double 买入力量 = 0, 卖出力量 = 0;
   string 原因 = "";

   //--- 1. Delta分析（5根K线，时间权重递减）
   double 买入成交量 = 0, 卖出成交量 = 0;
   double 总Delta量 = 0;

   for(int i = 0; i < 5; i++)
   {
      double 当前成交量 = (double)获取成交量(g_品种名称, PERIOD_CURRENT, i);
      double 当前波幅 = 获取最高价(g_品种名称, PERIOD_CURRENT, i) - 获取最低价(g_品种名称, PERIOD_CURRENT, i);
      if(当前波幅 <= 0) 当前波幅 = g_点;

      double 时间权重 = 1.0 - (i * 0.15);

      if(获取收盘价(g_品种名称, PERIOD_CURRENT, i) > 获取开盘价(g_品种名称, PERIOD_CURRENT, i))
      {
         买入成交量 += 当前成交量 * (获取收盘价(g_品种名称, PERIOD_CURRENT, i) - 获取开盘价(g_品种名称, PERIOD_CURRENT, i)) / 当前波幅 * 时间权重;
         总Delta量 += 当前成交量 * 时间权重;
      }
      else if(获取收盘价(g_品种名称, PERIOD_CURRENT, i) < 获取开盘价(g_品种名称, PERIOD_CURRENT, i))
      {
         卖出成交量 += 当前成交量 * (获取开盘价(g_品种名称, PERIOD_CURRENT, i) - 获取收盘价(g_品种名称, PERIOD_CURRENT, i)) / 当前波幅 * 时间权重;
         总Delta量 += 当前成交量 * 时间权重;
      }
      else
      {
         买入成交量 += 当前成交量 * 0.5 * 时间权重;
         卖出成交量 += 当前成交量 * 0.5 * 时间权重;
         总Delta量 += 当前成交量 * 时间权重;
      }
   }

   if(总Delta量 > 0)
   {
      double Delta得分 = ((买入成交量 - 卖出成交量) / 总Delta量) * 150;
      if(Delta得分 > 0)
      {
         买入力量 += 35 * Delta得分 / 100;
         原因 += "Delta+" + DoubleToString(Delta得分, 1) + "% ";
      }
      else
      {
         卖出力量 += 35 * MathAbs(Delta得分) / 100;
         原因 += "Delta" + DoubleToString(Delta得分, 1) + "% ";
      }
   }

   //--- 2. 价格压力分析（3根K线）
   double 买压 = 0, 卖压 = 0;
   double 总压力 = 0;

   for(int i = 0; i < 3; i++)
   {
      double 波幅 = 获取最高价(g_品种名称, PERIOD_CURRENT, i) - 获取最低价(g_品种名称, PERIOD_CURRENT, i);
      if(波幅 <= 0) 波幅 = g_点;

      double 时间权重 = 1.0 - (i * 0.25);
      double 成交量 = (double)获取成交量(g_品种名称, PERIOD_CURRENT, i) * 时间权重;

      if(获取收盘价(g_品种名称, PERIOD_CURRENT, i) > 获取开盘价(g_品种名称, PERIOD_CURRENT, i))
         买压 += 成交量 * (获取收盘价(g_品种名称, PERIOD_CURRENT, i) - 获取开盘价(g_品种名称, PERIOD_CURRENT, i)) / 波幅;
      else
         卖压 += 成交量 * (获取开盘价(g_品种名称, PERIOD_CURRENT, i) - 获取收盘价(g_品种名称, PERIOD_CURRENT, i)) / 波幅;

      总压力 += 成交量;
   }

   if(总压力 > 0)
   {
      double 压力得分 = ((买压 - 卖压) / 总压力) * 150;
      if(压力得分 > 0)
      {
         买入力量 += 30 * 压力得分 / 100;
         原因 += "Press+" + DoubleToString(压力得分, 1) + "% ";
      }
      else
      {
         卖出力量 += 30 * MathAbs(压力得分) / 100;
         原因 += "Press" + DoubleToString(压力得分, 1) + "% ";
      }
   }

   //--- 3. 动量分析
   double 短期动量 = 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) - 获取收盘价(g_品种名称, PERIOD_CURRENT, 3);
   double 长期动量 = 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) - 获取收盘价(g_品种名称, PERIOD_CURRENT, 10);
   double ATR = 获取指标值(g_hATR, 0, 0);
   if(ATR <= 0) ATR = g_点;

   double 动量得分 = ((短期动量 * 0.8 + 长期动量 * 0.2) / ATR) * 150;
   if(动量得分 > 0)
   {
      买入力量 += 25 * 动量得分 / 100;
      原因 += "Mom+" + DoubleToString(动量得分, 1) + "% ";
   }
   else
   {
      卖出力量 += 25 * MathAbs(动量得分) / 100;
      原因 += "Mom" + DoubleToString(动量得分, 1) + "% ";
   }

   //--- 4. 实时成交量分析
   double 当前成交量 = (double)获取成交量(g_品种名称, PERIOD_CURRENT, 0);
   double 平均成交量 = 0;
   for(int i = 1; i < 10; i++)
      平均成交量 += (double)获取成交量(g_品种名称, PERIOD_CURRENT, i);
   平均成交量 /= 9.0;
   if(平均成交量 <= 0) 平均成交量 = 1.0;

   double 成交量比 = ((当前成交量 / 平均成交量) - 1.0) * 150;
   if(获取收盘价(g_品种名称, PERIOD_CURRENT, 0) > 获取开盘价(g_品种名称, PERIOD_CURRENT, 0))
   {
      买入力量 += 30 * 成交量比 / 100;
      原因 += "Vol+" + DoubleToString(成交量比, 1) + "% ";
   }
   else
   {
      卖出力量 += 30 * MathAbs(成交量比) / 100;
      原因 += "Vol" + DoubleToString(成交量比, 1) + "% ";
   }

   //--- 更新全局订单流数据
   g_订单流.买入力量 = NormalizeDouble(买入力量 * 1.2, 1);
   g_订单流.卖出力量 = NormalizeDouble(卖出力量 * 1.2, 1);
   g_订单流.分析原因 = 原因;

   //--- 方向判断
   if(方向 == 1)
      return (g_订单流.买入力量 > g_订单流.卖出力量);
   else
      return (g_订单流.卖出力量 > g_订单流.买入力量);
}

//+------------------------------------------------------------------+
//| 分析订单流（用于面板显示）                                        |
//+------------------------------------------------------------------+
void 分析订单流()
{
   double 买入力量 = 0, 卖出力量 = 0;
   string 原因 = "";

   //--- Delta分析
   double Delta得分 = 0;
   for(int i = 0; i < 3; i++)
   {
      double delta = (double)获取成交量(g_品种名称, PERIOD_CURRENT, i) *
                     (获取收盘价(g_品种名称, PERIOD_CURRENT, i) - 获取开盘价(g_品种名称, PERIOD_CURRENT, i));
      Delta得分 += delta;
   }
   Delta得分 = NormalizeDouble(Delta得分 / 3.0, 2);

   if(Delta得分 > 0)
   {
      买入力量 += 30 * Delta得分 / 100;
      原因 += "Delta+" + DoubleToString(Delta得分, 1) + "% ";
   }
   else
   {
      卖出力量 += 30 * MathAbs(Delta得分) / 100;
      原因 += "Delta" + DoubleToString(Delta得分, 1) + "% ";
   }

   //--- 价格压力分析
   double 压力得分 = 0;
   int 有效计数 = 0;
   for(int i = 0; i < 2; i++)
   {
      double 价差 = 获取收盘价(g_品种名称, PERIOD_CURRENT, i) - 获取开盘价(g_品种名称, PERIOD_CURRENT, i);
      if(MathAbs(价差) > 0.00001)
      {
         double 压力 = (获取最高价(g_品种名称, PERIOD_CURRENT, i) - 获取最低价(g_品种名称, PERIOD_CURRENT, i)) / 价差;
         压力得分 += 压力;
         有效计数++;
      }
   }
   if(有效计数 > 0)
      压力得分 = NormalizeDouble(压力得分 / (double)有效计数, 2);
   else
      压力得分 = 0;

   if(压力得分 > 0)
   {
      买入力量 += 25 * 压力得分 / 100;
      原因 += "Press+" + DoubleToString(压力得分, 1) + "% ";
   }
   else
   {
      卖出力量 += 25 * MathAbs(压力得分) / 100;
      原因 += "Press" + DoubleToString(压力得分, 1) + "% ";
   }

   //--- 动量分析
   double 短期动量 = 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) - 获取收盘价(g_品种名称, PERIOD_CURRENT, 2);
   double 长期动量 = 获取收盘价(g_品种名称, PERIOD_CURRENT, 0) - 获取收盘价(g_品种名称, PERIOD_CURRENT, 5);
   double 动量得分 = NormalizeDouble(短期动量 + 长期动量, 2);

   if(动量得分 > 0)
   {
      买入力量 += 25 * 动量得分 / 100;
      原因 += "Mom+" + DoubleToString(动量得分, 1) + "% ";
   }
   else
   {
      卖出力量 += 25 * MathAbs(动量得分) / 100;
      原因 += "Mom" + DoubleToString(动量得分, 1) + "% ";
   }

   //--- 成交量分析
   double 平均成交量 = 0;
   int 有效成交量 = 0;
   for(int i = 1; i <= 5; i++)
   {
      double vol = (double)获取成交量(g_品种名称, PERIOD_CURRENT, i);
      if(vol > 0)
      {
         平均成交量 += vol;
         有效成交量++;
      }
   }

   double 成交量比 = 1.0;
   if(有效成交量 > 0)
   {
      平均成交量 /= (double)有效成交量;
      if(平均成交量 > 0)
         成交量比 = NormalizeDouble((double)获取成交量(g_品种名称, PERIOD_CURRENT, 0) / 平均成交量, 2);
   }

   if(获取收盘价(g_品种名称, PERIOD_CURRENT, 0) > 获取开盘价(g_品种名称, PERIOD_CURRENT, 0))
   {
      买入力量 += 20 * 成交量比 / 100;
      原因 += "Vol+" + DoubleToString(成交量比, 1) + "% ";
   }
   else
   {
      卖出力量 += 20 * MathAbs(成交量比) / 100;
      原因 += "Vol" + DoubleToString(成交量比, 1) + "% ";
   }

   //--- 更新全局订单流数据
   g_订单流.买入力量 = NormalizeDouble(买入力量, 1);
   g_订单流.卖出力量 = NormalizeDouble(卖出力量, 1);
   g_订单流.分析原因 = 原因;
}

//+------------------------------------------------------------------+
//| 获取动态权重                                                      |
//+------------------------------------------------------------------+
S动态权重 获取动态权重()
{
   S动态权重 权重;
   权重.趋势权重 = Inp趋势系统权重;
   权重.订单流权重 = InpAI系统权重;
   权重.AI权重 = InpAI系统权重;

   double ADX值 = 获取ADX值();
   double ATR = 获取指标值(g_hATR, 0, 0);
   double 平均ATR = 0;

   // 计算平均ATR
   for(int i = 1; i <= 14; i++)
      平均ATR += 获取指标值(g_hATR, 0, i);
   平均ATR /= 14;

   // 根据市场状态调整权重
   if(ADX值 > 40)  // 强趋势市场
   {
      权重.趋势权重 *= 1.2;
      权重.订单流权重 *= 0.8;
      权重.AI权重 *= 1.0;
   }
   else if(ADX值 < 20)  // 震荡市场
   {
      权重.趋势权重 *= 0.8;
      权重.订单流权重 *= 1.2;
      权重.AI权重 *= 1.0;
   }

   // 根据波动率调整
   if(ATR > 平均ATR * 1.5)  // 高波动
   {
      权重.趋势权重 *= 0.9;
      权重.订单流权重 *= 1.2;
      权重.AI权重 *= 0.9;
   }

   // 标准化权重确保总和为1
   double 总计 = 权重.趋势权重 + 权重.订单流权重 + 权重.AI权重;
   权重.趋势权重 /= 总计;
   权重.订单流权重 /= 总计;
   权重.AI权重 /= 总计;

   return 权重;
}

//+------------------------------------------------------------------+
//| 是否应该开仓（综合评分）                                          |
//+------------------------------------------------------------------+
bool 是否应该开仓(ENUM_ORDER_TYPE 类型)
{
   S动态权重 权重 = 获取动态权重();
   double 最终得分 = 0;

   //--- 趋势系统得分
   double 趋势得分 = 0;
   if(g_ADX值 >= 20)
      趋势得分 = (g_ADX值 > 25 ? 1.5 : 1.0);
   趋势得分 *= 权重.趋势权重;

   //--- 订单流得分
   double 订单流得分 = 0;
   if(类型 == ORDER_TYPE_BUY)
      订单流得分 = (g_订单流.买入力量 > g_订单流.卖出力量) ? 1 : -1;
   else
      订单流得分 = (g_订单流.卖出力量 > g_订单流.买入力量) ? 1 : -1;
   订单流得分 *= 权重.订单流权重;

   //--- AI系统得分
   double AI得分 = 0;
   if(Inp启用AI趋势学习)
   {
      double 特征[];
      ArrayResize(特征, Inp每层神经元);
      提取特征(0, 特征);
      double 预测值 = g_AI学习器.预测趋势(特征);

      if(类型 == ORDER_TYPE_BUY)
         AI得分 = (预测值 > 0.6) ? 1 : -1;
      else
         AI得分 = (预测值 < 0.4) ? 1 : -1;
   }
   AI得分 *= 权重.AI权重;

   //--- 计算最终得分
   最终得分 = 趋势得分 + 订单流得分 + AI得分;

   //--- 更新市场状态显示
   string 权重信息 = StringFormat("权重分配 - 趋势:%.2f 订单流:%.2f AI:%.2f",
                                   权重.趋势权重, 权重.订单流权重, 权重.AI权重);
   g_市场状态 = g_市场状态 + " | " + 权重信息;

   return (最终得分 > 0.3);
}

//+------------------------------------------------------------------+
//| 更新指标状态                                                      |
//+------------------------------------------------------------------+
void 更新指标状态()
{
   //--- 获取指标值
   g_布林上轨 = 获取指标值(g_h布林带, 1, 0);   // 上轨
   g_布林中轨 = 获取指标值(g_h布林带, 0, 0);   // 中轨
   g_布林下轨 = 获取指标值(g_h布林带, 2, 0);   // 下轨

   g_RSI值    = 获取指标值(g_hRSI, 0, 0);
   g_ADX值    = 获取指标值(g_hADX, 0, 0);      // 主线
   g_正向DI   = 获取指标值(g_hADX, 1, 0);      // +DI
   g_负向DI   = 获取指标值(g_hADX, 2, 0);      // -DI
   g_ATR值    = 获取指标值(g_hATR, 0, 0);

   g_MA趋势   = 获取指标值(g_hMA趋势, 0, 0);
   g_MA快     = 获取指标值(g_hMA快, 0, 0);
   g_MA慢     = 获取指标值(g_hMA慢, 0, 0);

   //--- 获取均线值用于交叉判断
   g_fastMA   = 获取指标值(g_hMA快, 0, 0);
   g_slowMA   = 获取指标值(g_hMA慢, 0, 0);

   //--- MACD
   g_MACD主线 = 获取指标值(g_hMACD, 0, 0);   // 主线
   g_信号线    = 获取指标值(g_hMACD, 1, 0);   // 信号线

   double ask = g_品种信息.Ask();
   double bid = g_品种信息.Bid();

   //--- ADX趋势分析
   if(g_ADX值 >= InpADX阈值)
   {
      if(ask > g_MA趋势)
      {
         g_趋势状态 = "强多头";
         g_趋势颜色 = clrDodgerBlue;
         g_ADX状态  = "趋势强劲(多头)";
      }
      else
      {
         g_趋势状态 = "强空头";
         g_趋势颜色 = clrTomato;
         g_ADX状态  = "趋势强劲(空头)";
      }
   }
   else
   {
      g_趋势状态 = "震荡市";
      g_趋势颜色 = clrGray;
      g_ADX状态  = "趋势微弱";
   }

   //--- RSI超买超卖分析
   if(g_RSI值 >= InpRSI超买)
   {
      g_RSI状态  = "超买(≥" + DoubleToString(InpRSI超买, 0) + ")";
      g_信号状态  = "超买预警";
   }
   else if(g_RSI值 <= InpRSI超卖)
   {
      g_RSI状态  = "超卖(≤" + DoubleToString(InpRSI超卖, 0) + ")";
      g_信号状态  = "超卖预警";
   }
   else
   {
      g_RSI状态  = "中性(" + DoubleToString(g_RSI值, 1) + ")";
      g_信号状态  = "";
   }

   //--- 布林带分析
   if(ask >= g_布林上轨)
      g_布林带状态 = "触及上轨";
   else if(bid <= g_布林下轨)
      g_布林带状态 = "触及下轨";
   else
      g_布林带状态 = "通道内";

   //--- 均线交叉分析
   double MA快1 = 获取指标值(g_hMA快, 0, 1);   // 1根K线前的快线
   double MA慢1 = 获取指标值(g_hMA慢, 0, 1);   // 1根K线前的慢线
   if(g_fastMA > g_slowMA && MA快1 <= MA慢1)
      g_均线状态 = "金叉↑";
   else if(g_fastMA < g_slowMA && MA快1 >= MA慢1)
      g_均线状态 = "死叉↓";
   else
      g_均线状态 = "无交叉";

   //--- MACD分析
   if(g_MACD主线 > g_信号线)
   {
      if(g_MACD主线 > 0)
         g_MACD状态 = "MACD: 强势多头";
      else
         g_MACD状态 = "MACD: 弱势多头";
   }
   else
   {
      if(g_MACD主线 < 0)
         g_MACD状态 = "MACD: 强势空头";
      else
         g_MACD状态 = "MACD: 弱势空头";
   }

   //--- 斐波那契
   计算斐波那契水平();
   绘制斐波那契水平线();

   double 当前价格 = (ask + bid) / 2;
   string 斐波趋势 = "";
   if(当前价格 > g_斐波50)
   {
      斐波趋势 = "上涨";
      if(当前价格 > g_斐波38) 斐波趋势 += "(强)";
   }
   else if(当前价格 < g_斐波50)
   {
      斐波趋势 = "下跌";
      if(当前价格 < g_斐波61) 斐波趋势 += "(强)";
   }
   else
      斐波趋势 = "盘整";

   //--- 综合市场状态
   g_市场状态 = StringFormat("ADX: %s | RSI: %s | BB: %s | MA: %s | 斐波那契: %s",
                              g_ADX状态, g_RSI状态, g_布林带状态, g_均线状态, 斐波趋势);
}

//+------------------------------------------------------------------+
//| 获取指标值（单缓冲区指标）                                        |
//+------------------------------------------------------------------+
double 获取指标值(int 句柄, int 缓冲区, int 位移)
{
   double 值[1];
   if(CopyBuffer(句柄, 缓冲区, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//| 获取ADX值                                                         |
//+------------------------------------------------------------------+
double 获取ADX值()
{
   return 获取指标值(g_hADX, 0, 0);
}

//+------------------------------------------------------------------+
//| 计算斐波那契水平                                                  |
//+------------------------------------------------------------------+
void 计算斐波那契水平()
{
   // 在当前周期上获取最近的高低点
   int 最高索引 = 查找最高索引(g_品种名称, PERIOD_CURRENT, 20, 0);
   int 最低索引 = 查找最低索引(g_品种名称, PERIOD_CURRENT, 20, 0);

   if(最高索引 >= 0 && 最低索引 >= 0)
   {
      g_斐波高点 = 获取最高价(g_品种名称, PERIOD_CURRENT, 最高索引);
      g_斐波低点 = 获取最低价(g_品种名称, PERIOD_CURRENT, 最低索引);

      double 区间 = g_斐波高点 - g_斐波低点;
      g_斐波38 = g_斐波高点 - 区间 * 0.382;
      g_斐波50 = g_斐波高点 - 区间 * 0.5;
      g_斐波61 = g_斐波高点 - 区间 * 0.618;
   }
}

//+------------------------------------------------------------------+
//| 绘制斐波那契水平线                                                |
//+------------------------------------------------------------------+
void 绘制斐波那契水平线()
{
   string 线名称[] = {"斐波高点", "斐波低点", "斐波38", "斐波50", "斐波61"};

   // 删除旧线
   for(int i = 0; i < ArraySize(线名称); i++)
      ObjectDelete(0, 线名称[i]);

   // 计算显示范围
   datetime 开始时间 = 获取K线时间(g_品种名称, PERIOD_CURRENT, 100);
   datetime 结束时间 = 获取K线时间(g_品种名称, PERIOD_CURRENT, 0);

   // 100%线
   趋势线创建("斐波高点", 开始时间, g_斐波高点, 结束时间, g_斐波高点, C'192,192,192', "100% " + DoubleToString(g_斐波高点, g_小数位数));

   // 0%线
   趋势线创建("斐波低点", 开始时间, g_斐波低点, 结束时间, g_斐波低点, C'192,192,192', "0% " + DoubleToString(g_斐波低点, g_小数位数));

   // 38.2%线
   趋势线创建("斐波38", 开始时间, g_斐波38, 结束时间, g_斐波38, C'192,192,192', "38.2% " + DoubleToString(g_斐波38, g_小数位数));

   // 50%线
   趋势线创建("斐波50", 开始时间, g_斐波50, 结束时间, g_斐波50, C'192,192,192', "50% " + DoubleToString(g_斐波50, g_小数位数));

   // 61.8%线
   趋势线创建("斐波61", 开始时间, g_斐波61, 结束时间, g_斐波61, C'192,192,192', "61.8% " + DoubleToString(g_斐波61, g_小数位数));

   ChartRedraw();
}

//+------------------------------------------------------------------+
//| 趋势线创建辅助函数                                                |
//+------------------------------------------------------------------+
void 趋势线创建(string 名称, datetime 时间1, double 价格1,
                datetime 时间2, double 价格2, color 颜色, string 标签)
{
   ObjectCreate(0, 名称, OBJ_TREND, 0, 时间1, 价格1, 时间2, 价格2);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 颜色);
   ObjectSetInteger(0, 名称, OBJPROP_STYLE, STYLE_SOLID);
   ObjectSetInteger(0, 名称, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, true);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, true);
   ObjectSetInteger(0, 名称, OBJPROP_RAY_RIGHT, false);
   ObjectSetString(0, 名称, OBJPROP_TEXT, 标签);
}

//+------------------------------------------------------------------+
//| 水平线创建                                                        |
//+------------------------------------------------------------------+
void 水平线创建(string 名称, double 价格, color 颜色)
{
   ObjectCreate(0, 名称, OBJ_HLINE, 0, 0, 价格);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 颜色);
   ObjectSetInteger(0, 名称, OBJPROP_STYLE, STYLE_SOLID);
   ObjectSetInteger(0, 名称, OBJPROP_WIDTH, 2);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, false);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, true);
}

//+------------------------------------------------------------------+
//| 水平线移动                                                        |
//+------------------------------------------------------------------+
void 水平线移动(string 名称, double 价格)
{
   ObjectSetDouble(0, 名称, OBJPROP_PRICE, 价格);
}

//+------------------------------------------------------------------+
//| 水平线获取价格                                                    |
//+------------------------------------------------------------------+
double 水平线获取价格(string 名称)
{
   return ObjectGetDouble(0, 名称, OBJPROP_PRICE);
}

//+------------------------------------------------------------------+
//| 特征提取（用于AI学习）                                            |
//+------------------------------------------------------------------+
void 提取特征(int 位移, double &特征[])
{
   // 确保位移在有效范围内
   int 总K线 = ::Bars(g_品种名称, PERIOD_CURRENT);
   位移 = MathMin(位移, 总K线 - 1);
   位移 = MathMax(位移, 0);

   double 收盘 = 获取收盘价(g_品种名称, PERIOD_CURRENT, 位移);
   double 开盘 = 获取开盘价(g_品种名称, PERIOD_CURRENT, 位移);
   double 最高 = 获取最高价(g_品种名称, PERIOD_CURRENT, 位移);
   double 最低 = 获取最低价(g_品种名称, PERIOD_CURRENT, 位移);
   long   成交量 = 获取成交量(g_品种名称, PERIOD_CURRENT, 位移);

   // 价格特征
   特征[0] = 归一化价格(收盘 - 开盘);
   特征[1] = 归一化价格(最高 - 最低);

   // 技术指标特征
   特征[2] = MathMax(0.0, MathMin(g_RSI值 / 100.0, 1.0));
   特征[3] = 归一化价格(g_布林上轨 - g_布林下轨);
   特征[4] = MathMax(0.0, MathMin(g_ADX值 / 100.0, 1.0));

   // 趋势特征
   特征[5] = (double)(g_MA趋势 > 收盘);
   特征[6] = (double)(g_fastMA > g_slowMA);

   // 成交量特征
   特征[7] = 归一化成交量((double)成交量);

   // 斐波那契特征
   double ask = g_品种信息.Ask();
   double bid = g_品种信息.Bid();
   double 当前价格 = (ask + bid) / 2;

   double 斐波区间 = g_斐波高点 - g_斐波低点;
   if(斐波区间 > 0)
   {
      特征[8] = (当前价格 - g_斐波低点) / 斐波区间;
      特征[8] = MathMax(0.0, MathMin(特征[8], 1.0));
   }
   else
      特征[8] = 0.5;

   特征[9] = (double)(当前价格 > g_斐波50);

   // 确保所有特征都在有效范围内
   for(int i = 0; i < Inp每层神经元; i++)
      特征[i] = MathMax(-1.0, MathMin(特征[i], 1.0));
}

//+------------------------------------------------------------------+
//| 价格归一化                                                        |
//+------------------------------------------------------------------+
double 归一化价格(double 价格)
{
   return NormalizeDouble(价格, g_小数位数);
}

//+------------------------------------------------------------------+
//| 成交量归一化                                                      |
//+------------------------------------------------------------------+
double 归一化成交量(double 成交量)
{
   double 平均成交量 = 0;
   int 回看周期 = 20;
   int 总K线 = ::Bars(g_品种名称, PERIOD_CURRENT);

   for(int i = 0; i < 回看周期 && i < 总K线; i++)
   {
      double vol = (double)获取成交量(g_品种名称, PERIOD_CURRENT, i);
      if(vol > 0)
         平均成交量 += vol;
   }

   if(回看周期 > 0 && 平均成交量 > 0)
   {
      平均成交量 /= (double)回看周期;
      double 归一化值 = 成交量 / 平均成交量;
      return MathMax(0.0, MathMin(归一化值, 100.0));
   }

   return 0.0;
}

//+------------------------------------------------------------------+
//| 历史数据训练                                                      |
//+------------------------------------------------------------------+
void 历史数据训练()
{
   if(!Inp启用AI趋势学习) return;

   Print("开始AI历史数据训练...");

   double 特征[];
   ArrayResize(特征, Inp每层神经元);

   int 成功计数 = 0;
   int 总计数 = 0;
   int 总K线 = ::Bars(g_品种名称, PERIOD_CURRENT);

   // 遍历历史数据进行训练
   for(int i = Inp学习周期; i > Inp预测周期 && i < 总K线; i--)
   {
      // 提取特征
      提取特征(i, 特征);

      // 计算实际趋势（作为训练目标）
      double 目标值 = 0;
      if(获取收盘价(g_品种名称, PERIOD_CURRENT, i - Inp预测周期) > 获取收盘价(g_品种名称, PERIOD_CURRENT, i))
      {
         目标值 = 1;  // 上涨趋势
         总计数++;
         if(g_AI学习器.上次预测 > 0.5)
            成功计数++;
      }
      else if(获取收盘价(g_品种名称, PERIOD_CURRENT, i - Inp预测周期) < 获取收盘价(g_品种名称, PERIOD_CURRENT, i))
      {
         目标值 = 0;  // 下跌趋势
         总计数++;
         if(g_AI学习器.上次预测 < 0.5)
            成功计数++;
      }

      // 训练网络
      g_AI学习器.训练(特征, 目标值);
   }

   double 准确率 = 总计数 > 0 ? (double)成功计数 / 总计数 * 100 : 0;
   Print("AI训练完成！准确率: ", DoubleToString(准确率, 2), "%");
}

//+------------------------------------------------------------------+
//| 查找最高价索引（MQL4兼容）                                        |
//+------------------------------------------------------------------+
int 查找最高索引(string 品种, ENUM_TIMEFRAMES 周期, int 计数, int 起始)
{
   double 最高值 = -DBL_MAX;
   int 最高索引 = -1;

   for(int i = 起始; i < 起始 + 计数; i++)
   {
      double 值 = 获取最高价(品种, 周期, i);
      if(值 > 最高值)
      {
         最高值 = 值;
         最高索引 = i;
      }
   }
   return 最高索引;
}

//+------------------------------------------------------------------+
//| 查找最低价索引（MQL4兼容）                                        |
//+------------------------------------------------------------------+
int 查找最低索引(string 品种, ENUM_TIMEFRAMES 周期, int 计数, int 起始)
{
   double 最低值 = DBL_MAX;
   int 最低索引 = -1;

   for(int i = 起始; i < 起始 + 计数; i++)
   {
      double 值 = 获取最低价(品种, 周期, i);
      if(值 < 最低值)
      {
         最低值 = 值;
         最低索引 = i;
      }
   }
   return 最低索引;
}

//+------------------------------------------------------------------+
//| 获取开盘价（MQL4兼容）                                            |
//+------------------------------------------------------------------+
double 获取开盘价(string 品种, ENUM_TIMEFRAMES 周期, int 位移)
{
   double 值[1];
   if(CopyOpen(品种, 周期, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//| 获取收盘价（MQL4兼容）                                            |
//+------------------------------------------------------------------+
double 获取收盘价(string 品种, ENUM_TIMEFRAMES 周期, int 位移)
{
   double 值[1];
   if(CopyClose(品种, 周期, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//| 获取最高价（MQL4兼容）                                            |
//+------------------------------------------------------------------+
double 获取最高价(string 品种, ENUM_TIMEFRAMES 周期, int 位移)
{
   double 值[1];
   if(CopyHigh(品种, 周期, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//| 获取最低价（MQL4兼容）                                            |
//+------------------------------------------------------------------+
double 获取最低价(string 品种, ENUM_TIMEFRAMES 周期, int 位移)
{
   double 值[1];
   if(CopyLow(品种, 周期, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//| 获取成交量（MQL4兼容）                                            |
//+------------------------------------------------------------------+
long 获取成交量(string 品种, ENUM_TIMEFRAMES 周期, int 位移)
{
   long 值[1];
   if(CopyTickVolume(品种, 周期, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//| 获取K线时间（MQL4兼容）                                          |
//+------------------------------------------------------------------+
datetime 获取K线时间(string 品种, ENUM_TIMEFRAMES 周期, int 位移)
{
   datetime 值[1];
   if(CopyTime(品种, 周期, 位移, 1, 值) == 1)
      return 值[0];
   return 0;
}

//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| GUI面板：创建（简洁两列布局）                                     |
//+------------------------------------------------------------------+
void 创建GUI面板()
{
   //--- 半透明深色背景面板
   矩形创建("面板_背景", 255, 18, 240, 360, C'25,25,38');

   //--- 标题
   标签创建("标签_标题", 135, 28, "源流 智能过滤马丁", clrGold, 10);

   //=== 账户信息区 ===
   标签创建("面板_区1", 135, 52, "── 账 户 信 息 ──", C'100,100,120', 8);

   标签创建("标签_余额标题", 225, 70, "余额", Inp文本颜色, Inp字体大小);
   标签创建("标签_余额值",   25, 70, "0.00", Inp数据颜色, Inp字体大小);

   标签创建("标签_净值标题", 225, 90, "净值", Inp文本颜色, Inp字体大小);
   标签创建("标签_净值值",   25, 90, "0.00", Inp数据颜色, Inp字体大小);

   标签创建("标签_浮动标题", 225, 110, "浮动盈亏", Inp文本颜色, Inp字体大小);
   标签创建("标签_浮动值",   25, 110, "0.00", clrGray, Inp字体大小);

   标签创建("标签_止盈标题", 225, 130, "止盈进度", Inp文本颜色, Inp字体大小);
   标签创建("标签_止盈值",   25, 130, "0% / 0.5%", Inp数据颜色, Inp字体大小);

   //=== 持仓信息区 ===
   标签创建("面板_区2", 135, 155, "── 持 仓 信 息 ──", C'100,100,120', 8);

   标签创建("标签_单数标题", 225, 173, "持仓单数", Inp文本颜色, Inp字体大小);
   标签创建("标签_单数值",   25, 173, "0", Inp数据颜色, Inp字体大小);

   标签创建("标签_手数标题", 225, 193, "总手数", Inp文本颜色, Inp字体大小);
   标签创建("标签_手数值",   25, 193, "0.00", Inp数据颜色, Inp字体大小);

   标签创建("标签_今利标题", 225, 213, "今日利润", Inp文本颜色, Inp字体大小);
   标签创建("标签_今利值",   25, 213, "0.00", Inp数据颜色, Inp字体大小);

   //=== 市场动态区 ===
   标签创建("面板_区3", 135, 238, "── 市 场 动 态 ──", C'100,100,120', 8);

   标签创建("标签_趋势标题", 225, 256, "趋势方向", Inp文本颜色, Inp字体大小);
   标签创建("标签_趋势值",   25, 256, "等待中...", clrGray, Inp字体大小);

   标签创建("标签_ADXRSI标题", 225, 276, "ADX / RSI", Inp文本颜色, Inp字体大小);
   标签创建("标签_ADXRSI值",   25, 276, "-- / --", clrGray, Inp字体大小);

   标签创建("标签_MACD标题", 225, 296, "MACD", Inp文本颜色, Inp字体大小);
   标签创建("标签_MACD值",   25, 296, "等待中...", clrGray, Inp字体大小);

   //=== AI预测（可选）===
   if(Inp启用AI趋势学习)
   {
      标签创建("标签_AI标题", 225, 316, "AI预测", Inp文本颜色, Inp字体大小);
      标签创建("标签_AI值",   25, 316, "等待中...", clrGray, Inp字体大小);
   }

   //=== 交易按钮 ===
   按钮创建("按钮_买入", 225, 340, "  BUY  ", 105, 26, C'30,100,200', clrWhite);
   按钮创建("按钮_卖出", 115, 340, "  SELL ", 105, 26, C'200,50,50', clrWhite);

   ChartRedraw();
}

//+------------------------------------------------------------------+
//| GUI面板：删除                                                     |
//+------------------------------------------------------------------+
void 删除GUI面板()
{
   ObjectsDeleteAll(0, "面板_");
   ObjectsDeleteAll(0, "标签_");
   ObjectsDeleteAll(0, "按钮_");
   ChartRedraw();
}

//+------------------------------------------------------------------+
//| GUI面板：更新（简洁版）                                           |
//+------------------------------------------------------------------+
void 更新GUI面板()
{
   double 有效余额   = 获取有效余额();
   double 有效净值   = 获取有效金额(AccountInfoDouble(ACCOUNT_EQUITY));
   double 有效浮动盈亏 = 获取有效金额(计算浮动盈亏());
   double 有效今日利润 = 获取有效金额(计算当日利润());

   //--- 更新账户信息
   ObjectSetString(0, "标签_余额值", OBJPROP_TEXT, StringFormat("%.2f", 有效余额));
   ObjectSetString(0, "标签_净值值", OBJPROP_TEXT, StringFormat("%.2f", 有效净值));
   ObjectSetString(0, "标签_浮动值", OBJPROP_TEXT, StringFormat("%+.2f", 有效浮动盈亏));

   // 浮动盈亏颜色
   if(有效浮动盈亏 >= 0)
      ObjectSetInteger(0, "标签_浮动值", OBJPROP_COLOR, clrLime);
   else
      ObjectSetInteger(0, "标签_浮动值", OBJPROP_COLOR, clrTomato);

   //--- 更新止盈进度
   double 阈值 = 获取专业止盈阈值();
   double 有效余额2 = 获取有效余额();
   int 层数 = 获取当前持仓数();
   string 层级标签;
   if(层数 <= 0) 层级标签 = "--";
   else if(层数 <= 2) 层级标签 = "轻仓";
   else if(层数 <= 4) 层级标签 = "中仓";
   else 层级标签 = "深仓";

   string 移动标签 = g_移动止盈激活 ? " [追踪]" : "";
   string 止盈文本 = StringFormat("%s$%.2f/$%.2f%s",
                                   层级标签,
                                   有效余额2 * g_新利润率 / 100.0,
                                   有效余额2 * 阈值 / 100.0,
                                   移动标签);
   ObjectSetString(0, "标签_止盈值", OBJPROP_TEXT, 止盈文本);

   if(g_移动止盈激活)
      ObjectSetInteger(0, "标签_止盈值", OBJPROP_COLOR, clrOrange);     // 移动止盈中
   else if(g_新利润率 >= 阈值 * 0.8)
      ObjectSetInteger(0, "标签_止盈值", OBJPROP_COLOR, clrGold);       // 接近止盈
   else
      ObjectSetInteger(0, "标签_止盈值", OBJPROP_COLOR, Inp数据颜色);

   //--- 更新持仓信息
   int 买单数 = 获取持仓数(OP_BUY);
   int 卖单数 = 获取持仓数(OP_SELL);
   int 总单数 = 买单数 + 卖单数;

   double 总手数 = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(g_仓位信息.SelectByIndex(i))
      {
         if(g_仓位信息.Symbol() == g_品种名称 && g_仓位信息.Magic() == Inp魔术码)
            总手数 += g_仓位信息.Volume();
      }
   }

   string 持仓文本 = StringFormat("%d (多%d/空%d)", 总单数, 买单数, 卖单数);
   ObjectSetString(0, "标签_单数值", OBJPROP_TEXT, 持仓文本);
   ObjectSetString(0, "标签_手数值", OBJPROP_TEXT, StringFormat("%.2f", 总手数));
   ObjectSetString(0, "标签_今利值", OBJPROP_TEXT, StringFormat("%+.2f", 有效今日利润));

   if(有效今日利润 >= 0)
      ObjectSetInteger(0, "标签_今利值", OBJPROP_COLOR, clrLime);
   else
      ObjectSetInteger(0, "标签_今利值", OBJPROP_COLOR, clrTomato);

   //--- 更新市场指标
   ObjectSetString(0, "标签_趋势值", OBJPROP_TEXT, g_趋势状态);
   ObjectSetInteger(0, "标签_趋势值", OBJPROP_COLOR, g_趋势颜色);

   string ADXRSI文本 = StringFormat("%.0f / %.0f", g_ADX值, g_RSI值);
   ObjectSetString(0, "标签_ADXRSI值", OBJPROP_TEXT, ADXRSI文本);
   ObjectSetString(0, "标签_MACD值", OBJPROP_TEXT, g_MACD状态);

   //--- 更新AI预测
   if(Inp启用AI趋势学习)
   {
      double 特征[];
      ArrayResize(特征, Inp每层神经元);
      提取特征(0, 特征);
      double 预测值 = g_AI学习器.预测趋势(特征);

      string 预测文本 = (预测值 > 0.5) ?
                        StringFormat("看涨 %.0f%%", 预测值 * 100) :
                        StringFormat("看跌 %.0f%%", (1 - 预测值) * 100);
      ObjectSetString(0, "标签_AI值", OBJPROP_TEXT, 预测文本);
      ObjectSetInteger(0, "标签_AI值", OBJPROP_COLOR, 预测值 > 0.5 ? clrDodgerBlue : clrTomato);
   }

   //--- 更新按钮文本
   ObjectSetString(0, "按钮_买入", OBJPROP_TEXT, "  BUY " + DoubleToString(g_基础手数, 2) + "  ");
   ObjectSetString(0, "按钮_卖出", OBJPROP_TEXT, "  SELL " + DoubleToString(g_基础手数, 2) + "  ");

   ChartRedraw();
}

//+------------------------------------------------------------------+
//| GUI辅助：创建矩形（圆角效果用扁平边框）                           |
//+------------------------------------------------------------------+
void 矩形创建(string 名称, int X, int Y, int 宽度, int 高度, color 颜色)
{
   ObjectCreate(0, 名称, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, 名称, OBJPROP_XDISTANCE, X);
   ObjectSetInteger(0, 名称, OBJPROP_YDISTANCE, Y);
   ObjectSetInteger(0, 名称, OBJPROP_XSIZE, 宽度);
   ObjectSetInteger(0, 名称, OBJPROP_YSIZE, 高度);
   ObjectSetInteger(0, 名称, OBJPROP_BGCOLOR, 颜色);
   ObjectSetInteger(0, 名称, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, CORNER_RIGHT_UPPER);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, C'50,50,65');
   ObjectSetInteger(0, 名称, OBJPROP_STYLE, STYLE_SOLID);
   ObjectSetInteger(0, 名称, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, false);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, false);
}

//+------------------------------------------------------------------+
//| GUI辅助：创建标签（统一字体和样式）                               |
//+------------------------------------------------------------------+
void 标签创建(string 名称, int X, int Y, string 文本, color 颜色, int 字号)
{
   ObjectCreate(0, 名称, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, 名称, OBJPROP_XDISTANCE, X);
   ObjectSetInteger(0, 名称, OBJPROP_YDISTANCE, Y);
   ObjectSetString(0, 名称, OBJPROP_TEXT, 文本);
   ObjectSetString(0, 名称, OBJPROP_FONT, "Microsoft YaHei");
   ObjectSetInteger(0, 名称, OBJPROP_FONTSIZE, 字号);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 颜色);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, CORNER_RIGHT_UPPER);
   ObjectSetInteger(0, 名称, OBJPROP_HIDDEN, false);
   ObjectSetInteger(0, 名称, OBJPROP_BACK, false);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, false);
}

//+------------------------------------------------------------------+
//| GUI辅助：创建按钮（美化样式）                                     |
//+------------------------------------------------------------------+
void 按钮创建(string 名称, int X, int Y, string 文本, int 宽度, int 高度, color 背景色, color 文字色)
{
   ObjectCreate(0, 名称, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, 名称, OBJPROP_XDISTANCE, X);
   ObjectSetInteger(0, 名称, OBJPROP_YDISTANCE, Y);
   ObjectSetInteger(0, 名称, OBJPROP_XSIZE, 宽度);
   ObjectSetInteger(0, 名称, OBJPROP_YSIZE, 高度);
   ObjectSetString(0, 名称, OBJPROP_TEXT, 文本);
   ObjectSetString(0, 名称, OBJPROP_FONT, "Microsoft YaHei");
   ObjectSetInteger(0, 名称, OBJPROP_FONTSIZE, 9);
   ObjectSetInteger(0, 名称, OBJPROP_COLOR, 文字色);
   ObjectSetInteger(0, 名称, OBJPROP_BGCOLOR, 背景色);
   ObjectSetInteger(0, 名称, OBJPROP_BORDER_COLOR, 背景色);
   ObjectSetInteger(0, 名称, OBJPROP_CORNER, CORNER_RIGHT_UPPER);
   ObjectSetInteger(0, 名称, OBJPROP_STATE, false);
   ObjectSetInteger(0, 名称, OBJPROP_SELECTABLE, false);
}


//| 更新趋势状态显示                                                  |
//+------------------------------------------------------------------+
void 更新趋势状态显示()
{
   double ask = g_品种信息.Ask();
   double bid = g_品种信息.Bid();
   double 当前价格 = (ask + bid) / 2;

   // 斐波那契状态
   string 斐波状态 = "";
   if(当前价格 > g_斐波61)
      斐波状态 = "斐波那契:强势上涨";
   else if(当前价格 > g_斐波50)
      斐波状态 = "斐波那契:上涨趋势";
   else if(当前价格 > g_斐波38)
      斐波状态 = "斐波那契:盘整";
   else if(当前价格 > g_斐波低点)
      斐波状态 = "斐波那契:下跌趋势";
   else
      斐波状态 = "斐波那契:强势下跌";

   // 均线状态
   string MA状态 = (获取收盘价(g_品种名称, PERIOD_CURRENT, 0) >
                    获取指标值(g_hMA快, 0, 0)) ? "均线:多头" : "均线:空头";

   // MACD状态
   string MACD状态 = (获取指标值(g_hMACD, 0, 0) >
                      获取指标值(g_hMACD, 1, 0)) ? "MACD:多头" : "MACD:空头";

   // RSI状态
   string RSI状态 = "RSI:" + DoubleToString(g_RSI值, 1);

   // 综合趋势状态
   if(趋势是否有效(1))
   {
      g_趋势状态 = "多头趋势 | " + 斐波状态 + " | " + MA状态 + " | " + MACD状态 + " | " + RSI状态;
      g_趋势颜色 = clrDodgerBlue;
   }
   else if(趋势是否有效(-1))
   {
      g_趋势状态 = "空头趋势 | " + 斐波状态 + " | " + MA状态 + " | " + MACD状态 + " | " + RSI状态;
      g_趋势颜色 = clrTomato;
   }
   else
   {
      g_趋势状态 = "无明确趋势 | " + 斐波状态 + " | " + MA状态 + " | " + MACD状态 + " | " + RSI状态;
      g_趋势颜色 = clrGray;
   }
}
//+------------------------------------------------------------------+

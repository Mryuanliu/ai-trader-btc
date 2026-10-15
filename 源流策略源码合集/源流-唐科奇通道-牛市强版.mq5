//+------------------------------------------------------------------+
//|                               Pro Gold Lion EA v1.31 — MQL5 汉化版 |
//|                                         唐奇安通道突破 + 多策略并行 |
//|                                            原作者: Wim Schrynemakers |
//+------------------------------------------------------------------+
#property copyright "Copyright 2023 - Wim Schrynemakers"
#property description "Gold Trade Pro — 黄金专用多策略EA"
#property version   "1.31"
#property strict

//+------------------------------------------------------------------+
//| 枚举定义                                                           |
//+------------------------------------------------------------------+
enum ENUM_SLIPPAGE_CONTROL      { SCT_2 = 2, SCT_1 = 1 };               // 滑点控制模式
enum ENUM_VIRTUAL_STOP_MODE     { VSL_ADV = 3, VSL_BASIC = 2, VSL_OFF = 1 }; // 虚拟止损模式
enum ENUM_SELECT_ENTRY_STRATEGY { Strategy_TWO = 2, Strategy_ONE = 1 }; // 入场策略选择
enum ENUM_TIMEFRAME_ST1         { ST1_Chart = 0, ST1_Daily = 1440, ST1_H4 = 240, ST1_H1 = 60, ST1_M30 = 30, ST1_M15 = 15, ST1_M5 = 5, ST1_M1 = 1 }; // 策略1时间框架
enum ENUM_TIMEFRAME_ENTRY       { Entry_T_H4 = 240, Entry_T_H1 = 60, Entry_T_M30 = 30, Entry_T_M15 = 15, Entry_T_M5 = 5, Entry_T_M1 = 1, Entry_T_Tick = 0 }; // 入场时机
enum ENUM_USE_OF_COMPOUND       { Multi_trades = 2, one_trade = 1, no_compound = 0 }; // 复合模式
enum ENUM_MONITOR_TRADES        { MT_PairOfChart = 1, MT_all = 0 };     // 监控交易范围
enum ENUM_TIMEFRAME_EXIT        { ET_H1 = 60, ET_M30 = 30, ET_M15 = 15, ET_M5 = 5, ET_M1 = 1, ET_Tick = 0 }; // 出场时机
enum ENUM_EXIT_HL_TRAIL         { HLT_D1 = 1440, HLT_H4 = 240, HLT_H1 = 60, HLT_M30 = 30, HLT_M15 = 15, HLT_M5 = 5, HLT_M1 = 1, HLT_Chart = 0 }; // 高低点追踪时间框架
enum ENUM_MAGICTRAIL_MODE       { ST1_MT_M_B = 2, ST1_MT_M_F = 1, ST1_MT_M_O = 0 }; // MagicTrail模式
enum ENUM_RISK_MODE             { RPT = 999, Lots_Per_Balance = 9999, Manual_Lotsize = 0 }; // 风险管理模式
enum ENUM_PERFORMANCE_OPTIONS   { RealProfit = 1, NormalizedProfit = 2 }; // 绩效统计方式
enum ENUM_RANKING_OPTIONS       { ranking_pertrade = 2, ranking_profit = 1 }; // 排名方式
enum ENUM_REDUCTION_CHOICES     { Red_90 = 90, Red_80 = 80, Red_70 = 70, Red_60 = 60, Red_50 = 50, Red_40 = 40, Red_30 = 30, Red_20 = 20, Red_10 = 10 }; // 缩减比例
enum ENUM_FACTOR_TYPE           { factor_type_3 = 3, factor_type_2 = 2, factor_type_1 = 1 }; // 因子类型
enum ENUM_TIME_SOURCE           { TZ_Broker = 2, TZ_PC = 1, TZ_GMT = 0 }; // 时间来源

//+------------------------------------------------------------------+
//| 外部输入参数                                                       |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| 输入: 基础设置                                                      |
//+------------------------------------------------------------------+
input bool     ShowInfoPanel           = true;                       // 显示信息面板
input double   InfoPanelSizeAdjust     = 1.0;                        // 信息面板大小调整
input bool     UpdateInfoTesting       = false;                      // 回测时更新信息面板
input string   spreadfilter            = "------------------------------ 设置 ------------------------------"; // - - -

//+------------------------------------------------------------------+
//| 输入: 策略开关                                                      |
//+------------------------------------------------------------------+
input bool     RunStrategyA            = true;                       // 运行策略1 (A)
input bool     RunStrategyC            = true;                       // 运行策略2 (C)
input bool     RunStrategyD            = true;                       // 运行策略3 (D)
input bool     RunStrategyE            = true;                       // 运行策略4 (E)
input bool     RunStrategyF            = true;                       // 运行策略5 (F)
input bool     RunStrategyG            = true;                       // 运行策略6 (G)
input bool     RunStrategyH            = true;                       // 运行策略7 (H)

//+------------------------------------------------------------------+
//| 输入: 交易设置                                                      |
//+------------------------------------------------------------------+
input double   MaxSpread               = 500;                        // 最大允许点差
input bool     setSL_TP_After_Entry    = false;                      // 入场后设置止盈止损
input bool     Virtual_expiration      = true;                       // 使用虚拟过期
input int      ST1_MagicNumber         = 1000;                       // 基础魔术号
input string   ST1_Comment             = "Gold Trade Pro";           // 订单注释

//+------------------------------------------------------------------+
//| 输入: 手数设置                                                      |
//+------------------------------------------------------------------+
input ENUM_RISK_MODE Risk              = 0;                          // 手数计算方式
input double   StartLots               = 0.01;                       // 起始手数
input int      LotPerBalance_step      = 600;                        // 每多少余额增加手数
input double   Manual_RiskPerTrade     = 2.0;                        // 每笔最大风险%
input bool     UseEquity               = false;                      // 使用净值而非余额
input bool     OnlyUp                  = true;                       // 手数只增不减

//+------------------------------------------------------------------+
//| 全局变量 — 核心交易参数                                            |
//+------------------------------------------------------------------+
double   g_spread;                          // 当前点差
int      g_random_slippage = 0;             // 随机滑点数
bool     g_one_chart_setup = false;         // 一图表多品种模式
bool     g_run_strategy_B = false;          // 运行隐藏策略B
bool     g_use_spread_filter = true;        // 启用点差过滤
int      g_spread_distance = 2;             // 挂单距市场最小距离(点)
double   g_max_spread_for_store = 0.0;      // 存储挂单的最大点差
double   g_slippage_pips = 100.0;           // 滑点点数
int      g_slippage_mode = 1;               // 滑点控制模式 (1=收紧止损, 2=激进)
double   g_slip_trail_start = 4.0;          // 滑点追踪启动距离
double   g_slip_trail_step = 1.0;           // 滑点追踪步长
double   g_slip_trail_limit = 3.0;          // 滑点追踪上限
bool     g_trail_from_entry = true;         // 从入场价还是虚拟止损价开始追踪
bool     g_friday_exit = false;             // 周五清仓
int      g_friday_exit_hour = 25;           // 周五清仓时间(禁用=25)
bool     g_store_on_friday = false;         // 周五存挂单
bool     g_nfp_filter = false;              // 非农数据过滤器
int      g_nfp_start_hour = 14;             // 非农过滤开始小时
int      g_nfp_end_hour = 17;               // 非农过滤结束小时
bool     g_show_spread_comment = false;     // 在图表显示点差信息
int      g_virtual_sl_mode = 1;             // 虚拟止损模式 (1=关闭, 2=基础, 3=高级)
double   g_extra_sl_distance = 0.0;         // 额外止损距离
int      g_refresh_interval = 99;           // 虚拟止损同步间隔(秒)
int      g_dayswitch_check = 5;             // 日切换等待分钟
int      g_dayswitch_minutes = 5;           // 日切换延迟
bool     g_one_trade_only = false;          // 只开一单模式
bool     g_margin_check = true;             // 保证金检查
int      g_entry_mode = 1;                  // 入场模式 (1=自动, 2=手动)
int      g_exit_check_mode = 0;             // 出场检查模式 (0=每tick, 1=M5, etc.)
int      g_max_orders_per_dir = 1;          // 每方向最大订单数
bool     g_close_beyond_entry_filter = false; // 收盘价穿越入场价过滤
int      g_compound_mode = 3;               // 复合模式

// --- 唐奇安通道参数 ---
int      g_entry_timeframe_D1 = 0;          // 日线级别分析周期
int      g_entry_timing_tf = 60;            // 入场时机周期(H1=60)
int      g_donchian_right_bars = 10;        // 唐奇安右侧确认K线数
int      g_donchian_left_bars = 3;          // 唐奇安左侧确认K线数
int      g_max_lookback_bars = 120;         // 最大回溯K线数
double   g_min_entry_distance = 30.0;       // 入场最小距离(点)
double   g_min_entry_distance_pct = 0.0;    // 入场最小距离(价格百分比)
double   g_buy_entry_offset = 0.5;          // 做多入场偏移
double   g_sell_entry_offset = 0.0;         // 做空入场偏移
double   g_duplicate_order_distance = 1.0;  // 重复订单判定距离
double   g_duplicate_sl_offset = 0.0;       // 重复SL偏移

// --- 止损止盈 ---
double   g_sl_points = 20.0;                // 止损点数
double   g_tp_points = 100.0;               // 止盈点数
int      g_lot_divisor = 100;               // 手数除数

// --- 追踪止损 ---
double   g_trail_sl_start = 10.0;           // 追踪止损启动距离
double   g_trail_sl_min_distance = 10.0;    // 追踪止损最小距离
double   g_trail_sl_max = 100.0;            // 追踪止损上限
double   g_trail_sl_step = 0.1;             // 追踪止损步长
double   g_trail_partial_close_pct = 0.0;   // 追踪时部分平仓比例

// --- 保本止损 ---
double   g_be_start = 0.0;                  // 保本启动距离
double   g_be_extra = 0.0;                  // 保本额外距离

// --- 高低点追踪止损 ---
bool     g_hl_trail_only_beyond_entry = false; // 仅入场价外的高低点追踪
int      g_hl_trail_timeframe = 0;          // 高低点追踪周期
int      g_hl_trail_max_bars = 0;           // 最大回溯K线
int      g_hl_trail_right_bars = 0;         // 右侧K线数
int      g_hl_trail_left_bars = 0;          // 左侧K线数
int      g_hl_trail_min_distance = 0;       // 最小距离
double   g_hl_trail_extra_distance = 2.0;   // 额外距离
double   g_hl_buy_trail = 0.0;              // 多头高低点追踪价位
double   g_hl_sell_trail = 0.0;             // 空头高低点追踪价位

// --- 时间恢复追踪止损 ---
double   g_recovery_trail_minutes = 0.0;    // 持仓X分钟后启动追踪
double   g_recovery_trail_size = 0.0;       // 恢复追踪大小
int      g_recovery_trail_seconds = 0;      // 恢复追踪秒数

// --- MagicTrail步进止损 ---
int      g_magic_trail_mode = 0;            // MagicTrail模式 (0=关, 1=开, 2=限制)
double   g_magic_trail_start = 0.1;         // 启动距离
int      g_magic_trail_ticks = 1;           // 触发tick数
double   g_magic_trail_step = 0.1;          // 每次步长
double   g_magic_trail_max = 1.0;           // 最大追踪距离
int      g_magic_trail_after_minutes = 0;   // X分钟后切换步长
double   g_magic_trail_after_size = 0.0;    // 切换后的步长
double   g_magic_trail_current = 0.0;       // 当前MagicTrail值
int      g_magic_trail_counter = 0;         // MagicTrail tick计数器
bool     g_trail_once = false;              // 只追踪一次

// --- Zone Recovery 马丁加仓 ---
bool     g_zone_recovery = false;           // 启用Zone Recovery
double   g_zone_start_distance = 50.0;      // 启动距离(点)
double   g_zone_step_distance = 10.0;       // 步进距离(点)
double   g_zone_min_distance = 5.0;         // 最小距离(点)
double   g_zone_profit_target = 0.0;        // 盈利目标
int      g_zone_lot_mult_type = 1;          // 加仓倍数类型 (1=固定, 2=线性, 3=指数)
double   g_zone_lot_multiplier = 2.0;       // 加仓倍数
int      g_zone_max_levels = 999;           // 最大加仓层数
int      g_zone_buy_magic = 900010;         // 多头Zone魔术号
int      g_zone_sell_magic = 900011;        // 空头Zone魔术号
int      g_zone_buy_toggle = 0;             // 多头方向切换
int      g_zone_sell_toggle = 0;            // 空头方向切换
bool     g_zone_buy_active = false;         // 多头Zone激活
bool     g_zone_sell_active = false;        // 空头Zone激活

// --- 手数/资金 ---
bool     g_use_risk_mode = false;           // 启用风险模式
double   g_lot_change_pct = 5.0;            // 手数调整触发比例
double   g_max_lotsize = 99.0;              // 最大手数限制
int      g_risk_dd_based = 99999;           // 基于回撤的手数模式
double   g_max_risk_dd_pct = 10.0;          // 最大回撤风险%
double   g_lotsize_array[99];               // 各策略当前手数

// --- 交易时段 ---
bool     g_use_trading_hours = false;       // 启用交易时段
int      g_time_source = 2;                 // 时间来源 (0=GMT, 1=电脑, 2=经纪商)
bool     g_store_pending_nontrading = false;// 非交易时段存储挂单
int      g_sun_start_hour = 0, g_sun_end_hour = 24;   // 周日交易时段
int      g_mon_start_hour = 0, g_mon_end_hour = 24;   // 周一
int      g_tue_start_hour = 0, g_tue_end_hour = 24;   // 周二
int      g_wed_start_hour = 0, g_wed_end_hour = 24;   // 周三
int      g_thu_start_hour = 0, g_thu_end_hour = 24;   // 周四
int      g_fri_start_hour = 0, g_fri_end_hour = 24;   // 周五

// --- 绩效追踪 ---
bool     g_performance_tracking = true;     // 启用绩效追踪
int      g_normalize_by_lots = 1;           // 按手数标准化
int      g_ranking_mode = 1;                // 排名模式 (1=总利润, 2=每笔利润)
int      g_perf_total_days = 90;            // 统计总天数
int      g_perf_recent_days = 30;           // 近期统计天数
int      g_perf_min_trades = 10;            // 最少交易数
int      g_perf_max_trades = 50;            // 最多交易数
bool     g_auto_disable = true;             // 自动禁用亏损策略

// --- 手动模式 ---
int      g_manual_symbol_filter = 1;        // 手动品种过滤
int      g_manual_magic = 0;                // 手动魔术号
string   g_manual_comment_filter = "";      // 手动注释过滤

// --- MA趋势过滤 ---
bool     g_use_ma_filter = false;           // 启用MA过滤
int      g_ma_fast_period = 1;              // 快线周期
int      g_ma_slow_period = 370;            // 慢线周期
int      g_ma_fast_handle = INVALID_HANDLE; // 快线指标句柄
int      g_ma_slow_handle = INVALID_HANDLE; // 慢线指标句柄
double   g_ma_fast_val = 0.0;               // 快线当前值
double   g_ma_slow_val = 0.0;               // 慢线当前值

//+------------------------------------------------------------------+
//| 全局变量 — 订单/价格追踪                                          |
//+------------------------------------------------------------------+
double   g_buy_entry_price = 0.0;           // 多头入场价
double   g_sell_entry_price = 0.0;          // 空头入场价
double   g_buy_entry_pending = 0.0;         // 多头挂单价
double   g_sell_entry_pending = 0.0;        // 空头挂单价
double   g_buy_donchian_high = 0.0;         // 唐奇安通道高点
double   g_sell_donchian_low = 0.0;         // 唐奇安通道低点
int      g_donchian_buy_bar = 0;            // 多头突破K线位置
int      g_donchian_sell_bar = 0;           // 空头突破K线位置
double   g_virtual_sl_price = 0.0;          // 虚拟止损价
double   g_stoplevel = 4.0;                 // 止损水平(价格距离)
double   g_freeze_level = 0.0;              // 冻结水平
double   g_point_value = 0.0;               // 点值(考虑3/5位报价)
double   g_tick_size = 0.0;                 // 最小变动单位
int      g_digits = 0;                      // 小数位数
int      g_random_slip_max = 0;             // 随机滑点最大值
bool     g_check_existing_buy = true;       // 检查已有买单

// --- 订单追踪数组 ---
double   g_virtual_sl_array[20][2];         // 虚拟止损追踪 [ticket, sl_price]
double   g_stored_pending[100][3];          // 存储的挂单 [price, type, lots]
double   g_order_tracker[100][2];           // 订单追踪 [ticket, entry_price]
int      g_virtual_sl_size = 20;            // 虚拟止损数组大小
int      g_stored_pending_size = 100;       // 存储挂单数组大小

// --- 策略运行状态 ---
int      g_strategy_index = 0;              // 当前策略索引(0-7)
int      g_magic_number = 0;                // 当前策略魔术号
int      g_expiration_hours = 24;           // 挂单过期小时
long     g_expiration_seconds = 0;          // 过期秒数
datetime g_order_expiry = 0;                // 订单过期时间
string   g_order_comment = "";              // 订单注释
string   g_symbol_name = "";                // 当前品种
datetime g_last_m5_time = 0;                // 上根M5时间
bool     g_init_ok = true;                  // 初始化成功
int      g_tick_counter = 0;                // Tick计数
double   g_last_balance = 0.0;              // 上次余额
bool     g_market_closed_warning = false;   // 市场关闭警告
bool     g_is_nontrading_hours = false;     // 非交易时段状态
bool     g_weekend_mode = false;            // 周末模式
bool     g_nfp_active = false;              // 非农活跃
datetime g_trail_timer = 0;                 // 追踪计时器
int      g_entry_bar_counter[99];           // 出场K线计数
int      g_entry_tf_bars[99];               // 入场周期K线数
datetime g_entry_time_array[99];            // 入场时间数组
int      g_last_bars;                       // 上次K线数
string   g_symbol_suffix;                   // 品种后缀
int      g_error_counter = 0;               // 错误计数
bool     g_new_buy_pending = false;         // 新买单挂单标志
bool     g_new_sell_pending = false;        // 新卖单挂单标志

// --- 绩效统计 ---
bool     g_strategy_active[99];             // 策略活跃状态
double   g_open_pl_array[30];               // 浮动盈亏
int      g_win_count_array[30];             // 盈利次数
int      g_loss_count_array[30];            // 亏损次数
double   g_total_pl_array[30];              // 总盈亏
int      g_perf_total_trades[99];           // 总交易数
int      g_perf_recent_trades[99];          // 近期交易数
double   g_perf_total_profit[99];           // 总利润
double   g_perf_recent_profit[99];          // 近期利润
double   g_perf_profit_per_trade[99];       // 每笔利润
double   g_perf_recent_per_trade[99];       // 近期每笔利润
int      g_ranking_array[99];               // 排名数组
int      g_sorted_indices[99];              // 排序索引
double   g_perf_factor[99];                 // 绩效因子
int      g_total_pairs = 0;                 // 品种总数
string   g_pair_names[99];                  // 品种名称列表

// --- 信息面板 ---
int      g_info_max_objects = 300;          // 面板最大对象数
double   g_info_panel_col_width;            // 面板列宽
double   g_info_panel_row_height;           // 面板行高
int      g_info_col;                        // 信息列计数

// --- 未使用/占位变量(原始代码残留) ---
string   g_comment_B1, g_comment_B2, g_comment_S1, g_comment_S2;
string   g_pair_list = "EURUSD;GBPUSD;USDJPY;AUDJPY;AUDUSD;EURAUD;EURCAD;EURGBP;EURJPY;GBPJPY;USDCAD;USDCHF;";
bool     g_flag_2, g_flag_5, g_flag_6, g_flag_44, g_flag_170;
bool     g_flag_187, g_flag_203, g_flag_215, g_flag_216, g_flag_217, g_flag_240;
int      g_flag_46, g_flag_47, g_flag_50, g_flag_51, g_flag_58, g_flag_59, g_flag_60;
int      g_flag_123, g_flag_124, g_flag_158, g_flag_159, g_flag_160, g_flag_161;
int      g_flag_162, g_flag_163, g_flag_164, g_flag_165, g_flag_166, g_flag_167;
int      g_flag_168, g_flag_169, g_flag_171=10, g_flag_172, g_flag_173, g_flag_174;
int      g_flag_175, g_flag_176, g_flag_177, g_flag_178, g_flag_179, g_flag_183;
int      g_flag_184, g_flag_188, g_flag_190, g_flag_191, g_flag_193, g_flag_194;
int      g_flag_195, g_flag_196, g_flag_197, g_flag_198, g_flag_199, g_flag_200;
int      g_flag_204, g_flag_205, g_flag_206, g_flag_207, g_flag_209, g_flag_210;
int      g_flag_211, g_flag_212, g_flag_213, g_flag_214_val, g_flag_220, g_flag_221;
int      g_flag_222, g_flag_223, g_flag_224, g_flag_225, g_flag_226, g_flag_227;
int      g_flag_229, g_flag_230, g_flag_231, g_flag_232, g_flag_241, g_flag_242;
int      g_flag_250, g_flag_258, g_flag_259, g_flag_352, g_flag_353, g_flag_354, g_flag_355;
double   g_flag_234, g_flag_243;
double   g_buy_entry_price_cache = 0.0;     // 多头入场缓存
double   g_sell_entry_price_cache = 0.0;    // 空头入场缓存
double   g_fractal_up = 0.0, g_fractal_down = 0.0;
double   g_fractal_up_prev = 0.0, g_fractal_down_prev = 0.0;

//+------------------------------------------------------------------+
//| MQL5 交易对象                                                      |
//+------------------------------------------------------------------+
#include <Trade/Trade.mqh>
CTrade   g_trade;

//+------------------------------------------------------------------+
//| 错误码 → 中文描述                                                  |
//+------------------------------------------------------------------+
string GetErrorDesc(int error_code)
{
   g_error_counter++;
   switch(error_code)
   {
      case 0:  case 1:  return "无错误";
      case 2:  return "通用错误";
      case 3:  return "无效的交易参数";
      case 4:  return "交易服务器繁忙";
      case 6:  return "未连接到交易服务器";
      case 8:  return "请求过于频繁";
      case 64: return "账户已禁用";
      case 65: return "无效账户";
      case 128: return "交易超时";
      case 129: return "无效价格";
      case 130: return "无效止损";
      case 131: return "无效交易量";
      case 132: return "市场已关闭";
      case 133: return "交易被禁用";
      case 134: return "资金不足";
      case 135: return "价格已变化";
      case 136: return "无报价";
      case 138: return "重新报价";
      case 139: return "订单已锁定";
      case 140: return "仅允许做多";
      case 141: return "请求过多";
      case 145: return "修改被拒绝(订单离市场太近)";
      case 146: return "交易上下文繁忙";
      case 147: return "经纪商拒绝过期";
      case 148: return "挂单数量已达上限";
      case 149: return "对冲被禁止";
      case 150: return "FIFO规则禁止";
      case 4002: return "数组索引越界";
      case 4003: return "函数调用栈内存不足";
      case 4013: return "除零错误";
      case 4105: return "未选中订单";
      case 4106: return "未知品种";
      case 4107: return "交易函数无效价格参数";
      case 4108: return "无效订单号";
      case 4109: return "EA属性不允许交易";
      case 4110: return "EA属性不允许做多";
      case 4111: return "EA属性不允许做空";
      case 4200: return "对象已存在";
      case 4202: return "对象不存在";
      default:  return "未知错误";
   }
}

//+------------------------------------------------------------------+
//| MQL4→MQL5 过期时间映射 (MQL4过期=0表示GTC永不过期)                  |
//+------------------------------------------------------------------+
ENUM_ORDER_TYPE_TIME GetTimeType()  { return (g_order_expiry == 0) ? ORDER_TIME_GTC : ORDER_TIME_SPECIFIED; }
datetime            GetExpiryTime() { return (g_order_expiry == 0) ? 0 : g_order_expiry; }

//+------------------------------------------------------------------+
//| MQL4→MQL5 时间框架转换 (MQL4用整数如60=H1, MQL5用枚举16385=H1)     |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES ToMQL5TF(int mql4_tf)
{
   switch(mql4_tf)
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
//| 获取价格数据 (MQL5 Copy系列, MQL4风格索引: 0=当前K线)             |
//+------------------------------------------------------------------+
double GetHigh(string symbol, ENUM_TIMEFRAMES tf, int bar_index)
{
   double highs[];
   ArraySetAsSeries(highs, true);
   if(CopyHigh(symbol, tf, 0, bar_index + 1, highs) > 0)
      return highs[bar_index];
   return 0.0;
}

double GetLow(string symbol, ENUM_TIMEFRAMES tf, int bar_index)
{
   double lows[];
   ArraySetAsSeries(lows, true);
   if(CopyLow(symbol, tf, 0, bar_index + 1, lows) > 0)
      return lows[bar_index];
   return 0.0;
}

double GetClose(string symbol, ENUM_TIMEFRAMES tf, int bar_index)
{
   double closes[];
   ArraySetAsSeries(closes, true);
   if(CopyClose(symbol, tf, 0, bar_index + 1, closes) > 0)
      return closes[bar_index];
   return 0.0;
}

datetime GetTimeBar(string symbol, ENUM_TIMEFRAMES tf, int bar_index)
{
   datetime times[];
   ArraySetAsSeries(times, true);
   if(CopyTime(symbol, tf, 0, bar_index + 1, times) > 0)
      return times[bar_index];
   return 0;
}

int GetBarsCount(string symbol, ENUM_TIMEFRAMES tf)
{
   return Bars(symbol, tf);
}

//+------------------------------------------------------------------+
//| 检查是否在交易时段内                                                |
//+------------------------------------------------------------------+
bool IsTradingHours()
{
   if(!g_use_trading_hours)
      return true;

   bool result = false;
   datetime dt = 0;

   // 根据时间来源获取当前时间
   if(g_time_source == 2)       dt = TimeCurrent();      // 经纪商时间
   else if(g_time_source == 0)  dt = TimeGMT();           // GMT时间
   else if(g_time_source == 1)  dt = TimeLocal();         // 本机时间

   MqlDateTime mdt;
   TimeToStruct(dt, mdt);
   int hour = mdt.hour;
   int dow = mdt.day_of_week;

   // 检查每天的交易时段 (MQL5不支持lambda,用内联函数替代)
   if(dow == 0) { if(g_sun_start_hour < g_sun_end_hour) { if(!(hour < g_sun_start_hour || hour >= g_sun_end_hour)) result = true; } else if(g_sun_start_hour > g_sun_end_hour) { if(!(hour < g_sun_start_hour && hour >= g_sun_end_hour)) result = true; } }
   if(dow == 1) { if(g_mon_start_hour < g_mon_end_hour) { if(!(hour < g_mon_start_hour || hour >= g_mon_end_hour)) result = true; } else if(g_mon_start_hour > g_mon_end_hour) { if(!(hour < g_mon_start_hour && hour >= g_mon_end_hour)) result = true; } }
   if(dow == 2) { if(g_tue_start_hour < g_tue_end_hour) { if(!(hour < g_tue_start_hour || hour >= g_tue_end_hour)) result = true; } else if(g_tue_start_hour > g_tue_end_hour) { if(!(hour < g_tue_start_hour && hour >= g_tue_end_hour)) result = true; } }
   if(dow == 3) { if(g_wed_start_hour < g_wed_end_hour) { if(!(hour < g_wed_start_hour || hour >= g_wed_end_hour)) result = true; } else if(g_wed_start_hour > g_wed_end_hour) { if(!(hour < g_wed_start_hour && hour >= g_wed_end_hour)) result = true; } }
   if(dow == 4) { if(g_thu_start_hour < g_thu_end_hour) { if(!(hour < g_thu_start_hour || hour >= g_thu_end_hour)) result = true; } else if(g_thu_start_hour > g_thu_end_hour) { if(!(hour < g_thu_start_hour && hour >= g_thu_end_hour)) result = true; } }
   if(dow == 5) { if(g_fri_start_hour < g_fri_end_hour) { if(!(hour < g_fri_start_hour || hour >= g_fri_end_hour)) result = true; } else if(g_fri_start_hour > g_fri_end_hour) { if(!(hour < g_fri_start_hour && hour >= g_fri_end_hour)) result = true; } }

   return result;
}

//+------------------------------------------------------------------+
//| 唐奇安通道 — 寻找做多突破高点 (原 ccbsw_10)                         |
//| 逻辑: 在日线级别找左侧N根+右侧M根K线内的最高点，作为BuyStop挂单位置    |
//+------------------------------------------------------------------+
double FindDonchianBuyEntry(ENUM_TIMEFRAMES tf)
{
   bool found = false;
   bool check_right, check_left;
   int bar = g_donchian_left_bars + 1;  // 从左侧K线数+1开始扫描

   while(true)
   {
      check_right = true;
      check_left = true;

      // 检查左侧K线: 当前bar必须是[-left_bars, bar]范围内的最高点
      for(int i = bar; i >= bar - g_donchian_left_bars; i--)
      {
         if(GetHigh(g_symbol_name, tf, i) > GetHigh(g_symbol_name, tf, bar))
            { check_left = false; break; }
      }

      // 检查右侧K线: 当前bar必须是[bar, bar+right_bars]范围内的最高点
      for(int i = bar; i <= bar + g_donchian_right_bars; i++)
      {
         if(GetHigh(g_symbol_name, tf, i) > GetHigh(g_symbol_name, tf, bar))
            { check_right = false; break; }
      }

      // 如果左右都确认 + 高点距离当前价足够远
      if(check_left && check_right &&
         GetHigh(g_symbol_name, tf, bar) > g_min_entry_distance * g_point_value + SymbolInfoDouble(g_symbol_name, SYMBOL_ASK))
      {
         double high_val = GetHigh(g_symbol_name, tf, bar);
         int lookback = bar;

         // 确认当前周期内没有更高的高点(从bar0到当前bar)
         double highest = GetHigh(g_symbol_name, PERIOD_CURRENT, 0);
         for(int i = 1; i <= lookback; i++)
         {
            double h = GetHigh(g_symbol_name, PERIOD_CURRENT, i);
            if(h > highest) highest = h;
         }

         if(high_val >= highest)
         {
            double entry_price = NormalizeDouble(high_val, g_digits);

            // 检查是否已有相同位置的挂单(防重复)
            bool duplicate = false;
            for(int i = OrdersTotal(); i >= 0; i--)
            {
               ulong ticket = OrderGetTicket(i);
               if(ticket == 0) continue;
               if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
               if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
               if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_BUY_STOP) continue;
               if(MathAbs(OrderGetDouble(ORDER_PRICE_OPEN) - (g_buy_entry_offset * g_point_value + entry_price))
                  < g_duplicate_order_distance * g_point_value)
                  { duplicate = true; break; }
            }

            if(!duplicate)
            {
               // 可选的收盘价过滤器: 前一根K线收盘价不能离突破点太近
               if(!g_close_beyond_entry_filter ||
                  !(GetClose(g_symbol_name, tf, bar - 1) > GetHigh(g_symbol_name, tf, bar) - g_min_entry_distance * g_point_value))
               {
                  found = true;
                  g_buy_donchian_high = NormalizeDouble(high_val, g_digits);
                  g_donchian_buy_bar = bar;
                  break;
               }
            }
         }
      }

      bar++;
      if(bar > g_max_lookback_bars)       // 超过最大回溯范围,放弃
      {
         g_buy_donchian_high = 0.0;
         break;
      }
   }

   return g_buy_donchian_high;
}

//+------------------------------------------------------------------+
//| 唐奇安通道 — 寻找做空突破低点 (原 ccbsw_11)                         |
//| 逻辑: 与做多对称,找左侧N根+右侧M根K线内的最低点作为SellStop挂单位置     |
//+------------------------------------------------------------------+
double FindDonchianSellEntry(ENUM_TIMEFRAMES tf)
{
   bool found = false;
   bool check_right, check_left;
   int bar = g_donchian_left_bars + 1;

   while(true)
   {
      check_right = true;
      check_left = true;

      // 检查左侧K线: 当前bar必须是[-left_bars, bar]范围内的最低点
      for(int i = bar; i >= bar - g_donchian_left_bars; i--)
      {
         if(GetLow(g_symbol_name, tf, i) < GetLow(g_symbol_name, tf, bar))
            { check_left = false; break; }
      }

      // 检查右侧K线: 当前bar必须是[bar, bar+right_bars]范围内的最低点
      for(int i = bar; i <= bar + g_donchian_right_bars; i++)
      {
         if(GetLow(g_symbol_name, tf, i) < GetLow(g_symbol_name, tf, bar))
            { check_right = false; break; }
      }

      if(check_left && check_right &&
         GetLow(g_symbol_name, tf, bar) < SymbolInfoDouble(g_symbol_name, SYMBOL_BID) - g_min_entry_distance * g_point_value)
      {
         double low_val = GetLow(g_symbol_name, tf, bar);
         int lookback = bar;

         // 确认当前周期内没有更低的低点
         double lowest = GetLow(g_symbol_name, PERIOD_CURRENT, 0);
         for(int i = 1; i <= lookback; i++)
         {
            double l = GetLow(g_symbol_name, PERIOD_CURRENT, i);
            if(l < lowest) lowest = l;
         }

         if(low_val <= lowest)
         {
            double entry_price = NormalizeDouble(low_val, g_digits);

            // 防重复检查
            bool duplicate = false;
            for(int i = OrdersTotal(); i >= 0; i--)
            {
               ulong ticket = OrderGetTicket(i);
               if(ticket == 0) continue;
               if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
               if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
               if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_SELL_STOP) continue;
               if(MathAbs(OrderGetDouble(ORDER_PRICE_OPEN) - (entry_price - g_sell_entry_offset * g_point_value))
                  < g_duplicate_order_distance * g_point_value)
                  { duplicate = true; break; }
            }

            if(!duplicate)
            {
               if(!g_close_beyond_entry_filter ||
                  !(GetClose(g_symbol_name, tf, bar - 1) < g_min_entry_distance * g_point_value + GetLow(g_symbol_name, tf, bar)))
               {
                  found = true;
                  g_sell_donchian_low = NormalizeDouble(low_val, g_digits);
                  g_donchian_sell_bar = bar;
                  break;
               }
            }
         }
      }

      bar++;
      if(bar > g_max_lookback_bars)
      {
         g_sell_donchian_low = 0.0;
         break;
      }
   }

   return g_sell_donchian_low;
}

//+------------------------------------------------------------------+
//| 高低点追踪 — 找做多方向的高点 (原 ccbsw_12)                         |
//+------------------------------------------------------------------+
double FindHLTrailHigh(ENUM_TIMEFRAMES tf, int right_bars, int left_bars)
{
   double result = 0.0;
   int bar = left_bars + 1;

   while(true)
   {
      bool check_right = true, check_left = true;

      for(int i = bar; i >= bar - left_bars; i--)
         if(GetHigh(g_symbol_name, tf, i) > GetHigh(g_symbol_name, tf, bar))
            { check_left = false; break; }

      for(int i = bar; i <= bar + right_bars; i++)
         if(GetHigh(g_symbol_name, tf, i) > GetHigh(g_symbol_name, tf, bar))
            { check_right = false; break; }

      if(check_left && check_right &&
         GetHigh(g_symbol_name, tf, bar) > g_stoplevel * g_point_value + SymbolInfoDouble(g_symbol_name, SYMBOL_ASK))
      {
         result = NormalizeDouble(GetHigh(g_symbol_name, tf, bar), g_digits);
         break;
      }

      bar++;
      if(bar > g_hl_trail_max_bars) { result = 9999.0; break; }
   }

   return result;
}

//+------------------------------------------------------------------+
//| 高低点追踪 — 找做空方向的低点 (原 ccbsw_13)                         |
//+------------------------------------------------------------------+
double FindHLTrailLow(ENUM_TIMEFRAMES tf, int right_bars, int left_bars)
{
   double result = 0.0;
   int bar = left_bars + 1;

   while(true)
   {
      bool check_right = true, check_left = true;

      for(int i = bar; i >= bar - left_bars; i--)
         if(GetLow(g_symbol_name, tf, i) < GetLow(g_symbol_name, tf, bar))
            { check_left = false; break; }

      for(int i = bar; i <= bar + right_bars; i++)
         if(GetLow(g_symbol_name, tf, i) < GetLow(g_symbol_name, tf, bar))
            { check_right = false; break; }

      if(check_left && check_right &&
         GetLow(g_symbol_name, tf, bar) < SymbolInfoDouble(g_symbol_name, SYMBOL_BID) - g_stoplevel * g_point_value)
      {
         result = NormalizeDouble(GetLow(g_symbol_name, tf, bar), g_digits);
         break;
      }

      bar++;
      if(bar > g_hl_trail_max_bars) { result = 0.0; break; }
   }

   return result;
}

//+------------------------------------------------------------------+
//| 手数计算 (原 ccbsw_9)                                              |
//| 支持: 固定手数 / 按风险% / 按余额步进 / 按回撤风险                   |
//+------------------------------------------------------------------+
void CalculateLotSize(double sl_points, int lot_divisor)
{
   double current_lot = g_lotsize_array[g_strategy_index];
   double new_lot = current_lot;
   double balance = UseEquity ? AccountInfoDouble(ACCOUNT_EQUITY) : AccountInfoDouble(ACCOUNT_BALANCE);

   // 3/5位经纪商: 点数除以10
   double sl_pips = sl_points;
   if(g_digits == 2 || g_digits == 4)
      sl_pips = sl_points / 10.0;

   double lotstep = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP);
   double tick_value = SymbolInfoDouble(g_symbol_name, SYMBOL_TRADE_TICK_VALUE);

   // 根据风险模式计算手数
   if(Risk < 999 && Risk > 0)  // 小额风险模式
   {
      double risk_amount = (double)Risk / 1000.0 * balance;
      if(lotstep == 0.1)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * (risk_amount / (tick_value * sl_pips) * 0.1), 1);
      else if(lotstep == 0.01)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * (risk_amount / (tick_value * sl_pips) * 0.1), 2);
   }
   else if(Risk == 999)  // 每笔风险百分比
   {
      double risk_amount = Manual_RiskPerTrade / 100.0 * balance;
      if(lotstep == 0.1)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * (risk_amount / (tick_value * sl_pips) * 0.1), 1);
      else if(lotstep == 0.01)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * (risk_amount / (tick_value * sl_pips) * 0.1), 2);
   }
   else if(Risk == 0)  // 固定手数
   {
      if(lotstep == 0.1)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * StartLots, 1);
      else if(lotstep == 0.01)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * StartLots, 2);
   }
   else if(Risk == 9999)  // 按余额步进
   {
      if(lotstep == 0.1)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * (balance / LotPerBalance_step * 0.01), 1);
      else if(lotstep == 0.01)
         new_lot = NormalizeDouble(lot_divisor * 0.01 * (balance / LotPerBalance_step * 0.01), 2);
   }
   else if(Risk == 99999)  // 按最大回撤风险
   {
      if(SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP) == 0.1)
         new_lot = NormalizeDouble(g_max_risk_dd_pct / g_tick_size * balance / 100.0 * 0.01, 1);
      else if(SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP) == 0.01)
         new_lot = NormalizeDouble(g_max_risk_dd_pct / g_tick_size * balance / 100.0 * 0.01, 2);
   }

   // 手数边界检查
   double min_lot = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MIN);
   if(new_lot < min_lot)       new_lot = min_lot;
   if(new_lot < StartLots)     new_lot = StartLots;
   if(new_lot > g_max_lotsize) new_lot = g_max_lotsize;

   // OnlyUp模式: 只增不减
   if(OnlyUp && new_lot < current_lot)
      new_lot = current_lot;

   // 输出警告
   if(new_lot < min_lot)
      Print("⚠ 最小手数(", g_symbol_name, ") = ", min_lot, " 手!");

   double max_lot = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MAX);
   if(new_lot > max_lot && max_lot != 0.0)
   {
      Print("⚠ 最大手数(", g_symbol_name, ") = ", max_lot, " 手!");
      new_lot = max_lot;
   }

   // 按步进取整
   if(lotstep == 0.1)
      g_lotsize_array[g_strategy_index] = NormalizeDouble(MathFloor(new_lot * 10.0) / 10.0, 1);
   else
      g_lotsize_array[g_strategy_index] = NormalizeDouble(MathFloor(new_lot * 100.0) / 100.0, 2);
}

//+------------------------------------------------------------------+
//| 下BuyStop挂单 (原 ccbsw_14)                                        |
//| 在唐奇安高点上方放置突破买入挂单                                     |
//+------------------------------------------------------------------+
bool PlaceBuyStop(int mode)
{
   // 如果已有市价多单则不再挂单
   if(!g_check_existing_buy)
   {
      for(int i = 0; i < OrdersTotal(); i++)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_BUY) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         return false; // 已有市价多单,不再挂
      }
   }

   // MA趋势过滤: 快线 < 慢线 = 空头趋势, 不过滤做多
   if(g_use_ma_filter && g_ma_fast_val < g_ma_slow_val)
      return false;

   if(mode == 1)
   {
      ENUM_TIMEFRAMES entry_tf = ToMQL5TF(g_entry_timeframe_D1);
      FindDonchianBuyEntry(entry_tf);

      double high_val = g_buy_donchian_high;
      if(high_val == 0.0) return false;

      // 检查是否已有相似挂单
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_BUY_STOP) continue;
         if(MathAbs(OrderGetDouble(ORDER_PRICE_OPEN) - (g_buy_entry_offset * g_point_value + high_val))
            < g_duplicate_order_distance * g_point_value)
            return false; // 已有相似挂单
      }

      // 检查是否已达最大挂单数
      int buy_stop_cnt = 0;
      double highest_open = 0.0;
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_BUY_STOP) continue;
         buy_stop_cnt++;
         double op = OrderGetDouble(ORDER_PRICE_OPEN);
         if(op > highest_open) highest_open = op;
      }
      if(buy_stop_cnt == g_max_orders_per_dir && g_buy_donchian_high > highest_open)
         return false; // 已满且新价位更低

      g_buy_entry_pending = g_buy_donchian_high;
      g_buy_entry_price = NormalizeDouble(g_buy_donchian_high, g_digits);

      // 设置MagicTrail起始值
      g_magic_trail_current = g_magic_trail_start;

      // 计算挂单价格 = 突破高点 + 偏移
      double entry_price = NormalizeDouble(g_buy_entry_offset * g_point_value + g_buy_entry_price, g_digits);
      g_buy_entry_price_cache = entry_price;

      if(!g_one_trade_only)
      {
         // 保证金检查
         if(g_margin_check)
         {
            double margin = 0.0;
            if(!OrderCalcMargin(ORDER_TYPE_BUY_STOP, g_symbol_name, g_lotsize_array[g_strategy_index], entry_price, margin))
               return false;
            if(AccountInfoDouble(ACCOUNT_FREEMARGIN) <= 0.0)
            {
               Print("⚠ 保证金不足, 手数=", g_lotsize_array[g_strategy_index]);
               return false;
            }
         }

         double sl_price = NormalizeDouble(entry_price - (g_sl_points + g_extra_sl_distance) * g_point_value, g_digits);
         double tp_price = NormalizeDouble(g_tp_points * g_point_value + entry_price, g_digits);
         double vol = g_lotsize_array[g_strategy_index];

         // 手数合法性检查
         double vol_min = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MIN);
         double vol_max = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MAX);
         double vol_step = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP);
         bool vol_ok = true;
         if(vol < vol_min) { Print("⚠ 手数 < 最小手数=", vol_min); vol_ok = false; }
         else if(vol > vol_max) { Print("⚠ 手数 > 最大手数=", vol_max); vol_ok = false; }
         else if(MathAbs(MathRound(vol / vol_step) * vol_step - vol) > 0.0000001)
            { Print("⚠ 手数不是步长的倍数, step=", vol_step); vol_ok = false; }

         int limit_orders = (int)AccountInfoInteger(ACCOUNT_LIMIT_ORDERS);
         bool orders_ok = (limit_orders == 0) || (OrdersTotal() < limit_orders);
         if(!vol_ok || !orders_ok) return false;

         double ask = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK);
         double slip_price = NormalizeDouble(g_random_slippage * g_point_value + entry_price, g_digits);

         // 当前价必须低于挂单价 + 冻结/止损水平
         if(ask < entry_price - g_freeze_level * g_point_value &&
            ask < entry_price - g_stoplevel * g_point_value)
         {
            g_trade.SetExpertMagicNumber(g_magic_number);

            if(!setSL_TP_After_Entry)
               g_trade.BuyStop(vol, slip_price, g_symbol_name, sl_price, tp_price,
                               GetTimeType(), GetExpiryTime(), g_order_comment);
            else
               g_trade.BuyStop(vol, slip_price, g_symbol_name, 0.0, 0.0,
                               GetTimeType(), GetExpiryTime(), g_order_comment);

            g_new_buy_pending = false;

            if(g_trade.ResultRetcode() == TRADE_RETCODE_DONE)
            {
               // 存入订单追踪器
               for(int i = 0; i < 100; i++)
               {
                  if(g_order_tracker[i][0] == 0.0)
                  {
                     g_order_tracker[i][0] = (double)g_trade.ResultOrder();
                     g_order_tracker[i][1] = entry_price;
                     break;
                  }
               }
            }
            else
               Print("✗ 下单失败: ", GetErrorDesc(g_trade.ResultRetcode()));
         }
      }
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| 下SellStop挂单 (原 ccbsw_15)                                       |
//| 在唐奇安低点下方放置突破卖出挂单                                     |
//+------------------------------------------------------------------+
bool PlaceSellStop(int mode)
{
   // 如果已有市价空单则不再挂单
   if(!g_check_existing_buy)
   {
      for(int i = 0; i < OrdersTotal(); i++)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_SELL) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         return false;
      }
   }

   // MA趋势过滤: 快线 > 慢线 = 多头趋势, 不过滤做空
   if(g_use_ma_filter && g_ma_fast_val > g_ma_slow_val)
      return false;

   if(mode == 1)
   {
      ENUM_TIMEFRAMES entry_tf = ToMQL5TF(g_entry_timeframe_D1);
      FindDonchianSellEntry(entry_tf);

      double low_val = g_sell_donchian_low;
      if(low_val == 0.0) return false;

      // 检查是否已有相似挂单
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_SELL_STOP) continue;
         if(MathAbs(OrderGetDouble(ORDER_PRICE_OPEN) - (low_val - g_sell_entry_offset * g_point_value))
            < g_duplicate_order_distance * g_point_value)
            return false;
      }

      // 检查是否已达最大挂单数
      int sell_stop_cnt = 0;
      double lowest_open = 9999.0;
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_SELL_STOP) continue;
         sell_stop_cnt++;
         double op = OrderGetDouble(ORDER_PRICE_OPEN);
         if(op < lowest_open) lowest_open = op;
      }
      if(sell_stop_cnt == g_max_orders_per_dir && g_sell_donchian_low < lowest_open)
         return false;

      g_sell_entry_pending = g_sell_donchian_low;
      g_sell_entry_price = NormalizeDouble(g_sell_donchian_low, g_digits);
      g_magic_trail_current = g_magic_trail_start;

      double entry_price = NormalizeDouble(g_sell_entry_price - g_sell_entry_offset * g_point_value, g_digits);
      g_sell_entry_price_cache = entry_price;

      if(!g_one_trade_only)
      {
         if(g_margin_check)
         {
            double margin = 0.0;
            if(!OrderCalcMargin(ORDER_TYPE_SELL_STOP, g_symbol_name, g_lotsize_array[g_strategy_index], entry_price, margin))
               return false;
            if(AccountInfoDouble(ACCOUNT_FREEMARGIN) <= 0.0)
            {
               Print("⚠ 保证金不足, 手数=", g_lotsize_array[g_strategy_index]);
               return false;
            }
         }

         double sl_price = NormalizeDouble((g_sl_points + g_extra_sl_distance) * g_point_value + entry_price, g_digits);
         double tp_price = NormalizeDouble(entry_price - g_tp_points * g_point_value, g_digits);
         double vol = g_lotsize_array[g_strategy_index];

         double vol_min = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MIN);
         double vol_max = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MAX);
         double vol_step = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP);
         bool vol_ok = true;
         if(vol < vol_min) { Print("⚠ 手数 < 最小手数=", vol_min); vol_ok = false; }
         else if(vol > vol_max) { Print("⚠ 手数 > 最大手数=", vol_max); vol_ok = false; }
         else if(MathAbs(MathRound(vol / vol_step) * vol_step - vol) > 0.0000001)
            { Print("⚠ 手数不是步长的倍数, step=", vol_step); vol_ok = false; }

         int limit_orders = (int)AccountInfoInteger(ACCOUNT_LIMIT_ORDERS);
         bool orders_ok = (limit_orders == 0) || (OrdersTotal() < limit_orders);
         if(!vol_ok || !orders_ok) return false;

         double bid = SymbolInfoDouble(g_symbol_name, SYMBOL_BID);
         double slip_price = NormalizeDouble(entry_price - g_random_slippage * g_point_value, g_digits);

         if(bid > g_freeze_level * g_point_value + entry_price &&
            bid > g_stoplevel * g_point_value + entry_price)
         {
            g_trade.SetExpertMagicNumber(g_magic_number);

            if(!setSL_TP_After_Entry)
               g_trade.SellStop(vol, slip_price, g_symbol_name, sl_price, tp_price,
                                GetTimeType(), GetExpiryTime(), g_order_comment);
            else
               g_trade.SellStop(vol, slip_price, g_symbol_name, 0.0, 0.0,
                                GetTimeType(), GetExpiryTime(), g_order_comment);

            g_new_sell_pending = false;

            if(g_trade.ResultRetcode() == TRADE_RETCODE_DONE)
            {
               for(int i = 0; i < 100; i++)
               {
                  if(g_order_tracker[i][0] == 0.0)
                  {
                     g_order_tracker[i][0] = (double)g_trade.ResultOrder();
                     g_order_tracker[i][1] = entry_price;
                     break;
                  }
               }
            }
            else
               Print("✗ 下单失败: ", GetErrorDesc(g_trade.ResultRetcode()));
         }
      }
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| 存储挂单 (价差过大时暂存, 待恢复)                                    |
//+------------------------------------------------------------------+
void StorePendingOrders()
{
   int idx = 0;
   for(int i = OrdersTotal(); i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
      if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_STOP && type != ORDER_TYPE_SELL_STOP) continue;

      Print("📦 存储挂单 #", ticket);
      g_stored_pending[idx][1] = (double)type;
      g_stored_pending[idx][0] = OrderGetDouble(ORDER_PRICE_OPEN);
      g_stored_pending[idx][2] = OrderGetDouble(ORDER_VOLUME_CURRENT);
      idx++;
   }
}

//+------------------------------------------------------------------+
//| 删除当前策略所有挂单                                                |
//+------------------------------------------------------------------+
void DeleteAllPendingOrders()
{
   for(int i = OrdersTotal(); i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
      if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_STOP && type != ORDER_TYPE_SELL_STOP) continue;
      g_trade.OrderDelete(ticket);
   }
}

//+------------------------------------------------------------------+
//| 恢复存储的挂单 (原 ccbsw_7)                                        |
//+------------------------------------------------------------------+
void RestorePendingOrders()
{
   double ask = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK);
   double bid = SymbolInfoDouble(g_symbol_name, SYMBOL_BID);

   for(int i = 0; i < g_stored_pending_size; i++)
   {
      if(g_stored_pending[i][0] <= 0.0) continue;

      // 恢复BuyStop (type=4): 当前卖价必须低于挂单价
      if(g_stored_pending[i][1] == 4.0 && ask < g_stored_pending[i][0] - g_stoplevel)
      {
         Print("📦 恢复BuyStop挂单");
         double sl = g_stored_pending[i][0] - (g_sl_points + g_extra_sl_distance) * g_point_value;
         double tp = g_tp_points * g_point_value + g_stored_pending[i][0];

         g_trade.SetExpertMagicNumber(g_magic_number);
         g_trade.BuyStop(g_stored_pending[i][2], g_stored_pending[i][0], g_symbol_name,
                         sl, tp, ORDER_TIME_SPECIFIED, (datetime)((long)g_order_expiry + 172800), g_order_comment);
         g_new_buy_pending = false;

         if(g_trade.ResultRetcode() == TRADE_RETCODE_DONE)
         {
            for(int j = 0; j < 100; j++)
            {
               if(g_order_tracker[j][0] == 0.0)
               {
                  g_order_tracker[j][0] = (double)g_trade.ResultOrder();
                  g_order_tracker[j][1] = g_stored_pending[i][0];
                  break;
               }
            }
         }
         else
            Print("✗ 恢复BuyStop失败: ", GetErrorDesc(g_trade.ResultRetcode()));
      }

      // 恢复SellStop (type=5): 当前买价必须高于挂单价
      if(g_stored_pending[i][1] == 5.0 && bid > g_stored_pending[i][0] + g_stoplevel)
      {
         Print("📦 恢复SellStop挂单");
         double sl = (g_sl_points + g_extra_sl_distance) * g_point_value + g_stored_pending[i][0];
         double tp = g_stored_pending[i][0] - g_tp_points * g_point_value;

         g_trade.SetExpertMagicNumber(g_magic_number);
         g_trade.SellStop(g_stored_pending[i][2], g_stored_pending[i][0], g_symbol_name,
                          sl, tp, ORDER_TIME_SPECIFIED, (datetime)((long)g_order_expiry + 172800), g_order_comment);
         g_new_sell_pending = false;

         if(g_trade.ResultRetcode() == TRADE_RETCODE_DONE)
         {
            for(int j = 0; j < 100; j++)
            {
               if(g_order_tracker[j][0] == 0.0)
               {
                  g_order_tracker[j][0] = (double)g_trade.ResultOrder();
                  g_order_tracker[j][1] = g_stored_pending[i][0];
                  break;
               }
            }
         }
         else
            Print("✗ 恢复SellStop失败: ", GetErrorDesc(g_trade.ResultRetcode()));
      }
   }

   // 清空存储数组
   for(int i = 0; i < g_stored_pending_size; i++)
   {
      g_stored_pending[i][0] = 0.0;
      g_stored_pending[i][1] = 0.0;
      g_stored_pending[i][2] = 0.0;
   }
}

//+------------------------------------------------------------------+
//| 处理点差过大导致的挂单问题 (原 ccbsw_8)                              |
//| 如果挂单太接近市场价(点差过大),则存储或删除                           |
//+------------------------------------------------------------------+
bool HandleSpreadPendingOrders()
{
   double ask = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK);
   double bid = SymbolInfoDouble(g_symbol_name, SYMBOL_BID);

   for(int i = OrdersTotal(); i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != g_magic_number && OrderGetInteger(ORDER_MAGIC) != g_manual_magic) continue;
      if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;

      // BuyStop离市场太近
      if(OrderGetInteger(ORDER_TYPE) == ORDER_TYPE_BUY_STOP &&
         OrderGetDouble(ORDER_PRICE_OPEN) < g_spread_distance * g_point_value + ask &&
         ask > OrderGetDouble(ORDER_PRICE_OPEN) - g_freeze_level)
      {
         if(g_max_spread_for_store > 0.0)
         {
            Print("⚠ 点差过大(", g_spread, ") 存储并删除BuyStop #", ticket);
            for(int j = 0; j < g_stored_pending_size; j++)
            {
               if(g_stored_pending[j][0] == 0.0)
               {
                  g_stored_pending[j][1] = (double)OrderGetInteger(ORDER_TYPE);
                  g_stored_pending[j][0] = OrderGetDouble(ORDER_PRICE_OPEN);
                  g_stored_pending[j][2] = OrderGetDouble(ORDER_VOLUME_CURRENT);
                  break;
               }
            }
         }
         else
            Print("⚠ 点差过大(", g_spread, ") 删除BuyStop #", ticket);

         // 从追踪器中移除
         for(int j = 0; j < 100; j++)
            if(g_order_tracker[j][0] == (double)ticket)
               { g_order_tracker[j][0] = 0.0; g_order_tracker[j][1] = 0.0; break; }
         g_trade.OrderDelete(ticket);
      }

      // SellStop离市场太近
      if(OrderGetInteger(ORDER_TYPE) == ORDER_TYPE_SELL_STOP)
      {
         double op = OrderGetDouble(ORDER_PRICE_OPEN);
         if(!(op > bid - g_spread_distance * g_point_value)) continue;
         if(!(bid > op + g_freeze_level)) continue;

         if(g_max_spread_for_store > 0.0)
         {
            Print("⚠ 点差过大(", g_spread, ") 存储并删除SellStop #", ticket);
            for(int j = 0; j < g_stored_pending_size; j++)
            {
               if(g_stored_pending[j][0] == 0.0)
               {
                  g_stored_pending[j][1] = (double)OrderGetInteger(ORDER_TYPE);
                  g_stored_pending[j][0] = op;
                  g_stored_pending[j][2] = OrderGetDouble(ORDER_VOLUME_CURRENT);
                  break;
               }
            }
         }
         else
            Print("⚠ 点差过大(", g_spread, ") 删除SellStop #", ticket);

         for(int j = 0; j < 100; j++)
            if(g_order_tracker[j][0] == (double)ticket)
               { g_order_tracker[j][0] = 0.0; g_order_tracker[j][1] = 0.0; break; }
         g_trade.OrderDelete(ticket);
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| 余额变化时调整挂单手数 (原 ccbsw_20)                                 |
//+------------------------------------------------------------------+
void AdjustLotSizesOnBalanceChange(bool force_update)
{
   double change_pct = g_lot_change_pct / 100.0 + 1.0;
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);

   if(balance == g_last_balance && !force_update) return;
   if(!(balance > g_last_balance * change_pct) &&
      !(balance < g_last_balance / change_pct) && !force_update) return;

   CalculateLotSize(g_sl_points, g_lot_divisor);

   // 遍历所有挂单,手数变化则重建
   for(int i = OrdersTotal(); i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
      if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;

      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);

      // 内联重建挂单逻辑(MQL5不支持lambda)
      if(type == ORDER_TYPE_BUY_STOP && OrderGetDouble(ORDER_VOLUME_CURRENT) != g_lotsize_array[g_strategy_index])
      {
         double old_sl = OrderGetDouble(ORDER_SL);
         double old_tp = OrderGetDouble(ORDER_TP);
         double old_open = OrderGetDouble(ORDER_PRICE_OPEN);
         datetime old_expiry = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
         string old_comment = OrderGetString(ORDER_COMMENT);
         ulong old_ticket = ticket;

         g_trade.OrderDelete(ticket);
         g_trade.SetExpertMagicNumber(g_magic_number);
         g_trade.BuyStop(g_lotsize_array[g_strategy_index], old_open, g_symbol_name,
                         old_sl, old_tp, ORDER_TIME_SPECIFIED, old_expiry, old_comment);

         for(int j = 0; j < 100; j++)
            if(g_order_tracker[j][0] == (double)old_ticket)
               { g_order_tracker[j][0] = (double)g_trade.ResultOrder(); break; }

         Print("📊 手数变化 >", g_lot_change_pct, "%, 调整BuyStop手数");
      }

      if(type == ORDER_TYPE_SELL_STOP && OrderGetDouble(ORDER_VOLUME_CURRENT) != g_lotsize_array[g_strategy_index])
      {
         double old_sl = OrderGetDouble(ORDER_SL);
         double old_tp = OrderGetDouble(ORDER_TP);
         double old_open = OrderGetDouble(ORDER_PRICE_OPEN);
         datetime old_expiry = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
         string old_comment = OrderGetString(ORDER_COMMENT);
         ulong old_ticket = ticket;

         g_trade.OrderDelete(ticket);
         g_trade.SetExpertMagicNumber(g_magic_number);
         g_trade.SellStop(g_lotsize_array[g_strategy_index], old_open, g_symbol_name,
                          old_sl, old_tp, ORDER_TIME_SPECIFIED, old_expiry, old_comment);

         for(int j = 0; j < 100; j++)
            if(g_order_tracker[j][0] == (double)old_ticket)
               { g_order_tracker[j][0] = (double)g_trade.ResultOrder(); break; }

         Print("📊 手数变化 >", g_lot_change_pct, "%, 调整SellStop手数");
      }
   }
}

//+------------------------------------------------------------------+
//| 多头持仓管理 (原 ccbsw_16) — 核心出场逻辑                            |
//| 包含: 追踪止损/保本/高低点追踪/MagicTrail/Zone Recovery/虚拟止损       |
//+------------------------------------------------------------------+
bool ManageBuyPositions()
{
   bool result = false, any_change = false;
   double stored_sl = 0.0, stored_trail_base = 0.0;

   for(int i = 0; i < OrdersTotal(); i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;

      double sl      = NormalizeDouble(OrderGetDouble(ORDER_SL), g_digits);
      double tp      = NormalizeDouble(OrderGetDouble(ORDER_TP), g_digits);
      double op      = NormalizeDouble(OrderGetDouble(ORDER_PRICE_OPEN), g_digits);
      string comment = OrderGetString(ORDER_COMMENT);
      double lots    = OrderGetDouble(ORDER_VOLUME_CURRENT);
      datetime ot    = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      long magic     = OrderGetInteger(ORDER_MAGIC);
      string symbol  = OrderGetString(ORDER_SYMBOL);
      any_change = false;

      // === 手动模式: 给挂单设置SL/TP ===
      if((type == ORDER_TYPE_BUY_STOP || type == ORDER_TYPE_BUY_LIMIT) && g_entry_mode == 2 &&
         (g_manual_symbol_filter == 0 || symbol == g_symbol_name) &&
         (magic == g_manual_magic || g_manual_magic == 0) &&
         (comment == g_manual_comment_filter || g_manual_comment_filter == ""))
      {
         if(sl == 0.0) { sl = NormalizeDouble(op - g_sl_points * g_point_value, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }
         if(tp == 0.0) { tp = NormalizeDouble(g_tp_points * g_point_value + op, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }
      }

      // === 市价多单管理 ===
      if(type == ORDER_TYPE_BUY &&
         ((magic == g_magic_number && g_entry_mode == 1 && symbol == g_symbol_name) ||
          (g_entry_mode == 2 && (g_manual_symbol_filter == 0 || symbol == g_symbol_name) &&
           (magic == g_manual_magic || g_manual_magic == 0) && (comment == g_manual_comment_filter || g_manual_comment_filter == ""))))
      {
         // 补充缺失的SL/TP
         if(sl == 0.0) { sl = NormalizeDouble(op - g_sl_points * g_point_value, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }
         if(tp == 0.0) { tp = NormalizeDouble(g_tp_points * g_point_value + op, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }

         // MagicTrail: 持仓超过X分钟后切换步长
         g_magic_trail_current = g_magic_trail_start;
         if(g_magic_trail_after_minutes > 0 && TimeCurrent() > ot + g_magic_trail_after_minutes * 60)
            g_magic_trail_current = g_magic_trail_after_size;

         // 获取追踪器中的虚拟止损基准价
         double tracked_sl = 0.0;
         for(int j = 0; j < 100; j++)
            if(g_order_tracker[j][0] == (double)ticket) { tracked_sl = g_order_tracker[j][1]; break; }
         tracked_sl = 0.0; // 重置(匹配原始行为)
         double vsl_base = NormalizeDouble(tracked_sl, g_digits);

         if(vsl_base == 0.0)
         {
            // 首次: 存入入场价
            for(int j = 0; j < 100; j++)
               if(g_order_tracker[j][0] == 0.0) { g_order_tracker[j][0] = (double)ticket; g_order_tracker[j][1] = op; break; }
            vsl_base = op;
         }
         else
            vsl_base -= g_duplicate_sl_offset * g_point_value;

         double profit_dist = op - vsl_base;
         bool slip_zone = false;
         if(vsl_base > 0.0 - g_duplicate_sl_offset * g_point_value && profit_dist > g_slippage_pips * g_point_value)
         {
            slip_zone = true;
            if(g_slippage_mode == 2) { g_magic_trail_current = -1000.0; Print("⚡ 滑点模式2激活"); }
         }

         // 追踪基准: 入场价 或 虚拟止损价
         stored_trail_base = g_trail_from_entry ? vsl_base : op;

         // SL不能太紧
         double min_sl = NormalizeDouble(op - (g_sl_points + g_extra_sl_distance) * g_point_value - g_spread, g_digits);
         if(sl < min_sl) { sl = min_sl; g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }

         double bid = SymbolInfoDouble(g_symbol_name, SYMBOL_BID);

         // 硬止损触发
         if(bid < op - (g_sl_points + g_extra_sl_distance) * g_point_value - g_spread)
            { g_trade.PositionClose(ticket); return true; }

         // ==================== Zone Recovery 马丁 ====================
         bool zone_handled = false;
         if(g_zone_recovery)
         {
            // 统计当前Zone层数
            int zn_cnt = 0;
            for(int j = OrdersTotal(); j >= 0; j--)
            {
               ulong zt = OrderGetTicket(j);
               if(zt == 0) continue;
               if(OrderGetInteger(ORDER_MAGIC) != g_zone_buy_magic) continue;
               if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
               if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
               zn_cnt++;
            }
            double zn_lvls = zn_cnt;
            bool zn_placed = false;

            if(!g_zone_buy_active) { g_zone_buy_active = true; g_zone_buy_toggle = 0; }
            if(zn_lvls == 0.0) g_zone_buy_toggle = 0;
            g_zone_buy_toggle = (MathFloor(zn_lvls / 2.0) == zn_lvls / 2.0) ? 0 : 1;

            if(g_zone_buy_active)
            {
               // Zone整体盈利: 全部平仓
               if(zn_lvls > 0.0)
               {
                  double eq = AccountInfoDouble(ACCOUNT_EQUITY);
                  if(eq > AccountInfoDouble(ACCOUNT_BALANCE) + g_zone_profit_target)
                  {
                     for(int j = OrdersTotal(); j >= 0; j--)
                     {
                        ulong zt = OrderGetTicket(j);
                        if(zt == 0) continue;
                        long zm = OrderGetInteger(ORDER_MAGIC);
                        if(zm != g_magic_number && zm != g_zone_sell_magic && zm != g_zone_buy_magic) continue;
                        ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                        if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                     }
                  }

                  // 单组Zone盈利达标: 关闭该组
                  double zn_profit = 0.0;
                  for(int j = OrdersTotal(); j >= 0; j--)
                  {
                     ulong zt = OrderGetTicket(j);
                     if(zt == 0) continue;
                     if(OrderGetInteger(ORDER_TYPE) > 1) continue;
                     if(zt != ticket && OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                     PositionSelectByTicket(zt);
                     zn_profit += PositionGetDouble(POSITION_PROFIT);
                  }
                  if(zn_profit > g_zone_profit_target)
                  {
                     Print("🎯 Zone盈利达标, 全平该组");
                     for(int j = OrdersTotal(); j >= 0; j--)
                     {
                        ulong zt = OrderGetTicket(j);
                        if(zt == 0) continue;
                        if(OrderGetInteger(ORDER_MAGIC) == g_magic_number && zt == ticket) g_trade.PositionClose(zt);
                        if(OrderGetInteger(ORDER_MAGIC) != g_zone_buy_magic) continue;
                        if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                        ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                        if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                     }
                     g_zone_buy_active = false;
                     zone_handled = true;
                  }
               }
               else
               {
                  // 无Zone订单: 放置新Zone单
                  double zn_lot = lots * g_zone_lot_multiplier;
                  if(g_zone_lot_mult_type == 2) zn_lot = (zn_lvls + 1.0) * lots + lots;
                  if(g_zone_lot_mult_type == 3) zn_lot = lots * MathPow(g_zone_lot_multiplier, zn_lvls + 1.0);

                  if(g_zone_buy_toggle == 0)
                  {
                     double zn_price = zn_lvls * g_zone_step_distance * g_point_value +
                                      (vsl_base - g_zone_start_distance * g_point_value);
                     if(zn_price > vsl_base - g_zone_min_distance * g_point_value)
                        zn_price = vsl_base - g_zone_min_distance * g_point_value;

                     if(bid < zn_price)
                     {
                        if(zn_lvls >= g_zone_max_levels)
                        {
                           for(int j = OrdersTotal(); j >= 0; j--)
                           {
                              ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                              if(OrderGetInteger(ORDER_MAGIC) == g_magic_number && zt == ticket) g_trade.PositionClose(zt);
                              if(OrderGetInteger(ORDER_MAGIC) != g_zone_buy_magic) continue;
                              if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                              ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                              if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                           }
                        }
                        else
                        {
                           g_trade.SetExpertMagicNumber(g_zone_buy_magic);
                           g_trade.Sell(zn_lot, g_symbol_name, 0.0, 0.0, IntegerToString((int)ticket));
                           g_zone_buy_toggle = 1; zn_placed = true;
                        }
                     }
                  }
                  else
                  {
                     double ask = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK);
                     if(ask > vsl_base)
                     {
                        if(zn_lvls >= g_zone_max_levels)
                        {
                           for(int j = OrdersTotal(); j >= 0; j--)
                           {
                              ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                              if(OrderGetInteger(ORDER_MAGIC) == g_magic_number && zt == ticket) g_trade.PositionClose(zt);
                              if(OrderGetInteger(ORDER_MAGIC) != g_zone_buy_magic) continue;
                              if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                              ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                              if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                           }
                        }
                        else
                        {
                           g_trade.SetExpertMagicNumber(g_zone_buy_magic);
                           g_trade.Buy(zn_lot, g_symbol_name, 0.0, 0.0, IntegerToString((int)ticket));
                           g_zone_buy_toggle = 0; zn_placed = true;
                        }
                     }
                  }
               }
            }
            if(zn_lvls > 0.0 || zn_placed) zone_handled = true;
         }

         if(!zone_handled)
         {
            // ==================== VSL_OFF模式 (1) 或 混合模式 ====================
            if(g_virtual_sl_mode == 1 || (g_virtual_sl_mode != 3 && g_virtual_sl_mode != 2))
            {
               // 获取/初始化虚拟止损
               double vsl = 0.0; bool has = false;
               for(int j = 0; j < g_virtual_sl_size; j++)
                  if(g_virtual_sl_array[j][0] == (double)ticket) { vsl = g_virtual_sl_array[j][1]; has = true; break; }
               if(!has)
               {
                  vsl = NormalizeDouble(op - g_sl_points * g_point_value, g_digits);
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == 0.0) { g_virtual_sl_array[j][0] = (double)ticket; g_virtual_sl_array[j][1] = vsl; break; }
               }
               g_virtual_sl_price = vsl; stored_sl = vsl;
               if(bid < vsl) { Print("🛑 虚拟止损触发"); g_trade.PositionClose(ticket); return true; }

               // 时间恢复追踪止损
               if(g_recovery_trail_minutes > 0.0 && TimeCurrent() >= ot + g_recovery_trail_seconds &&
                  bid > NormalizeDouble(g_recovery_trail_size * g_point_value + (sl + g_tick_size), g_digits) &&
                  bid < tp - g_freeze_level)
               {
                  sl = NormalizeDouble(bid - g_recovery_trail_size * g_point_value, g_digits);
                  if(sl < bid - g_stoplevel)
                     { if(!g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ 恢复追踪失败: ", GetErrorDesc(GetLastError())); any_change = true; }
               }

               // 标准追踪止损
               if(g_trail_sl_start > 0.0 &&
                  bid > NormalizeDouble((g_trail_sl_start + g_trail_sl_step) * g_point_value + (sl + g_tick_size), g_digits) &&
                  bid > NormalizeDouble(g_trail_sl_min_distance * g_point_value + stored_trail_base, g_digits) &&
                  bid < tp - g_freeze_level &&
                  sl < NormalizeDouble(g_trail_sl_max * g_point_value + op, g_digits))
               {
                  sl = NormalizeDouble(bid - g_trail_sl_start * g_point_value, g_digits);
                  if(sl < bid - g_stoplevel)
                  {
                     if(g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0))
                     {
                        double pc_lot = NormalizeDouble(g_trail_partial_close_pct / 100.0 * g_lotsize_array[g_strategy_index], 2);
                        if(pc_lot < lots && pc_lot >= SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP))
                           { g_trade.PositionClosePartial(ticket, pc_lot); return true; }
                     }
                     else Print("✗ 追踪止损失败: ", GetErrorDesc(GetLastError()));
                     any_change = true;
                  }
               }

               // 滑点追踪止损
               if(slip_zone && g_slippage_mode == 1 && g_slip_trail_step > 0.0 &&
                  bid > NormalizeDouble(g_slip_trail_step * g_point_value + (sl + g_tick_size), g_digits) &&
                  bid > NormalizeDouble(g_slip_trail_start * g_point_value + vsl_base, g_digits) &&
                  bid < tp - g_freeze_level && sl < NormalizeDouble(g_slip_trail_limit * g_point_value + op, g_digits))
               {
                  sl = NormalizeDouble(bid - g_slip_trail_step * g_point_value, g_digits);
                  if(sl < bid - g_stoplevel)
                     { if(g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("⚡ 滑点追踪激活"); else Print("✗ 滑点追踪失败"); any_change = true; }
               }

               // 高低点追踪止损
               if(g_hl_trail_right_bars > 0 && g_hl_trail_left_bars >= 0 &&
                  g_hl_sell_trail > NormalizeDouble(sl + g_stoplevel + g_tick_size, g_digits) &&
                  (g_hl_sell_trail < op || !g_hl_trail_only_beyond_entry) &&
                  g_hl_sell_trail < NormalizeDouble(bid - g_hl_trail_min_distance * g_point_value - g_stoplevel - g_tick_size, g_digits) &&
                  bid < tp - g_freeze_level)
               {
                  sl = NormalizeDouble(g_hl_sell_trail, g_digits);
                  if(sl < bid - g_stoplevel)
                     { if(!g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ HL追踪失败: ", GetErrorDesc(GetLastError())); any_change = true; }
               }

               // 保本止损
               if(g_be_start > 0.0 && bid > NormalizeDouble(g_be_start * g_point_value + op, g_digits) &&
                  NormalizeDouble(g_be_extra * g_point_value + op, g_digits) > sl + g_tick_size &&
                  bid > NormalizeDouble(g_be_extra * g_point_value + op + g_stoplevel, g_digits) && bid < tp - g_freeze_level)
               {
                  sl = NormalizeDouble(g_be_extra * g_point_value + op, g_digits);
                  if(sl < bid - g_stoplevel)
                     { if(!g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ 保本失败: ", GetErrorDesc(GetLastError())); any_change = true; }
               }

               // MagicTrail 步进止损
               if(!any_change && (g_magic_trail_mode == 1 ||
                  (g_magic_trail_mode == 2 && g_magic_trail_step * g_point_value + sl <= g_magic_trail_max * g_point_value + (stored_trail_base + g_spread))))
               {
                  g_magic_trail_counter++;
                  if(bid > g_magic_trail_step * g_point_value + sl + g_stoplevel && bid < tp - g_freeze_level &&
                     (g_magic_trail_start == 0.0 || bid > g_magic_trail_current * g_point_value + stored_trail_base) &&
                     g_magic_trail_counter >= g_magic_trail_ticks &&
                     NormalizeDouble(g_magic_trail_step * g_point_value + sl, g_digits) > sl)
                  {
                     g_magic_trail_counter = 0;
                     sl = NormalizeDouble(g_magic_trail_step * g_point_value + sl, g_digits);
                     g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0);
                     any_change = true;
                  }
               }

               g_virtual_sl_price = sl;
               if(bid < sl) { Print("🛑 虚拟止损触发"); g_trade.PositionClose(ticket); return true; }

               // 更新追踪器
               if(NormalizeDouble(stored_sl, g_digits) != NormalizeDouble(g_virtual_sl_price, g_digits))
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == (double)ticket)
                        { g_virtual_sl_array[j][1] = NormalizeDouble(g_virtual_sl_price, g_digits); break; }

               if(any_change && g_trail_once) return true;
            }

            // ==================== VSL_BASIC(2) / VSL_ADV(3) 模式 ====================
            if(g_virtual_sl_mode == 2 || g_virtual_sl_mode == 3)
            {
               double vsl = 0.0; bool has = false;
               for(int j = 0; j < g_virtual_sl_size; j++)
                  if(g_virtual_sl_array[j][0] == (double)ticket) { vsl = g_virtual_sl_array[j][1]; has = true; break; }
               if(!has)
               {
                  vsl = NormalizeDouble(op - g_sl_points * g_point_value, g_digits);
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == 0.0) { g_virtual_sl_array[j][0] = (double)ticket; g_virtual_sl_array[j][1] = vsl; break; }
               }
               g_virtual_sl_price = vsl; stored_sl = vsl;
               if(bid <= vsl) { g_trade.PositionClose(ticket); return true; }

               // 定时同步虚拟止损到实际止损
               int elapsed = (int)(TimeCurrent() - g_trail_timer);
               if(elapsed >= g_refresh_interval)
               {
                  if(NormalizeDouble(g_virtual_sl_price, g_digits) > sl + g_tick_size)
                     g_trade.OrderModify(ticket, op, NormalizeDouble(g_virtual_sl_price, g_digits), tp, ORDER_TIME_SPECIFIED, 0);
                  g_trail_timer = TimeCurrent();
               }

               // 恢复追踪
               if(g_recovery_trail_minutes > 0.0 && TimeCurrent() >= ot + g_recovery_trail_seconds &&
                  bid > g_recovery_trail_size * g_point_value + (g_virtual_sl_price + g_tick_size) && bid < tp - g_freeze_level)
                  { any_change = true; g_virtual_sl_price = bid - g_recovery_trail_size * g_point_value; }

               // 标准追踪
               if(g_trail_sl_start > 0.0 &&
                  bid > (g_trail_sl_start + g_trail_sl_step) * g_point_value + (g_virtual_sl_price + g_tick_size) &&
                  bid > g_trail_sl_min_distance * g_point_value + stored_trail_base &&
                  g_virtual_sl_price < g_trail_sl_max * g_point_value + op)
               {
                  any_change = true; g_virtual_sl_price = bid - g_trail_sl_start * g_point_value;
                  double pc_lot = NormalizeDouble(g_trail_partial_close_pct / 100.0 * g_lotsize_array[g_strategy_index], 2);
                  if(pc_lot < lots && pc_lot >= SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP))
                     { g_trade.PositionClosePartial(ticket, pc_lot); return true; }
               }

               // 滑点追踪
               if(slip_zone && g_slippage_mode == 1 && g_slip_trail_step > 0.0 &&
                  bid > g_slip_trail_step * g_point_value + (g_virtual_sl_price + g_tick_size) &&
                  bid > g_slip_trail_start * g_point_value + vsl_base && bid < tp - g_freeze_level &&
                  g_virtual_sl_price < g_slip_trail_limit * g_point_value + op)
                  { Print("⚡ 滑点追踪激活(VSL)"); any_change = true; g_virtual_sl_price = bid - g_slip_trail_step * g_point_value; }

               // HL追踪
               if(g_hl_trail_right_bars > 0 && g_hl_trail_left_bars >= 0 &&
                  g_hl_sell_trail > g_virtual_sl_price + g_stoplevel + g_tick_size &&
                  (g_hl_sell_trail < op || !g_hl_trail_only_beyond_entry) &&
                  g_hl_sell_trail < bid - g_hl_trail_min_distance * g_point_value - g_stoplevel - g_tick_size &&
                  bid < tp - g_freeze_level)
                  { g_virtual_sl_price = g_hl_sell_trail; any_change = true; }

               // 保本(VSL_ADV)
               if(g_be_start > 0.0 && g_virtual_sl_mode == 3 &&
                  bid > g_be_start * g_point_value + op && g_be_extra * g_point_value + op > sl + g_tick_size &&
                  bid > g_be_extra * g_point_value + op + g_stoplevel && bid < tp - g_freeze_level &&
                  NormalizeDouble(g_be_extra * g_point_value + op, g_digits) > OrderGetDouble(ORDER_SL))
                  { g_virtual_sl_price = NormalizeDouble(g_be_extra * g_point_value + op, g_digits);
                    if(!g_trade.OrderModify(ticket, op, g_virtual_sl_price, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ 保本(VSL)失败"); any_change = true; }

               // 保本(VSL_BASIC)
               if(g_be_start > 0.0 && g_virtual_sl_mode == 2 &&
                  bid > g_be_start * g_point_value + op && g_be_extra * g_point_value + op > g_virtual_sl_price + g_tick_size &&
                  bid > g_be_extra * g_point_value + op + g_stoplevel && bid < tp - g_freeze_level)
                  { g_virtual_sl_price = g_be_extra * g_point_value + op; any_change = true; }

               // MagicTrail
               if(!any_change && (g_magic_trail_mode == 1 ||
                  (g_magic_trail_mode == 2 && g_magic_trail_step * g_point_value + g_virtual_sl_price <= g_magic_trail_max * g_point_value + (stored_trail_base + g_spread))))
               {
                  g_magic_trail_counter++;
                  if(bid > g_magic_trail_step * g_point_value + g_virtual_sl_price + g_stoplevel && bid < tp - g_freeze_level &&
                     (g_magic_trail_start == 0.0 || bid > g_magic_trail_current * g_point_value + stored_trail_base) &&
                     g_magic_trail_counter >= g_magic_trail_ticks)
                     { g_magic_trail_counter = 0; g_virtual_sl_price = g_magic_trail_step * g_point_value + g_virtual_sl_price; any_change = true; }
               }

               if(bid <= g_virtual_sl_price) { g_trade.PositionClose(ticket); return true; }

               if(NormalizeDouble(stored_sl, g_digits) != NormalizeDouble(g_virtual_sl_price, g_digits))
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == (double)ticket)
                        { g_virtual_sl_array[j][1] = NormalizeDouble(g_virtual_sl_price, g_digits); break; }
            }
         }
      }
      if(any_change) result = true;
   }
   return result;
}

//+------------------------------------------------------------------+
//| 空头持仓管理 (原 ccbsw_17) — 与多头对称                              |
//+------------------------------------------------------------------+
bool ManageSellPositions()
{
   bool result = false, any_change = false;
   double stored_sl = 0.0, stored_trail_base = 0.0;

   for(int i = 0; i < OrdersTotal(); i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;

      double sl      = NormalizeDouble(OrderGetDouble(ORDER_SL), g_digits);
      double tp      = NormalizeDouble(OrderGetDouble(ORDER_TP), g_digits);
      double op      = NormalizeDouble(OrderGetDouble(ORDER_PRICE_OPEN), g_digits);
      string comment = OrderGetString(ORDER_COMMENT);
      double lots    = OrderGetDouble(ORDER_VOLUME_CURRENT);
      datetime ot    = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      long magic     = OrderGetInteger(ORDER_MAGIC);
      string symbol  = OrderGetString(ORDER_SYMBOL);
      any_change = false;

      // 手动模式: 给挂单设置SL/TP
      if((type == ORDER_TYPE_SELL_STOP || type == ORDER_TYPE_SELL_LIMIT) && g_entry_mode == 2 &&
         (g_manual_symbol_filter == 0 || symbol == g_symbol_name) &&
         (magic == g_manual_magic || g_manual_magic == 0) &&
         (comment == g_manual_comment_filter || g_manual_comment_filter == ""))
      {
         if(sl == 0.0) { sl = NormalizeDouble(op + g_sl_points * g_point_value, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }
         if(tp == 0.0) { tp = NormalizeDouble(op - g_tp_points * g_point_value, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }
      }

      // 市价空单管理
      if(type == ORDER_TYPE_SELL &&
         ((magic == g_magic_number && g_entry_mode == 1 && symbol == g_symbol_name) ||
          (g_entry_mode == 2 && (g_manual_symbol_filter == 0 || symbol == g_symbol_name) &&
           (magic == g_manual_magic || g_manual_magic == 0) && (comment == g_manual_comment_filter || g_manual_comment_filter == ""))))
      {
         if(sl == 0.0) { sl = NormalizeDouble(op + g_sl_points * g_point_value, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }
         if(tp == 0.0) { tp = NormalizeDouble(op - g_tp_points * g_point_value, g_digits); g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }

         g_magic_trail_current = g_magic_trail_start;
         if(g_magic_trail_after_minutes > 0 && TimeCurrent() > ot + g_magic_trail_after_minutes * 60)
            g_magic_trail_current = g_magic_trail_after_size;

         double tracked_sl = 0.0;
         for(int j = 0; j < 100; j++)
            if(g_order_tracker[j][0] == (double)ticket) { tracked_sl = g_order_tracker[j][1]; break; }
         tracked_sl = 0.0;
         double vsl_base = NormalizeDouble(tracked_sl, g_digits);

         if(vsl_base == 0.0)
         {
            for(int j = 0; j < 100; j++)
               if(g_order_tracker[j][0] == 0.0) { g_order_tracker[j][0] = (double)ticket; g_order_tracker[j][1] = op; break; }
            vsl_base = op;
         }
         else
            vsl_base += g_duplicate_sl_offset * g_point_value;

         double profit_dist = vsl_base - op;
         bool slip_zone = false;
         if(vsl_base > 0.0 - g_duplicate_sl_offset * g_point_value && profit_dist > g_slippage_pips * g_point_value)
            { slip_zone = true; if(g_slippage_mode == 2) { g_magic_trail_current = -1000.0; Print("⚡ 滑点模式2激活"); } }

         stored_trail_base = g_trail_from_entry ? vsl_base : op;

         double min_sl = NormalizeDouble(op + (g_sl_points + g_extra_sl_distance) * g_point_value + g_spread, g_digits);
         if(sl > min_sl) { sl = min_sl; g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); }

         double ask = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK);
         if(ask > op + (g_sl_points + g_extra_sl_distance) * g_point_value + g_spread)
            { g_trade.PositionClose(ticket); return true; }

         // ==================== Zone Recovery 马丁(空头) ====================
         bool zone_handled = false;
         if(g_zone_recovery)
         {
            int zn_cnt = 0;
            for(int j = OrdersTotal(); j >= 0; j--)
            {
               ulong zt = OrderGetTicket(j); if(zt == 0) continue;
               if(OrderGetInteger(ORDER_MAGIC) != g_zone_sell_magic) continue;
               if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
               if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
               zn_cnt++;
            }
            double zn_lvls = zn_cnt; bool zn_placed = false;

            if(!g_zone_sell_active) { g_zone_sell_active = true; g_zone_sell_toggle = 1; }
            if(zn_lvls == 0.0) g_zone_sell_toggle = 1;
            g_zone_sell_toggle = (MathFloor(zn_lvls / 2.0) == zn_lvls / 2.0) ? 1 : 0;

            if(g_zone_sell_active)
            {
               if(zn_lvls > 0.0)
               {
                  double eq = AccountInfoDouble(ACCOUNT_EQUITY);
                  if(eq > AccountInfoDouble(ACCOUNT_BALANCE) + g_zone_profit_target)
                  {
                     for(int j = OrdersTotal(); j >= 0; j--)
                     {
                        ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                        long zm = OrderGetInteger(ORDER_MAGIC);
                        if(zm != g_magic_number && zm != g_zone_sell_magic && zm != g_zone_buy_magic) continue;
                        ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                        if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                     }
                  }

                  double zn_profit = 0.0;
                  for(int j = OrdersTotal(); j >= 0; j--)
                  {
                     ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                     if(OrderGetInteger(ORDER_TYPE) > 1) continue;
                     if(zt != ticket && OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                     PositionSelectByTicket(zt);
                     zn_profit += PositionGetDouble(POSITION_PROFIT);
                  }
                  if(zn_profit > g_zone_profit_target)
                  {
                     Print("🎯 Zone盈利达标(空), 全平该组");
                     for(int j = OrdersTotal(); j >= 0; j--)
                     {
                        ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                        if(OrderGetInteger(ORDER_MAGIC) == g_magic_number && zt == ticket) g_trade.PositionClose(zt);
                        if(OrderGetInteger(ORDER_MAGIC) != g_zone_sell_magic) continue;
                        if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                        ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                        if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                     }
                     g_zone_sell_active = false; zone_handled = true;
                  }
               }
               else
               {
                  double zn_lot = lots * g_zone_lot_multiplier;
                  if(g_zone_lot_mult_type == 2) zn_lot = (zn_lvls + 1.0) * lots + lots;
                  if(g_zone_lot_mult_type == 3) zn_lot = lots * MathPow(g_zone_lot_multiplier, zn_lvls + 1.0);

                  if(g_zone_sell_toggle == 0)
                  {
                     double bid2 = SymbolInfoDouble(g_symbol_name, SYMBOL_BID);
                     if(bid2 < vsl_base)
                     {
                        if(zn_lvls >= g_zone_max_levels)
                        {
                           for(int j = OrdersTotal(); j >= 0; j--)
                           {
                              ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                              if(OrderGetInteger(ORDER_MAGIC) == g_magic_number && zt == ticket) g_trade.PositionClose(zt);
                              if(OrderGetInteger(ORDER_MAGIC) != g_zone_sell_magic) continue;
                              if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                              ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                              if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                           }
                        }
                        else
                        {
                           g_trade.SetExpertMagicNumber(g_zone_sell_magic);
                           g_trade.Sell(zn_lot, g_symbol_name, 0.0, 0.0, IntegerToString((int)ticket));
                           g_zone_sell_toggle = 1; zn_placed = true;
                        }
                     }
                  }
                  else
                  {
                     double zn_price = g_zone_start_distance * g_point_value + vsl_base - zn_lvls * g_zone_step_distance * g_point_value;
                     if(zn_price < g_zone_min_distance * g_point_value + vsl_base) zn_price = g_zone_min_distance * g_point_value + vsl_base;
                     if(ask > zn_price)
                     {
                        if(zn_lvls >= g_zone_max_levels)
                        {
                           for(int j = OrdersTotal(); j >= 0; j--)
                           {
                              ulong zt = OrderGetTicket(j); if(zt == 0) continue;
                              if(OrderGetInteger(ORDER_MAGIC) == g_magic_number && zt == ticket) g_trade.PositionClose(zt);
                              if(OrderGetInteger(ORDER_MAGIC) != g_zone_sell_magic) continue;
                              if(OrderGetString(ORDER_COMMENT) != IntegerToString((int)ticket)) continue;
                              ENUM_ORDER_TYPE zty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                              if(zty == ORDER_TYPE_BUY || zty == ORDER_TYPE_SELL) g_trade.PositionClose(zt);
                           }
                        }
                        else
                        {
                           g_trade.SetExpertMagicNumber(g_zone_sell_magic);
                           g_trade.Buy(zn_lot, g_symbol_name, 0.0, 0.0, IntegerToString((int)ticket));
                           g_zone_sell_toggle = 0; zn_placed = true;
                        }
                     }
                  }
               }
            }
            if(zn_lvls > 0.0 || zn_placed) zone_handled = true;
         }

         if(!zone_handled)
         {
            // VSL_OFF / 混合模式
            if(g_virtual_sl_mode == 1 || (g_virtual_sl_mode != 3 && g_virtual_sl_mode != 2))
            {
               double vsl = 0.0; bool has = false;
               for(int j = 0; j < g_virtual_sl_size; j++)
                  if(g_virtual_sl_array[j][0] == (double)ticket) { vsl = g_virtual_sl_array[j][1]; has = true; break; }
               if(!has)
               {
                  vsl = NormalizeDouble(op + g_sl_points * g_point_value, g_digits);
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == 0.0) { g_virtual_sl_array[j][0] = (double)ticket; g_virtual_sl_array[j][1] = vsl; break; }
               }
               g_virtual_sl_price = vsl; stored_sl = vsl;
               if(ask > vsl) { Print("🛑 虚拟止损触发(空)"); g_trade.PositionClose(ticket); return true; }

               // 恢复追踪
               if(g_recovery_trail_minutes > 0.0 && TimeCurrent() >= ot + g_recovery_trail_seconds &&
                  ask < NormalizeDouble(g_recovery_trail_size * g_point_value + sl - g_tick_size, g_digits) && ask > tp + g_freeze_level)
               {
                  sl = NormalizeDouble(ask + g_recovery_trail_size * g_point_value, g_digits);
                  if(sl > ask + g_stoplevel)
                     { if(!g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ 恢复追踪失败"); any_change = true; }
               }

               // 标准追踪
               if(g_trail_sl_start > 0.0 &&
                  ask < NormalizeDouble(g_trail_sl_start * g_point_value + sl - g_tick_size, g_digits) &&
                  ask < NormalizeDouble(g_trail_sl_min_distance * g_point_value + stored_trail_base - g_tick_size, g_digits) &&
                  ask > tp + g_freeze_level && sl > NormalizeDouble(op - g_trail_sl_max * g_point_value, g_digits))
               {
                  sl = NormalizeDouble(ask + g_trail_sl_start * g_point_value, g_digits);
                  if(sl > ask + g_stoplevel)
                  {
                     if(g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0))
                     {
                        double pc_lot = NormalizeDouble(g_trail_partial_close_pct / 100.0 * g_lotsize_array[g_strategy_index], 2);
                        if(pc_lot < lots && pc_lot >= SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP))
                           { g_trade.PositionClosePartial(ticket, pc_lot); return true; }
                     }
                     else Print("✗ 追踪止损失败");
                     any_change = true;
                  }
               }

               // 滑点追踪
               if(slip_zone && g_slippage_mode == 1 && g_slip_trail_step > 0.0 &&
                  ask < NormalizeDouble(g_slip_trail_step * g_point_value + sl - g_tick_size, g_digits) &&
                  ask < NormalizeDouble(g_slip_trail_start * g_point_value + vsl_base - g_tick_size, g_digits) &&
                  ask > tp + g_freeze_level && sl > NormalizeDouble(op - g_slip_trail_limit * g_point_value, g_digits))
               {
                  sl = NormalizeDouble(ask + g_slip_trail_step * g_point_value, g_digits);
                  if(sl > ask + g_stoplevel) { if(g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("⚡ 滑点追踪"); any_change = true; }
               }

               // HL追踪
               if(g_hl_trail_right_bars > 0 && g_hl_trail_left_bars >= 0 &&
                  g_hl_buy_trail < NormalizeDouble(sl - g_stoplevel - g_tick_size, g_digits) &&
                  (g_hl_buy_trail > op || !g_hl_trail_only_beyond_entry) &&
                  g_hl_buy_trail > NormalizeDouble(ask + g_hl_trail_min_distance * g_point_value + g_stoplevel + g_tick_size, g_digits) &&
                  ask > tp + g_freeze_level)
                  { sl = NormalizeDouble(g_hl_buy_trail, g_digits);
                    if(sl > ask + g_stoplevel) { if(!g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ HL追踪失败"); any_change = true; } }

               // 保本
               if(g_be_start > 0.0 && ask < NormalizeDouble(op - g_be_start * g_point_value, g_digits) &&
                  NormalizeDouble(op - g_be_extra * g_point_value, g_digits) < sl - g_tick_size &&
                  ask < NormalizeDouble(op - g_be_extra * g_point_value - g_stoplevel, g_digits) && ask > tp + g_freeze_level)
                  { sl = NormalizeDouble(op - g_be_extra * g_point_value, g_digits);
                    if(sl > ask + g_stoplevel) { if(!g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ 保本失败"); any_change = true; } }

               // MagicTrail
               if(!any_change && (g_magic_trail_mode == 1 ||
                  (g_magic_trail_mode == 2 && g_magic_trail_step * g_point_value + sl >= stored_trail_base - g_magic_trail_max * g_point_value)))
               {
                  g_magic_trail_counter++;
                  if(ask < sl - g_magic_trail_step * g_point_value - g_stoplevel && ask > tp + g_freeze_level &&
                     (g_magic_trail_start == 0.0 || ask < stored_trail_base - g_magic_trail_current * g_point_value) &&
                     g_magic_trail_counter >= g_magic_trail_ticks &&
                     NormalizeDouble(sl - g_magic_trail_step * g_point_value, g_digits) < sl)
                     { g_magic_trail_counter = 0; sl = NormalizeDouble(sl - g_magic_trail_step * g_point_value, g_digits);
                       g_trade.OrderModify(ticket, op, sl, tp, ORDER_TIME_SPECIFIED, 0); any_change = true; }
               }

               g_virtual_sl_price = sl;
               if(ask > sl) { Print("🛑 虚拟止损触发(空)"); g_trade.PositionClose(ticket); return true; }

               if(NormalizeDouble(stored_sl, g_digits) != NormalizeDouble(g_virtual_sl_price, g_digits))
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == (double)ticket)
                        { g_virtual_sl_array[j][1] = NormalizeDouble(g_virtual_sl_price, g_digits); break; }

               if(any_change && g_trail_once) return true;
            }

            // VSL_BASIC / VSL_ADV
            if(g_virtual_sl_mode == 2 || g_virtual_sl_mode == 3)
            {
               double vsl = 0.0; bool has = false;
               for(int j = 0; j < g_virtual_sl_size; j++)
                  if(g_virtual_sl_array[j][0] == (double)ticket) { vsl = g_virtual_sl_array[j][1]; has = true; break; }
               if(!has)
               {
                  vsl = NormalizeDouble(op + g_sl_points * g_point_value, g_digits);
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == 0.0) { g_virtual_sl_array[j][0] = (double)ticket; g_virtual_sl_array[j][1] = vsl; break; }
               }
               g_virtual_sl_price = vsl; stored_sl = vsl;
               if(ask >= vsl) { g_trade.PositionClose(ticket); return true; }

               int elapsed = (int)(TimeCurrent() - g_trail_timer);
               if(elapsed >= g_refresh_interval)
               {
                  if(NormalizeDouble(g_virtual_sl_price, g_digits) < sl - g_tick_size)
                     g_trade.OrderModify(ticket, op, NormalizeDouble(g_virtual_sl_price, g_digits), tp, ORDER_TIME_SPECIFIED, 0);
                  g_trail_timer = TimeCurrent();
               }

               if(g_recovery_trail_minutes > 0.0 && TimeCurrent() >= ot + g_recovery_trail_seconds &&
                  ask < g_recovery_trail_size * g_point_value + (g_virtual_sl_price - g_tick_size) && ask > tp + g_freeze_level)
                  { any_change = true; g_virtual_sl_price = ask + g_recovery_trail_size * g_point_value; }

               if(g_trail_sl_start > 0.0 && ask < g_trail_sl_start * g_point_value + (g_virtual_sl_price - g_tick_size) &&
                  ask < g_trail_sl_min_distance * g_point_value + stored_trail_base &&
                  g_virtual_sl_price > op - g_trail_sl_max * g_point_value)
               {
                  any_change = true; g_virtual_sl_price = ask + g_trail_sl_start * g_point_value;
                  double pc_lot = NormalizeDouble(g_trail_partial_close_pct / 100.0 * g_lotsize_array[g_strategy_index], 2);
                  if(pc_lot < lots && pc_lot >= SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP))
                     { g_trade.PositionClosePartial(ticket, pc_lot); return true; }
               }

               if(slip_zone && g_slippage_mode == 1 && g_slip_trail_step > 0.0 &&
                  ask < g_slip_trail_step * g_point_value + (g_virtual_sl_price - g_tick_size) &&
                  ask < g_slip_trail_start * g_point_value + vsl_base && ask > tp + g_freeze_level &&
                  g_virtual_sl_price > op - g_slip_trail_limit * g_point_value)
                  { Print("⚡ 滑点追踪(VSL)"); any_change = true; g_virtual_sl_price = ask + g_slip_trail_step * g_point_value; }

               if(g_hl_trail_right_bars > 0 && g_hl_trail_left_bars >= 0 &&
                  g_hl_buy_trail < g_virtual_sl_price - g_stoplevel - g_tick_size &&
                  (g_hl_buy_trail > op || !g_hl_trail_only_beyond_entry) &&
                  g_hl_buy_trail > ask + g_hl_trail_min_distance * g_point_value + g_stoplevel + g_tick_size &&
                  ask > tp + g_freeze_level)
                  { g_virtual_sl_price = g_hl_buy_trail; any_change = true; }

               if(g_be_start > 0.0 && g_virtual_sl_mode == 3 &&
                  ask < op - g_be_start * g_point_value && op - g_be_extra * g_point_value < sl - g_tick_size &&
                  ask < op - g_be_extra * g_point_value - g_stoplevel && ask > tp + g_freeze_level &&
                  NormalizeDouble(op - g_be_extra * g_point_value, g_digits) < OrderGetDouble(ORDER_SL))
                  { g_virtual_sl_price = NormalizeDouble(op - g_be_extra * g_point_value, g_digits);
                    if(!g_trade.OrderModify(ticket, op, g_virtual_sl_price, tp, ORDER_TIME_SPECIFIED, 0)) Print("✗ 保本(VSL)失败"); any_change = true; }

               if(g_be_start > 0.0 && g_virtual_sl_mode == 2 &&
                  ask < op - g_be_start * g_point_value && op - g_be_extra * g_point_value < g_virtual_sl_price - g_tick_size &&
                  ask < op - g_be_extra * g_point_value - g_stoplevel && ask > tp + g_freeze_level)
                  { g_virtual_sl_price = op - g_be_extra * g_point_value; any_change = true; }

               if(!any_change && (g_magic_trail_mode == 1 ||
                  (g_magic_trail_mode == 2 && g_virtual_sl_price - g_magic_trail_step * g_point_value >= stored_trail_base - g_magic_trail_max * g_point_value)))
               {
                  g_magic_trail_counter++;
                  if(ask < g_virtual_sl_price - g_magic_trail_step * g_point_value - g_stoplevel && ask > tp + g_freeze_level &&
                     (g_magic_trail_start == 0.0 || ask < stored_trail_base - g_magic_trail_current * g_point_value) &&
                     g_magic_trail_counter >= g_magic_trail_ticks &&
                     NormalizeDouble(g_virtual_sl_price - g_magic_trail_step * g_point_value, g_digits) < g_virtual_sl_price)
                     { g_magic_trail_counter = 0; g_virtual_sl_price -= g_magic_trail_step * g_point_value; any_change = true; }
               }

               if(ask >= g_virtual_sl_price) { g_trade.PositionClose(ticket); return true; }

               if(NormalizeDouble(stored_sl, g_digits) != NormalizeDouble(g_virtual_sl_price, g_digits))
                  for(int j = 0; j < g_virtual_sl_size; j++)
                     if(g_virtual_sl_array[j][0] == (double)ticket)
                        { g_virtual_sl_array[j][1] = NormalizeDouble(g_virtual_sl_price, g_digits); break; }
            }
         }
      }
      if(any_change) result = true;
   }
   return result;
}

//+------------------------------------------------------------------+
//| 策略执行主函数 (原 ccbsw_6)                                         |
//| 每个策略(A-H)各自独立运行此函数,参数不同                              |
//+------------------------------------------------------------------+
void RunStrategy(int sid, int entry_tf, int timing_tf, int right, int left, int maxbars,
                 double mindist, double mindist_pct, double buy_ofs, double sell_ofs,
                 int max_ord, double dup_dist, int expire_h, int exit_mode,
                 double sl_p, double tp_p, double trail_start, double trail_min,
                 double trail_max, double trail_step, double trail_pc,
                 string comment, int magic)
{
   g_strategy_index = sid;

   // 应用策略参数
   g_entry_timeframe_D1 = entry_tf;   g_entry_timing_tf = timing_tf;
   g_donchian_right_bars = right;      g_donchian_left_bars = left;
   g_max_lookback_bars = maxbars;
   g_min_entry_distance = mindist;     g_min_entry_distance_pct = mindist_pct;
   g_buy_entry_offset = buy_ofs;       g_sell_entry_offset = sell_ofs;
   g_max_orders_per_dir = max_ord;     g_duplicate_order_distance = dup_dist;
   g_expiration_hours = expire_h;      g_exit_check_mode = exit_mode;
   g_sl_points = sl_p;                 g_tp_points = tp_p;
   g_trail_sl_start = trail_start;     g_trail_sl_min_distance = trail_min;
   g_trail_sl_max = trail_max;         g_trail_sl_step = trail_step;
   g_trail_partial_close_pct = trail_pc;
   g_order_comment = comment;          g_magic_number = magic;

   // 百分比距离 → 绝对距离
   if(g_min_entry_distance_pct > 0.0)
      g_min_entry_distance = g_min_entry_distance_pct / 100.0 * SymbolInfoDouble(g_symbol_name, SYMBOL_ASK) * 10.0;

   // 更新点值和市场信息
   g_point_value = SymbolInfoDouble(g_symbol_name, SYMBOL_POINT);
   g_tick_size = g_point_value;
   int digits_now = (int)SymbolInfoInteger(g_symbol_name, SYMBOL_DIGITS);
   if(digits_now == 3 || digits_now == 5)
      g_point_value = g_tick_size * 10.0;
   g_digits = digits_now;
   g_spread = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK) - SymbolInfoDouble(g_symbol_name, SYMBOL_BID);
   g_stoplevel = SymbolInfoInteger(g_symbol_name, SYMBOL_TRADE_STOPS_LEVEL) * g_tick_size;
   g_freeze_level = SymbolInfoInteger(g_symbol_name, SYMBOL_TRADE_FREEZE_LEVEL) * g_tick_size;

   // 订单过期时间
   g_expiration_seconds = g_expiration_hours * 60 * 60;
   g_order_expiry = (g_expiration_hours > 0) ? (datetime)(TimeCurrent() + (long)g_expiration_seconds) : 0;
   if(Virtual_expiration) g_order_expiry = 0;

   // === 出场管理 (按K线或tick触发) ===
   bool orders_managed = false;
   if(g_exit_check_mode == 0)
   {
      if(ManageBuyPositions()) orders_managed = true;
      if(ManageSellPositions()) orders_managed = true;
      if(orders_managed) return;
   }
   else
   {
      if(g_entry_bar_counter[sid] != GetBarsCount(g_symbol_name, ToMQL5TF(g_exit_check_mode)))
      {
         g_entry_bar_counter[sid] = GetBarsCount(g_symbol_name, ToMQL5TF(g_exit_check_mode));
         if(ManageBuyPositions()) orders_managed = true;
         if(ManageSellPositions()) orders_managed = true;
         if(orders_managed) return;
      }
   }

   // 余额变化调整手数
   AdjustLotSizesOnBalanceChange(false);

   // 市场关闭检查
   if(!(bool)MQLInfoInteger(MQL_TESTER) && !SymbolInfoInteger(g_symbol_name, SYMBOL_TRADE_MODE))
   {
      if(!g_market_closed_warning) Print("⏸ 市场已关闭, 等待中...");
      g_market_closed_warning = true;
      return;
   }

   // 日切换等待
   MqlDateTime mdt; TimeCurrent(mdt);
   if(g_dayswitch_check > 0 && ((mdt.hour == 0 && mdt.min < g_dayswitch_check) ||
      (mdt.hour == 23 && g_dayswitch_check > 60 - g_dayswitch_check)))
   {
      if(!g_market_closed_warning) Print("⏸ 日切换, 等待 ", g_dayswitch_check, " 分钟...");
      g_market_closed_warning = true;
      return;
   }
   g_market_closed_warning = false;

   // 交易时段
   if(g_use_trading_hours)
   {
      if(IsTradingHours() && g_is_nontrading_hours)
      {
         if(g_store_pending_nontrading) RestorePendingOrders();
         g_is_nontrading_hours = false;
      }
      if(!IsTradingHours() && !g_is_nontrading_hours)
      {
         Print("⏸ 进入非交易时段, 清理挂单...");
         if(g_store_pending_nontrading) { for(int i = 0; i < g_stored_pending_size; i++) for(int j = 0; j < 3; j++) g_stored_pending[i][j] = 0.0; StorePendingOrders(); }
         DeleteAllPendingOrders();
         g_is_nontrading_hours = true;
         return;
      }
   }

   // 非农过滤器
   if(g_nfp_filter && mdt.day <= 7 && mdt.day_of_week == 5 && mdt.hour >= g_nfp_start_hour && mdt.hour < g_nfp_end_hour)
   {
      DeleteAllPendingOrders();
      if(!g_nfp_active) Print("⚠ 非农数据时段, 暂停交易!");
      g_nfp_active = true;
   }
   else g_nfp_active = false;
   if(g_nfp_active) return;

   // 周五清仓
   if(g_friday_exit)
   {
      if(mdt.day_of_week == 5 && mdt.hour >= g_friday_exit_hour && !g_weekend_mode)
      {
         if(g_store_on_friday) { for(int i = 0; i < g_stored_pending_size; i++) for(int j = 0; j < 3; j++) g_stored_pending[i][j] = 0.0; StorePendingOrders(); }
         DeleteAllPendingOrders();
         Print("🏖 周末开始, 停止交易!");
         g_weekend_mode = true; return;
      }
      if(mdt.day_of_week != 5 && g_weekend_mode) { g_weekend_mode = false; if(g_store_on_friday) { RestorePendingOrders(); return; } }
   }

   // 点差过滤
   g_spread = SymbolInfoDouble(g_symbol_name, SYMBOL_ASK) - SymbolInfoDouble(g_symbol_name, SYMBOL_BID);
   if(g_use_spread_filter)
   {
      if(g_spread > MaxSpread * g_point_value) { HandleSpreadPendingOrders(); return; }
      if(g_spread <= g_max_spread_for_store * g_point_value &&
         (!g_friday_exit || mdt.day_of_week != 5 || mdt.hour < g_friday_exit_hour) &&
         (!g_use_trading_hours || IsTradingHours()))
         RestorePendingOrders();
   }

   // 挂单数量限制
   if(g_entry_mode == 1)
   {
      int bsc = 0; double high_op = 0.0; ulong high_tk = 0;
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong t = OrderGetTicket(i); if(t == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_BUY_STOP) continue;
         bsc++; double o = OrderGetDouble(ORDER_PRICE_OPEN); if(o > high_op) { high_op = o; high_tk = t; }
      }
      if(bsc > g_max_orders_per_dir && high_tk != 0)
      {
         g_trade.OrderDelete(high_tk); Print("⚠ BuyStop挂单超限, 删除最高价挂单");
         for(int j = 0; j < 100; j++) if(g_order_tracker[j][0] == (double)high_tk) { g_order_tracker[j][0] = 0.0; g_order_tracker[j][1] = 0.0; break; }
      }

      int ssc = 0; double low_op = 9999.0; ulong low_tk = 0;
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong t = OrderGetTicket(i); if(t == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         if(OrderGetInteger(ORDER_TYPE) != ORDER_TYPE_SELL_STOP) continue;
         ssc++; double o = OrderGetDouble(ORDER_PRICE_OPEN); if(o < low_op) { low_op = o; low_tk = t; }
      }
      if(ssc > g_max_orders_per_dir && low_tk != 0)
      {
         g_trade.OrderDelete(low_tk); Print("⚠ SellStop挂单超限, 删除最低价挂单");
         for(int j = 0; j < 100; j++) if(g_order_tracker[j][0] == (double)low_tk) { g_order_tracker[j][0] = 0.0; g_order_tracker[j][1] = 0.0; break; }
      }
   }

   // === 入场: 新K线时检查唐奇安突破 ===
   if(!g_weekend_mode && g_entry_mode == 1 && !g_is_nontrading_hours)
   {
      int cur_bars = GetBarsCount(g_symbol_name, ToMQL5TF(g_entry_timing_tf));
      if(g_entry_tf_bars[sid] != cur_bars || g_entry_timing_tf == 0)
      {
         g_entry_tf_bars[sid] = GetBarsCount(g_symbol_name, ToMQL5TF(g_entry_timing_tf));

         // 更新高低点追踪水平
         if(g_hl_trail_right_bars > 0 && g_hl_trail_left_bars >= 0)
         {
            ENUM_TIMEFRAMES hl_tf = ToMQL5TF(g_hl_trail_timeframe);
            g_hl_buy_trail = g_hl_trail_extra_distance * g_point_value +
                            (FindHLTrailHigh(hl_tf, g_hl_trail_right_bars, g_hl_trail_left_bars) + g_spread);
            g_hl_sell_trail = FindHLTrailLow(hl_tf, g_hl_trail_right_bars, g_hl_trail_left_bars) -
                             g_hl_trail_extra_distance * g_point_value;
         }

         // 随机滑点
         if(g_random_slip_max > 0)
         {
            g_random_slippage = MathRand() * g_random_slip_max / 32768 + 1;
            Print("🎲 随机滑点: ", g_random_slippage);
         }

         // 清理死单追踪
         if(g_virtual_sl_mode != 1)
         {
            int buy_cnt = 0, sell_cnt = 0;
            for(int i = OrdersTotal(); i >= 0; i--)
            {
               ulong t = OrderGetTicket(i); if(t == 0) continue;
               if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
               if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
               ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
               if(ty == ORDER_TYPE_BUY) buy_cnt++;
               if(ty == ORDER_TYPE_SELL) sell_cnt++;
            }
            if(buy_cnt == 0 && sell_cnt == 0)
            {
               for(int j = 0; j < g_virtual_sl_size; j++)
               {
                  bool f = false;
                  for(int k = OrdersTotal(); k >= 0; k--)
                     { ulong t = OrderGetTicket(k); if(t == 0) continue;
                       ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
                       if((ty == ORDER_TYPE_BUY || ty == ORDER_TYPE_SELL) && t == (ulong)g_virtual_sl_array[j][0]) { f = true; break; } }
                  if(!f) { g_virtual_sl_array[j][0] = 0.0; g_virtual_sl_array[j][1] = 0.0; }
               }
            }
         }

         // MA过滤值
         if(g_use_ma_filter)
         {
            double buf[]; ArraySetAsSeries(buf, true);
            if(CopyBuffer(g_ma_fast_handle, 0, 0, 2, buf) > 0) g_ma_fast_val = buf[1];
            if(CopyBuffer(g_ma_slow_handle, 0, 0, 2, buf) > 0) g_ma_slow_val = buf[1];
         }

         // 下单循环
         for(int k = 0; k < g_max_orders_per_dir; k++)
         {
            CalculateLotSize(g_sl_points, g_lot_divisor);
            if(g_lotsize_array[sid] > g_max_lotsize) g_lotsize_array[sid] = g_max_lotsize;
            if(g_expiration_hours > 0) g_order_expiry = (datetime)(TimeCurrent() + (long)g_expiration_seconds);
            if(Virtual_expiration) g_order_expiry = 0;

            // 删除过期挂单
            for(int i = OrdersTotal(); i >= 0; i--)
            {
               ulong t = OrderGetTicket(i); if(t == 0) continue;
               if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
               if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
               ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
               if(ty != ORDER_TYPE_BUY_STOP && ty != ORDER_TYPE_SELL_STOP) continue;
               if(TimeCurrent() < OrderGetInteger(ORDER_TIME_SETUP) + g_expiration_seconds) continue;
               g_trade.OrderDelete(t);
            }

            PlaceBuyStop(1);
            PlaceSellStop(1);

            // 诊断日志: 首次入场尝试
            static bool entry_logged[8] = {false};
            if(!entry_logged[sid])
            {
               entry_logged[sid] = true;
               Print("🔍 策略", (char)('A'+sid), " 首次入场检测 | 唐奇安高点=", g_buy_donchian_high,
                     " 低点=", g_sell_donchian_low,
                     " 买价=", SymbolInfoDouble(g_symbol_name, SYMBOL_ASK),
                     " 卖价=", SymbolInfoDouble(g_symbol_name, SYMBOL_BID),
                     " SL=", g_sl_points, " TP=", g_tp_points);
            }
         }
      }

      UpdateInfoPanelPL();
   }

   // 每小时清理一次追踪器
   if(g_flag_250 != mdt.hour)
   {
      g_flag_250 = mdt.hour;
      for(int i = 0; i < 100; i++)
      {
         bool f = false;
         for(int j = OrdersTotal(); j >= 0; j--)
            if(OrderGetTicket(j) == (ulong)g_order_tracker[i][0]) { f = true; break; }
         if(!f) { g_order_tracker[i][0] = 0.0; g_order_tracker[i][1] = 0.0; }
      }
   }

   // 图表点差信息
   if(g_show_spread_comment)
   {
      int bc = 0, sc = 0;
      for(int i = OrdersTotal(); i >= 0; i--)
      {
         ulong t = OrderGetTicket(i); if(t == 0) continue;
         if(OrderGetInteger(ORDER_MAGIC) != g_magic_number) continue;
         if(OrderGetString(ORDER_SYMBOL) != g_symbol_name) continue;
         ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         if(ty == ORDER_TYPE_BUY_STOP) bc++;
         if(ty == ORDER_TYPE_SELL_STOP) sc++;
      }
      Comment("点差: " + DoubleToString(NormalizeDouble(g_spread / g_point_value, 1), 1) +
              "\nBuyStop挂单: " + IntegerToString(bc) +
              "\nSellStop挂单: " + IntegerToString(sc));
   }
}

//+------------------------------------------------------------------+
//| 信息面板 — 刷新浮动盈亏 (原 ccbsw_24)                               |
//+------------------------------------------------------------------+
void UpdateInfoPanelPL()
{
   if(!ShowInfoPanel) return;
   if(MQLInfoInteger(MQL_TESTER) == 1 && !UpdateInfoTesting) return;

   double open_pl = 0.0;
   for(int i = OrdersTotal(); i >= 0; i--)
   {
      ulong t = OrderGetTicket(i); if(t == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != g_symbol_name && !g_one_chart_setup) continue;
      long magic = OrderGetInteger(ORDER_MAGIC);
      if(magic < ST1_MagicNumber + 1 || magic > ST1_MagicNumber + 8) continue;
      ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(ty != ORDER_TYPE_BUY && ty != ORDER_TYPE_SELL) continue;
      PositionSelectByTicket(t);
      open_pl += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP) + PositionGetDouble(POSITION_COMMISSION);
   }
   g_open_pl_array[g_strategy_index] = open_pl;
   ObjectSetString(0, "lineopl0", OBJPROP_TEXT, "浮动盈亏: " + DoubleToString(open_pl, 2));
   ObjectSetString(0, "linea0", OBJPROP_TEXT, "账户余额: " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2));
}

//+------------------------------------------------------------------+
//| 信息面板 — 刷新总盈亏 (原 ccbsw_26)                                 |
//+------------------------------------------------------------------+
void UpdateInfoPanelTotalPL()
{
   if(!ShowInfoPanel) return;
   if(MQLInfoInteger(MQL_TESTER) == 1 && !UpdateInfoTesting) return;

   int wins = 0, losses = 0, cnt = 0;
   for(int i = HistoryOrdersTotal(); i >= 0; i--)
   {
      ulong t = HistoryOrderGetTicket(i); if(t == 0) continue;
      if(HistoryOrderGetString(t, ORDER_SYMBOL) != g_symbol_name && !g_one_chart_setup) continue;
      long magic = HistoryOrderGetInteger(t, ORDER_MAGIC);
      if(magic < ST1_MagicNumber + 1 || magic > ST1_MagicNumber + 8) continue;
      cnt++; if(cnt >= 9999999) break;
      ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)HistoryOrderGetInteger(t, ORDER_TYPE);
      if(ty == ORDER_TYPE_BUY || ty == ORDER_TYPE_SELL)
      {
         double diff = HistoryDealGetDouble(t, DEAL_PRICE) - HistoryOrderGetDouble(t, ORDER_PRICE_OPEN);
         if(ty == ORDER_TYPE_SELL) diff = -diff;
         if(diff > 0.0) wins++;
      }
   }
   cnt = 0;
   for(int i = HistoryOrdersTotal(); i >= 0; i--)
   {
      ulong t = HistoryOrderGetTicket(i); if(t == 0) continue;
      if(HistoryOrderGetString(t, ORDER_SYMBOL) != g_symbol_name && !g_one_chart_setup) continue;
      long magic = HistoryOrderGetInteger(t, ORDER_MAGIC);
      if(magic < ST1_MagicNumber + 1 || magic > ST1_MagicNumber + 8) continue;
      cnt++; if(cnt >= 9999999) break;
      ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)HistoryOrderGetInteger(t, ORDER_TYPE);
      if(ty == ORDER_TYPE_BUY || ty == ORDER_TYPE_SELL)
      {
         double diff = HistoryDealGetDouble(t, DEAL_PRICE) - HistoryOrderGetDouble(t, ORDER_PRICE_OPEN);
         if(ty == ORDER_TYPE_SELL) diff = -diff;
         if(diff < 0.0) losses++;
      }
   }

   double total_pl = 0.0; int plc = 0;
   for(int i = HistoryOrdersTotal(); i >= 0; i--)
   {
      ulong t = HistoryOrderGetTicket(i); if(t == 0) continue;
      if(HistoryOrderGetString(t, ORDER_SYMBOL) != g_symbol_name && !g_one_chart_setup) continue;
      long magic = HistoryOrderGetInteger(t, ORDER_MAGIC);
      if(magic < ST1_MagicNumber + 1 || magic > ST1_MagicNumber + 8) continue;
      plc++; total_pl += HistoryDealGetDouble(t, DEAL_PROFIT) + HistoryDealGetDouble(t, DEAL_SWAP) + HistoryDealGetDouble(t, DEAL_COMMISSION);
      if(plc >= 1000) break;
   }

   g_win_count_array[g_strategy_index] = wins;
   g_loss_count_array[g_strategy_index] = losses;
   g_total_pl_array[g_strategy_index] = total_pl;

   ObjectSetString(0, "linetp0", OBJPROP_TEXT,
      "总盈亏: " + DoubleToString(NormalizeDouble(total_pl, 2), 2) +
      "  胜/负: " + IntegerToString(wins) + "/" + IntegerToString(losses));
}

//+------------------------------------------------------------------+
//| 创建信息面板 (原 ccbsw_21)                                         |
//+------------------------------------------------------------------+
void CreateInfoPanel()
{
   int rx = 5, ry = 20, rw = 350, rh = 150, tx = rx + 6, tyo = 4;
   color bg = (color)14599344;

   ObjectCreate(0, "infopanel_rectangle", OBJ_RECTANGLE_LABEL, 0, 0, 0.0);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_XDISTANCE, rx);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_YDISTANCE, ry);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_XSIZE, (long)(rw * InfoPanelSizeAdjust));
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_YSIZE, (double)(rh * InfoPanelSizeAdjust));
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_CORNER, 0);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_COLOR, clrRed);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_BGCOLOR, bg);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_BORDER_COLOR, clrRed);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_BORDER_TYPE, 0);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_WIDTH, 2);
   ObjectSetInteger(0, "infopanel_rectangle", OBJPROP_SELECTABLE, 0);

   // 创建标签的辅助宏(MQL5不支持lambda,内联展开)
   #define MAKE_LABEL(name_str, y_pos, text_str) \
      ObjectCreate(0, name_str, OBJ_LABEL, 0, 0, 0.0); \
      ObjectSetInteger(0, name_str, OBJPROP_CORNER, 0); \
      ObjectSetInteger(0, name_str, OBJPROP_YDISTANCE, y_pos); \
      ObjectSetInteger(0, name_str, OBJPROP_XDISTANCE, tx); \
      ObjectSetString(0, name_str, OBJPROP_TEXT, text_str);

   MAKE_LABEL("line1", ry + tyo, g_one_chart_setup ? "Gold Trade Pro V1.31 — 一图表模式" : "Gold Trade Pro V1.31");
   MAKE_LABEL("linec", ry + (int)(InfoPanelSizeAdjust * 20.0) + tyo, "EA开发: Wim Schrynemakers — 2023");
   MAKE_LABEL("line2", ry + (int)(InfoPanelSizeAdjust * 32.0) + tyo, "------------------------------------------------------");

   string lot_info;
   if(!g_one_chart_setup)
   {
      if(Risk == 9999) lot_info = "手数: " + DoubleToString(NormalizeDouble(g_lotsize_array[0], 2), 2) + " (余额步进=" + IntegerToString(LotPerBalance_step) + ")";
      else if(Risk == 999) lot_info = "手数: " + DoubleToString(NormalizeDouble(g_lotsize_array[0], 2), 2) + " (风险/笔=" + DoubleToString(Manual_RiskPerTrade, 1) + "%)";
      else if(Risk == g_risk_dd_based) lot_info = "手数: " + DoubleToString(NormalizeDouble(g_lotsize_array[0], 2), 2) + " (回撤风险=" + DoubleToString(g_max_risk_dd_pct, 1) + "%)";
      else lot_info = "手数: " + DoubleToString(NormalizeDouble(g_lotsize_array[0], 2), 2) + " (固定手数)";
   }
   MAKE_LABEL("lines", ry + (int)(InfoPanelSizeAdjust * 44.0) + tyo, lot_info);
   MAKE_LABEL("lineopl0", ry + (int)(InfoPanelSizeAdjust * 76.0) + tyo, "浮动盈亏: -");
   MAKE_LABEL("linea0", ry + (int)(InfoPanelSizeAdjust * 92.0) + tyo, "账户余额: -");
   MAKE_LABEL("linetp0", ry + (int)(InfoPanelSizeAdjust * 108.0) + tyo, "总盈亏: -");

   #undef MAKE_LABEL
}

//+------------------------------------------------------------------+
//| 清理面板对象 (原 ccbsw_23)                                         |
//+------------------------------------------------------------------+
void CleanupObjects()
{
   ObjectDelete(0, "line1"); ObjectDelete(0, "linec"); ObjectDelete(0, "line2");
   ObjectDelete(0, "lines"); ObjectDelete(0, "lineTradeStart");
   for(int i = 0; i <= 99; i++)
   {
      ObjectDelete(0, "lineopl" + IntegerToString(i, 0, ' '));
      ObjectDelete(0, "linea" + IntegerToString(i, 0, ' '));
      ObjectDelete(0, "lineto" + IntegerToString(i, 0, ' '));
      ObjectDelete(0, "linetp" + IntegerToString(i, 0, ' '));
      ObjectDelete(0, "linetq" + IntegerToString(i, 0, ' '));
      for(int j = 0; j < 10; j++) ObjectDelete(0, "tabel_info" + IntegerToString(i * 100 + j, 0, ' '));
   }
   ObjectDelete(0, "infopanel_rectangle");
   for(int i = 0; i < 10; i++) { ObjectDelete(0, "tabel_heading" + IntegerToString(i, 0, ' ')); ObjectDelete(0, "tabel_totals" + IntegerToString(i, 0, ' ')); }
   for(int i = 0; i < g_info_max_objects; i++) { ObjectDelete(0, "horizontalrect" + IntegerToString(i, 0, ' ')); ObjectDelete(0, "info_ea" + IntegerToString(i, 0, ' ')); }
}

//+------------------------------------------------------------------+
//| 绩效统计 (原 ccbsw_27)                                             |
//+------------------------------------------------------------------+
void CalcPerformance()
{
   double tp_arr[99], rp_arr[99];
   for(int i = 0; i < g_total_pairs; i++) { tp_arr[i] = 0.0; rp_arr[i] = 0.0; g_strategy_active[i] = false; g_perf_total_trades[i] = 0; g_perf_recent_trades[i] = 0; }

   for(int i = HistoryOrdersTotal(); i >= 0; i--)
   {
      ulong t = HistoryOrderGetTicket(i); if(t == 0) continue;
      if(HistoryOrderGetInteger(t, ORDER_MAGIC) != g_magic_number) continue;
      bool all_done = true;
      for(int j = 0; j < g_total_pairs; j++) if(!g_strategy_active[j]) all_done = false;
      if(HistoryOrderGetInteger(t, ORDER_TIME_DONE) < TimeCurrent() - g_perf_total_days * 86400 && all_done) break;

      double norm = HistoryOrderGetDouble(t, ORDER_VOLUME_INITIAL) * 100.0;
      if(g_normalize_by_lots == 1) norm = 1.0;

      for(int pid = 0; pid < g_total_pairs; pid++)
      {
         if(g_pair_names[pid] != HistoryOrderGetString(t, ORDER_SYMBOL)) continue;
         ENUM_ORDER_TYPE ty = (ENUM_ORDER_TYPE)HistoryOrderGetInteger(t, ORDER_TYPE);
         if(ty != ORDER_TYPE_BUY && ty != ORDER_TYPE_SELL) continue;
         if(HistoryOrderGetInteger(t, ORDER_TIME_DONE) < TimeCurrent() - g_perf_total_days * 86400)
            { if(!g_strategy_active[pid]) continue; }
         g_perf_total_trades[pid]++;
         if(g_perf_total_trades[pid] >= g_perf_min_trades) g_strategy_active[pid] = true;
         double prof = HistoryDealGetDouble(t, DEAL_PROFIT) / norm + HistoryDealGetDouble(t, DEAL_SWAP) / norm + HistoryDealGetDouble(t, DEAL_COMMISSION) / norm;
         tp_arr[pid] += prof;
         if(HistoryOrderGetInteger(t, ORDER_TIME_DONE) < TimeCurrent() - g_perf_recent_days * 86400) continue;
         rp_arr[pid] += prof; g_perf_recent_trades[pid]++;
      }
   }
   for(int i = 0; i < g_total_pairs; i++)
   {
      g_perf_total_profit[i] = tp_arr[i];
      g_perf_profit_per_trade[i] = (g_perf_total_trades[i] > 0) ? NormalizeDouble(tp_arr[i] / g_perf_total_trades[i], 2) : 0.0;
      g_perf_recent_profit[i] = rp_arr[i];
      g_perf_recent_per_trade[i] = (g_perf_recent_trades[i] > 0) ? NormalizeDouble(rp_arr[i] / g_perf_recent_trades[i], 2) : 0.0;
   }
}

//+------------------------------------------------------------------+
//| 按总利润排名 (原 ccbsw_28)                                         |
//+------------------------------------------------------------------+
void RankByProfit()
{
   CalcPerformance();
   for(int i = 0; i < g_total_pairs; i++)
   {
      int r = 1; double pi = g_perf_total_profit[i];
      for(int j = 0; j < g_total_pairs; j++) if(j != i && g_perf_total_profit[j] > pi) r++;
      g_ranking_array[i] = r;
   }
   for(int i = 0; i < g_total_pairs; i++)
   {
      bool tie; do { tie = false; for(int j = 0; j < g_total_pairs; j++) if(j != i && g_ranking_array[j] == g_ranking_array[i]) { g_ranking_array[j]++; tie = true; } } while(tie);
   }
   for(int i = 0; i < g_total_pairs; i++) g_perf_factor[i] = 1.0;
   for(int r = 1; r <= g_total_pairs; r++) for(int j = 0; j < g_total_pairs; j++) if(g_ranking_array[j] == r) g_sorted_indices[r - 1] = j;
}

//+------------------------------------------------------------------+
//| 按每笔利润排名 (原 ccbsw_29)                                       |
//+------------------------------------------------------------------+
void RankByPerTrade()
{
   CalcPerformance();
   for(int i = 0; i < g_total_pairs; i++)
   {
      int r = 1; double pi = g_perf_profit_per_trade[i];
      for(int j = 0; j < g_total_pairs; j++) if(j != i && g_perf_profit_per_trade[j] > pi) r++;
      g_ranking_array[i] = r;
   }
   for(int i = 0; i < g_total_pairs; i++)
   {
      bool tie; do { tie = false; for(int j = 0; j < g_total_pairs; j++) if(j != i && g_ranking_array[j] == g_ranking_array[i]) { g_ranking_array[j]++; tie = true; } } while(tie);
   }
   for(int i = 0; i < g_total_pairs; i++) g_perf_factor[i] = 1.0;
   for(int r = 1; r <= g_total_pairs; r++) for(int j = 0; j < g_total_pairs; j++) if(g_ranking_array[j] == r) g_sorted_indices[r - 1] = j;
}

//+------------------------------------------------------------------+
//| EA初始化 (原 init)                                                 |
//+------------------------------------------------------------------+
int OnInit()
{
   g_trade.SetExpertMagicNumber(ST1_MagicNumber);
   g_trade.SetDeviationInPoints(100);
   g_trade.SetTypeFilling(ORDER_FILLING_FOK);

   g_last_m5_time = 0; g_init_ok = true;
   g_strategy_index = 0; g_symbol_name = _Symbol;
   g_tick_size = SymbolInfoDouble(g_symbol_name, SYMBOL_POINT);
   g_point_value = g_tick_size;
   int d = (int)SymbolInfoInteger(g_symbol_name, SYMBOL_DIGITS);
   if(d == 3 || d == 5) g_point_value = g_tick_size * 10.0;
   g_digits = d;
   if(g_friday_exit_hour < 0) g_friday_exit = false;

   // 初始手数
   double ls = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_STEP);
   g_lotsize_array[0] = NormalizeDouble(MathFloor(StartLots * 100.0) / 100.0, 2);
   if(ls == 0.1)
   {
      g_lotsize_array[0] = NormalizeDouble(MathFloor(StartLots * 10.0) / 10.0, 1);
      if(g_lotsize_array[0] < 0.1) g_lotsize_array[0] = 0.1;
   }
   double ml = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MIN);
   double xl = SymbolInfoDouble(g_symbol_name, SYMBOL_VOLUME_MAX);
   if(g_lotsize_array[0] < ml) { Print("⚠ 最小手数=", ml); g_lotsize_array[0] = ml; }
   if(g_lotsize_array[0] > xl) { Print("⚠ 最大手数=", xl); g_lotsize_array[0] = xl; }

   if(g_magic_trail_step * g_point_value < g_tick_size) g_magic_trail_step = g_tick_size / g_point_value;

   g_last_balance = AccountInfoDouble(ACCOUNT_BALANCE);
   g_stoplevel = SymbolInfoInteger(g_symbol_name, SYMBOL_TRADE_STOPS_LEVEL) * g_tick_size;
   g_freeze_level = SymbolInfoInteger(g_symbol_name, SYMBOL_TRADE_FREEZE_LEVEL) * g_tick_size;
   g_symbol_suffix = StringSubstr(_Symbol, 6, 10);
   if(g_symbol_suffix != "") Print("📌 检测到品种后缀: ", g_symbol_suffix);

   // 默认策略A参数
   g_entry_timeframe_D1 = 1440; g_entry_timing_tf = 60; g_donchian_right_bars = 4; g_donchian_left_bars = 2;
   g_max_lookback_bars = 160; g_min_entry_distance = 150.0; g_buy_entry_offset = -140.0;
   g_sell_entry_offset = -290.0; g_max_orders_per_dir = 1; g_duplicate_order_distance = 680.0;
   g_expiration_hours = 408; g_exit_check_mode = 1; g_sl_points = 1300.0; g_tp_points = 1700.0;
   g_trail_sl_start = 800.0; g_trail_sl_min_distance = 500.0; g_trail_sl_max = 200.0;
   g_trail_sl_step = 0.1; g_trail_partial_close_pct = 0.0;
   g_order_comment = ST1_Comment + "_XAUUSD_A"; g_magic_number = ST1_MagicNumber + 1;

   // 创建MA过滤器句柄(默认周期1和370)
   g_ma_fast_handle = iMA(g_symbol_name, PERIOD_CURRENT, 1, 0, MODE_SMA, PRICE_CLOSE);
   g_ma_slow_handle = iMA(g_symbol_name, PERIOD_CURRENT, 370, 0, MODE_SMA, PRICE_CLOSE);

   // 安全检查
   if(g_sl_points <= 0.0) g_sl_points = 1.0;
   if(g_tp_points <= 0.0) g_tp_points = 1.0;
   if(g_be_extra > g_be_start) g_be_extra = g_be_start + 0.1;
   if(g_spread_distance < g_freeze_level / g_point_value) g_spread_distance = (int)(g_freeze_level / g_point_value);
   if(g_trail_sl_start != 0.0)
   {
      if(g_trail_sl_start < g_freeze_level / g_point_value) g_trail_sl_start = g_freeze_level / g_point_value;
      if(g_trail_sl_start < g_stoplevel / g_point_value) g_trail_sl_start = g_stoplevel / g_point_value;
   }
   if(g_recovery_trail_minutes > 0.0)
   {
      if(g_recovery_trail_size < g_freeze_level / g_point_value) g_recovery_trail_size = g_freeze_level / g_point_value;
      if(g_recovery_trail_size < g_stoplevel / g_point_value) g_recovery_trail_size = g_stoplevel / g_point_value;
   }
   if(g_sl_points < g_stoplevel * 2.0 / g_point_value) g_sl_points = g_stoplevel * 2.0 / g_point_value;
   if(g_tp_points < g_stoplevel * 2.0 / g_point_value) g_tp_points = g_stoplevel * 2.0 / g_point_value;
   if(g_min_entry_distance < g_stoplevel * 2.0 / g_point_value) g_min_entry_distance = g_stoplevel * 2.0 / g_point_value;
   if(g_donchian_right_bars < 1) g_donchian_right_bars = 1;
   if(g_donchian_left_bars < 1) g_donchian_left_bars = 1;
   if(g_min_entry_distance < 0.1) g_min_entry_distance = 0.1;

   g_expiration_seconds = g_expiration_hours * 60 * 60;
   g_order_expiry = (g_expiration_hours > 0) ? (datetime)(TimeCurrent() + (long)g_expiration_seconds) : 0;
   if(Virtual_expiration) g_order_expiry = 0;

   g_nfp_active = false; g_trail_timer = TimeCurrent();
   g_zone_buy_active = false; g_zone_sell_active = false;

   // 初始化追踪数组
   for(int i = 0; i < 20; i++) for(int j = 0; j < 2; j++) g_virtual_sl_array[i][j] = 0.0;
   for(int i = 0; i < 100; i++) for(int j = 0; j < 3; j++) g_stored_pending[i][j] = 0.0;
   for(int i = 0; i < 100; i++) { g_stored_pending[i][0] = 0.0; g_stored_pending[i][1] = 0.0; }
   g_weekend_mode = false;
   for(int i = 0; i < 100; i++) { g_order_tracker[i][0] = 0.0; g_order_tracker[i][1] = 0.0; }
   for(int i = 0; i < 99; i++)
   {
      g_entry_bar_counter[i] = 0; g_entry_tf_bars[i] = 0;
      g_entry_time_array[i] = GetTimeBar(g_symbol_name, ToMQL5TF(g_entry_timeframe_D1), 1);
      if(g_lotsize_array[i] < StartLots) g_lotsize_array[i] = StartLots;
   }
   if(g_virtual_sl_mode == 1) g_extra_sl_distance = 0.0;

   // 找初始唐奇安水平
   FindDonchianBuyEntry(ToMQL5TF(g_entry_timeframe_D1));
   FindDonchianSellEntry(ToMQL5TF(g_entry_timeframe_D1));
   g_buy_entry_price = NormalizeDouble(g_buy_donchian_high, g_digits);
   g_sell_entry_price = NormalizeDouble(g_sell_donchian_low, g_digits);
   g_magic_trail_counter = 0; g_market_closed_warning = false;
   g_recovery_trail_seconds = (int)(g_recovery_trail_minutes * 60.0);
   g_is_nontrading_hours = true; g_freeze_level = SymbolInfoInteger(g_symbol_name, SYMBOL_TRADE_FREEZE_LEVEL) * g_tick_size;
   if(!g_use_trading_hours) g_is_nontrading_hours = false;
   g_virtual_sl_price = 0.0; g_flag_158 = 0; g_flag_159 = 0; g_flag_160 = 0; g_flag_161 = 0;
   if(Risk > 0) g_use_risk_mode = true;
   if(g_max_lotsize > xl) g_max_lotsize = xl;
   g_max_spread_for_store = (g_max_spread_for_store > MaxSpread) ? MaxSpread : g_max_spread_for_store;

   g_comment_B1 = ST1_Comment + "B1"; g_comment_B2 = ST1_Comment + "B2";
   g_comment_S1 = ST1_Comment + "S1"; g_comment_S2 = ST1_Comment + "S2";

   if(g_one_trade_only) { g_max_orders_per_dir = 1; }

   // 初始化品种列表
   g_pair_names[g_total_pairs] = _Symbol;
   g_total_pairs = 1;

   // 首次手数计算 + 余额记录
   AdjustLotSizesOnBalanceChange(true);

   // 创建信息面板
   if(ShowInfoPanel)
   {
      if(g_ranking_mode == 1) RankByProfit(); else if(g_ranking_mode == 2) RankByPerTrade();
      CreateInfoPanel(); UpdateInfoPanelPL(); UpdateInfoPanelTotalPL();
   }

   Print("✅ Pro Gold Lion EA v1.31 初始化完成 | 品种: ", _Symbol,
         " | 魔术号基数: ", ST1_MagicNumber,
         " | 策略A:", RunStrategyA, " C:", RunStrategyC, " D:", RunStrategyD,
         " E:", RunStrategyE, " F:", RunStrategyF, " G:", RunStrategyG, " H:", RunStrategyH);
   Print("  点值=", g_point_value, " 位数=", g_digits, " 点差=", g_spread,
         " 过期=", g_order_expiry, " 时间类型=", (g_order_expiry==0?"GTC":"指定"));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EA退出                                                            |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   CleanupObjects();
   Print("👋 EA已卸载");
}

//+------------------------------------------------------------------+
//| 主Tick循环                                                        |
//| 7个策略A/C/D/E/F/G/H依次执行, 仅对XAUUSD/GOLD品种生效                |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!g_init_ok) return;

   // 每100个tick输出一次心跳
   static int tick_diag = 0;
   tick_diag++;
   if(tick_diag % 100 == 1)
      Print("💓 tick#", tick_diag, " 品种=", _Symbol, " 点差=",
            SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID));

   // 检查是否为XAUUSD/GOLD品种
   string sym = _Symbol;
   bool is_gold = (StringFind(sym, "XAUUSD", 0) >= 0 || StringFind(sym, "xauusd", 0) >= 0 ||
                   StringFind(sym, "GOLD", 0) >= 0 || StringFind(sym, "gold", 0) >= 0 ||
                   StringFind(sym, "Gold", 0) >= 0);

   if(is_gold) g_symbol_name = sym;

   // ===== 策略A: 日线4-2-160, SL150, TP1300/1700, Trailing800-500, 过期408h =====
   if(RunStrategyA)
      RunStrategy(0, 1440, 60, 4, 2, 160, 150.0, 0.0, -140.0, -290.0, 1, 680.0,
                  408, 1, 1300.0, 1700.0, 800.0, 500.0, 200.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_A", ST1_MagicNumber + 1);

   // ===== 隐藏策略B: 日线3-2-180, SL400, TP2500/1900, 过期168h =====
   if(g_run_strategy_B)
      RunStrategy(1, 1440, 60, 3, 2, 180, 400.0, 0.0, 10.0, -220.0, 1, 380.0,
                  168, 1, 2500.0, 1900.0, 100.0, 0.0, 200.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_B", ST1_MagicNumber + 2);

   // ===== 策略C: 日线18-3-180, SL900, TP1200/1800, Trailing750-600, 过期408h =====
   if(RunStrategyC)
      RunStrategy(2, 1440, 60, 18, 3, 180, 900.0, 0.0, -130.0, -30.0, 1, 980.0,
                  408, 1, 1200.0, 1800.0, 750.0, 600.0, 200.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_C", ST1_MagicNumber + 3);

   // ===== 策略D: 日线4-2-240, SL900, TP1300/1700, Trailing800-500, 过期48h =====
   if(RunStrategyD)
      RunStrategy(3, 1440, 60, 4, 2, 240, 900.0, 0.0, -250.0, -130.0, 1, 680.0,
                  48, 1, 1300.0, 1700.0, 800.0, 500.0, 200.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_D", ST1_MagicNumber + 4);

   // ===== 策略E: 日线15-3-230, SL550, TP600/1700, Trailing500-300, 过期480h =====
   if(RunStrategyE)
      RunStrategy(4, 1440, 60, 15, 3, 230, 550.0, 0.0, -170.0, -70.0, 1, 480.0,
                  480, 1, 600.0, 1700.0, 500.0, 300.0, 200.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_E", ST1_MagicNumber + 5);

   // ===== 策略F: 日线12-2-50, SL700, TP1000/1900, Trailing600-500, 过期384h =====
   if(RunStrategyF)
      RunStrategy(5, 1440, 60, 12, 2, 50, 700.0, 0.0, -210.0, -60.0, 1, 30.0,
                  384, 1, 1000.0, 1900.0, 600.0, 500.0, 1000.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_F", ST1_MagicNumber + 6);

   // ===== 策略G: 日线17-2-110, SL150, TP1200/1600, Trailing600-200, 过期240h =====
   if(RunStrategyG)
      RunStrategy(6, 1440, 60, 17, 2, 110, 150.0, 0.0, -40.0, -140.0, 1, 280.0,
                  240, 1, 1200.0, 1600.0, 600.0, 200.0, 4400.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_G", ST1_MagicNumber + 7);

   // ===== 策略H: 日线7-2-20, SL250, TP600/4900, Trailing600-350, 过期432h =====
   if(RunStrategyH)
      RunStrategy(7, 1440, 60, 7, 2, 20, 250.0, 0.0, -130.0, -120.0, 1, 980.0,
                  432, 1, 600.0, 4900.0, 600.0, 350.0, 2000.0, 0.1, 0.0,
                  ST1_Comment + "_XAUUSD_H", ST1_MagicNumber + 8);

   // 信息面板在M5新K线时刷新
   UpdateInfoPanelPL();
   if(GetTimeBar(_Symbol, PERIOD_M5, 1) != g_last_m5_time)
   {
      g_last_m5_time = GetTimeBar(_Symbol, PERIOD_M5, 1);
      if(g_ranking_mode == 1) RankByProfit(); else if(g_ranking_mode == 2) RankByPerTrade();
      UpdateInfoPanelTotalPL();
   }

   g_tick_counter++;
   if(g_tick_counter < 2) return;
   g_last_balance = AccountInfoDouble(ACCOUNT_BALANCE);
   g_tick_counter = 0;
}
//+------------------------------------------------------------------+
//|                            END OF FILE                            |
//+------------------------------------------------------------------+

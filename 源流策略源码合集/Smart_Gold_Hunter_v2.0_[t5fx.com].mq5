//+------------------------------------------------------------------+
//| Smart Gold Hunter v2.0 decompiled by Jamo886                     |
//| Built from authorized Strategy Tester observations and JIT audit.|
//| This is NOT the vendor's original MQ5 source.                     |
//+------------------------------------------------------------------+
#property copyright "Smart Gold Hunter v2.0 decompiled by Jamo886"
#property description "Smart Gold Hunter v2.0 decompiled by Jamo886"
#property link      "https://t.me/FUNDEDTODAY"
#property version   "2.00"
#property strict

#ifndef SGH_SIGNAL_ENGINE_MQH
#define SGH_SIGNAL_ENGINE_MQH

// Smart Gold Hunter v2.0 clean-room signal engine.
//
// Scope:
//   - recovered effective profile values;
//   - exactly 300 CopyRates bars;
//   - ZigZag-like Depth/Deviation/Backstep reconstruction;
//   - latest-two alternating-extrema scan (maximum 100 buffer slots);
//   - Buy Stop / Sell Stop choice and recovered entry-offset formulas.
//
// Deliberately outside this module: duplicate-price suppression, exposure and
// margin checks, StopsLevel/FreezeLevel enforcement, lot sizing, daily/news
// guards, pending-order submission and position management.

#define SGH_COPY_RATES_COUNT          300
#define SGH_EXTREMA_SCAN_LIMIT        100
#define SGH_ZIGZAG_DEVIATION_POINTS    10
// Native first-pass cleanup visits the preceding three map slots.  This is
// distinct from the two-slot constant used by the prior Stage8 candidate.
#define SGH_ZIGZAG_BACKSTEP             3
#define SGH_TRIGGER_DISTANCE_POINTS     10

enum ENUM_SGH_PROFILE_MODE
  {
   SGH_MODE_SCALPER     = 0,
   SGH_MODE_SWINGER     = 1,
   SGH_MODE_POSITIVE_RR = 2,
   SGH_MODE_PROP_SCALPER= 3,
   SGH_MODE_CUSTOM      = 4
  };

enum ENUM_SGH_EXTREMUM_TYPE
  {
   SGH_EXTREMUM_NONE = 0,
   SGH_EXTREMUM_HIGH = 1,
   SGH_EXTREMUM_LOW  =-1
  };

enum ENUM_SGH_PENDING_DIRECTION
  {
   SGH_DIRECTION_NONE      = 0,
   SGH_DIRECTION_BUY_STOP  = 1,
   SGH_DIRECTION_SELL_STOP =-1
  };

enum ENUM_SGH_SIGNAL_STATUS
  {
   SGH_STATUS_ERROR             =-1,
   SGH_STATUS_NO_SETUP          = 0,
   SGH_STATUS_READY             = 1,
   SGH_STATUS_NOT_ENOUGH_RATES  = 2,
   SGH_STATUS_NOT_ENOUGH_SWINGS = 3,
   SGH_STATUS_NO_TICK           = 4,
   SGH_STATUS_BAD_SYMBOL        = 5
  };

struct SGHCustomValues
  {
   double takeProfitPoints;
   double stopLossPoints;
   double trailStartPoints;
   double trailDistancePoints;
   double entryOffsetPoints;
   int    pauseSeconds;
  };

// All distances are raw broker points.  For the captured two-digit XAUUSD
// carrier, Point=0.01 and therefore 100 points=$1.00 of price.
struct SGHEffectiveProfile
  {
   int              requestedMode;
   ENUM_SGH_PROFILE_MODE effectiveMode;
   string           profileName;
   ENUM_TIMEFRAMES  signalTimeframe;
   int              swingDepth;
   int              zigzagDeviationPoints;
   int              zigzagBackstep;
   int              copyRatesCount;
   int              extremaScanLimit;
   long             pendingExpiryHours;
   double           takeProfitPoints;
   double           stopLossPoints;
   double           trailStartPoints;
   double           trailDistancePoints;
   double           entryOffsetPoints;
   int              pauseSeconds;
   bool             isCustom;
   bool             isPropScalper;
   int              propHoldSeconds;
   double           initialTakeProfitPoints;
   double           initialStopLossPoints;
  };

struct SGHExtremum
  {
   ENUM_SGH_EXTREMUM_TYPE type;
   double                 price;
   datetime               time;
   int                    shift;
  };

struct SGHSignal
  {
   ENUM_SGH_SIGNAL_STATUS      status;
   ENUM_SGH_PENDING_DIRECTION direction;
   ENUM_ORDER_TYPE             orderType;
   string                      symbol;
   ENUM_TIMEFRAMES             timeframe;
   double                      bid;
   double                      ask;
   double                      rawPoint;
   double                      normalizedPoint;
   double                      triggerDistance;
   double                      entryPrice;
   double                      stopLossPrice;
   double                      takeProfitPrice;
   datetime                    expiration;
   SGHExtremum                 latestExtremum;
   SGHExtremum                 previousExtremum;
   int                         copiedRates;
   int                         errorCode;
  };

void SGHSetCapturedCustomDefaults(SGHCustomValues &values)
  {
   // Defaults observed in the captured v2.0 SET files.  They only become
   // effective when the requested mode is Custom (4 or an unknown value).
   values.takeProfitPoints    =250.0;
   values.stopLossPoints      =1500.0;
   values.trailStartPoints    =100.0;
   values.trailDistancePoints =50.0;
   values.entryOffsetPoints   =0.0;
   values.pauseSeconds        =300;
  }

void SGHResetExtremum(SGHExtremum &extremum)
  {
   extremum.type =SGH_EXTREMUM_NONE;
   extremum.price=0.0;
   extremum.time =0;
   extremum.shift=-1;
  }

void SGHResetSignal(SGHSignal &signal,const string symbol,
                    const ENUM_TIMEFRAMES timeframe)
  {
   signal.status           =SGH_STATUS_NO_SETUP;
   signal.direction        =SGH_DIRECTION_NONE;
   signal.orderType        =ORDER_TYPE_BUY_STOP;
   signal.symbol           =symbol;
   signal.timeframe        =timeframe;
   signal.bid              =0.0;
   signal.ask              =0.0;
   signal.rawPoint         =0.0;
   signal.normalizedPoint  =0.0;
   signal.triggerDistance  =0.0;
   signal.entryPrice       =0.0;
   signal.stopLossPrice    =0.0;
   signal.takeProfitPrice  =0.0;
   signal.expiration       =0;
   signal.copiedRates      =0;
   signal.errorCode        =0;
   SGHResetExtremum(signal.latestExtremum);
   SGHResetExtremum(signal.previousExtremum);
  }

void SGHSetProfileCommon(const int requested_mode,
                         SGHEffectiveProfile &profile)
  {
   profile.requestedMode             =requested_mode;
   profile.effectiveMode             =SGH_MODE_CUSTOM;
   profile.profileName               ="Custom";
   profile.signalTimeframe           =PERIOD_CURRENT;
   profile.swingDepth                =12;
   profile.zigzagDeviationPoints     =SGH_ZIGZAG_DEVIATION_POINTS;
   profile.zigzagBackstep            =SGH_ZIGZAG_BACKSTEP;
   profile.copyRatesCount            =SGH_COPY_RATES_COUNT;
   profile.extremaScanLimit          =SGH_EXTREMA_SCAN_LIMIT;
   profile.pendingExpiryHours        =27000;
   profile.takeProfitPoints          =0.0;
   profile.stopLossPoints            =0.0;
   profile.trailStartPoints          =0.0;
   profile.trailDistancePoints       =0.0;
   profile.entryOffsetPoints         =0.0;
   profile.pauseSeconds              =0;
   profile.isCustom                  =true;
   profile.isPropScalper             =false;
   profile.propHoldSeconds           =0;
   profile.initialTakeProfitPoints   =0.0;
   profile.initialStopLossPoints     =0.0;
  }

// Resolves the recovered hidden/effective values.  Built-in modes ignore the
// custom arguments, matching the observed EA.  Every value in the four cases
// below is recovered JIT/runtime evidence, not a fitted parameter.
bool SGHResolveProfile(const int mode,const SGHCustomValues &custom_values,
                       SGHEffectiveProfile &profile)
  {
   SGHSetProfileCommon(mode,profile);

   switch(mode)
     {
      case SGH_MODE_SCALPER:
         profile.effectiveMode           =SGH_MODE_SCALPER;
         profile.profileName             ="Scalper";
         profile.signalTimeframe         =PERIOD_M15;
         profile.swingDepth              =18;
         profile.pendingExpiryHours      =12;
         profile.takeProfitPoints        =1500.0;
         profile.stopLossPoints          =300.0;
         profile.trailStartPoints        =140.0;
         profile.trailDistancePoints     =40.0;
         profile.entryOffsetPoints       =-160.0;
         profile.pauseSeconds            =60;
         profile.isCustom                =false;
         break;

      case SGH_MODE_SWINGER:
         profile.effectiveMode           =SGH_MODE_SWINGER;
         profile.profileName             ="Swinger";
         profile.signalTimeframe         =PERIOD_M15;
         profile.swingDepth              =12;
         profile.pendingExpiryHours      =27000;
         profile.takeProfitPoints        =4500.0;
         profile.stopLossPoints          =2500.0;
         profile.trailStartPoints        =1500.0;
         profile.trailDistancePoints     =500.0;
         profile.entryOffsetPoints       =-50.0;
         profile.pauseSeconds            =60;
         profile.isCustom                =false;
         break;

      case SGH_MODE_POSITIVE_RR:
         profile.effectiveMode           =SGH_MODE_POSITIVE_RR;
         profile.profileName             ="Positive RR";
         profile.signalTimeframe         =PERIOD_M30;
         profile.swingDepth              =18;
         profile.pendingExpiryHours      =12;
         profile.takeProfitPoints        =2250.0;
         profile.stopLossPoints          =325.0;
         profile.trailStartPoints        =575.0;
         profile.trailDistancePoints     =165.0;
         profile.entryOffsetPoints       =-175.0;
         profile.pauseSeconds            =60;
         profile.isCustom                =false;
         break;

      case SGH_MODE_PROP_SCALPER:
         profile.effectiveMode           =SGH_MODE_PROP_SCALPER;
         profile.profileName             ="Prop Scalper";
         profile.signalTimeframe         =PERIOD_M15;
         profile.swingDepth              =18;
         profile.pendingExpiryHours      =12;
         profile.takeProfitPoints        =2500.0;
         profile.stopLossPoints          =350.0;
         profile.trailStartPoints        =165.0;
         profile.trailDistancePoints     =40.0;
         profile.entryOffsetPoints       =-150.0;
         profile.pauseSeconds            =60;
         profile.isCustom                =false;
         profile.isPropScalper           =true;
         profile.propHoldSeconds         =120;
         profile.initialTakeProfitPoints =5000.0;
         profile.initialStopLossPoints   =700.0;
         break;

      default:
         // Recovered dispatch sends 4+ to Custom.  Negative values were not a
         // valid UI state; this clean-room implementation also treats them as
         // Custom so that it fails safely and deterministically.
         profile.effectiveMode        =SGH_MODE_CUSTOM;
         profile.profileName          ="Custom";
         profile.signalTimeframe      =PERIOD_CURRENT;
         profile.swingDepth           =12;
         profile.pendingExpiryHours   =27000;
         profile.takeProfitPoints     =custom_values.takeProfitPoints;
         profile.stopLossPoints       =custom_values.stopLossPoints;
         profile.trailStartPoints     =custom_values.trailStartPoints;
         profile.trailDistancePoints  =custom_values.trailDistancePoints;
         profile.entryOffsetPoints    =custom_values.entryOffsetPoints;
         profile.pauseSeconds         =custom_values.pauseSeconds;
         profile.isCustom             =true;
         break;
     }

   if(!profile.isPropScalper)
     {
      profile.initialTakeProfitPoints=profile.takeProfitPoints;
      profile.initialStopLossPoints  =profile.stopLossPoints;
     }

   return(true);
  }

// Convenience overload for integration with the original input names.
bool SGHResolveProfile(const int mode,
                       const double custom_take_profit_points,
                       const double custom_stop_loss_points,
                       const double custom_trail_start_points,
                       const double custom_trail_distance_points,
                       const int custom_pause_seconds,
                       const double custom_entry_offset_points,
                       SGHEffectiveProfile &profile)
  {
   SGHCustomValues values;
   values.takeProfitPoints    =custom_take_profit_points;
   values.stopLossPoints      =custom_stop_loss_points;
   values.trailStartPoints    =custom_trail_start_points;
   values.trailDistancePoints =custom_trail_distance_points;
   values.entryOffsetPoints   =custom_entry_offset_points;
   values.pauseSeconds        =custom_pause_seconds;
   return(SGHResolveProfile(mode,values,profile));
  }

// Convenience overload using the exact Custom defaults captured from SET.
bool SGHResolveProfile(const int mode,SGHEffectiveProfile &profile)
  {
   SGHCustomValues values;
   SGHSetCapturedCustomDefaults(values);
   return(SGHResolveProfile(mode,values,profile));
  }

double SGHRawPoint(const string symbol)
  {
   return(SymbolInfoDouble(symbol,SYMBOL_POINT));
  }

double SGHNormalizedPoint(const string symbol)
  {
   const double point=SGHRawPoint(symbol);
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   if(digits==3 || digits==5)
      return(point*10.0);
   return(point);
  }

int SGHWindowLowest(const MqlRates &rates[],const int start,const int count)
  {
   const int bars=ArraySize(rates);
   if(start<0 || start>=bars || count<=0)
      return(-1);

   int end=start+count;
   if(end>bars)
      end=bars;

   int result=start;
   double value=rates[start].low;
   for(int i=start+1;i<end;i++)
     {
      if(rates[i].low<value)
        {
         value=rates[i].low;
         result=i;
        }
     }
   return(result);
  }

int SGHWindowHighest(const MqlRates &rates[],const int start,const int count)
  {
   const int bars=ArraySize(rates);
   if(start<0 || start>=bars || count<=0)
      return(-1);

   int end=start+count;
   if(end>bars)
      end=bars;

   int result=start;
   double value=rates[start].high;
   for(int i=start+1;i<end;i++)
     {
      if(rates[i].high>value)
        {
         value=rates[i].high;
         result=i;
        }
     }
   return(result);
  }

// Produces series-indexed buffers: index 0 is the newest (possibly forming)
// bar.  The first pass follows the conventional ZigZag extrema-map algorithm;
// the second pass forces alternating extrema and replaces a still-developing
// same-side extreme with the more extreme value.
bool SGHBuildZigZag(const MqlRates &rates[],const int depth,
                    const double deviation_price,const int backstep,
                    double &high_buffer[],double &low_buffer[],
                    double &zigzag_buffer[])
  {
   const int bars=ArraySize(rates);
   if(depth<2 || backstep<0 || bars<depth+2)
      return(false);

   ArrayResize(high_buffer,bars);
   ArrayResize(low_buffer,bars);
   ArrayResize(zigzag_buffer,bars);
   ArraySetAsSeries(high_buffer,true);
   ArraySetAsSeries(low_buffer,true);
   ArraySetAsSeries(zigzag_buffer,true);
   ArrayInitialize(high_buffer,0.0);
   ArrayInitialize(low_buffer,0.0);
   ArrayInitialize(zigzag_buffer,0.0);

   double last_low =0.0;
   double last_high=0.0;
   const int oldest_calculable=bars-depth;

   // Series index decreases as time advances, hence oldest -> newest is a
   // descending loop.
   for(int shift=oldest_calculable;shift>=0;shift--)
     {
      int index=SGHWindowLowest(rates,shift,depth);
      double value=(index>=0 ? rates[index].low : 0.0);

      if(value==last_low)
         value=0.0;
      else
        {
         last_low=value;
         if((rates[shift].low-value)>deviation_price)
            value=0.0;
         else
           {
            for(int back=1;back<=backstep;back++)
              {
               const int old_shift=shift+back;
               if(old_shift>=bars)
                  break;
               const double old_value=low_buffer[old_shift];
               if(old_value!=0.0 && old_value>value)
                  low_buffer[old_shift]=0.0;
              }
           }
        }
      if(value!=0.0 && rates[shift].low==value)
         low_buffer[shift]=value;

      index=SGHWindowHighest(rates,shift,depth);
      value=(index>=0 ? rates[index].high : 0.0);

      if(value==last_high)
         value=0.0;
      else
        {
         last_high=value;
         if((value-rates[shift].high)>deviation_price)
            value=0.0;
         else
           {
            for(int back=1;back<=backstep;back++)
              {
               const int old_shift=shift+back;
               if(old_shift>=bars)
                  break;
               const double old_value=high_buffer[old_shift];
               if(old_value!=0.0 && old_value<value)
                  high_buffer[old_shift]=0.0;
              }
           }
        }
      if(value!=0.0 && rates[shift].high==value)
         high_buffer[shift]=value;
     }

   int what_to_find=0; // 0=first point, 1=high next, -1=low next
   int last_low_position =-1;
   int last_high_position=-1;
   last_low =0.0;
   last_high=0.0;

   for(int shift=oldest_calculable;shift>=0;shift--)
     {
      const double high=high_buffer[shift];
      const double low =low_buffer[shift];

      if(what_to_find==0)
        {
         if(high!=0.0)
           {
            last_high=high;
            last_high_position=shift;
            zigzag_buffer[shift]=high;
            what_to_find=-1;
           }
         if(low!=0.0)
           {
            last_low=low;
            last_low_position=shift;
            zigzag_buffer[shift]=low;
            what_to_find=1;
           }
         continue;
        }

      if(what_to_find==1)
        {
         if(low!=0.0 && low<last_low && high==0.0)
           {
            if(last_low_position>=0)
               zigzag_buffer[last_low_position]=0.0;
            last_low=low;
            last_low_position=shift;
            zigzag_buffer[shift]=low;
           }
         if(high!=0.0 && low==0.0)
           {
            last_high=high;
            last_high_position=shift;
            zigzag_buffer[shift]=high;
            what_to_find=-1;
           }
         continue;
        }

      if(high!=0.0 && high>last_high && low==0.0)
        {
         if(last_high_position>=0)
            zigzag_buffer[last_high_position]=0.0;
         last_high=high;
         last_high_position=shift;
         zigzag_buffer[shift]=high;
        }
      if(low!=0.0 && high==0.0)
        {
         last_low=low;
         last_low_position=shift;
         zigzag_buffer[shift]=low;
         what_to_find=1;
        }
     }

   return(true);
  }

bool SGHFindLatestTwoExtrema(const MqlRates &rates[],
                             const double &high_buffer[],
                             const double &low_buffer[],
                             const double &zigzag_buffer[],
                             const int scan_limit,
                             SGHExtremum &latest,
                             SGHExtremum &previous)
  {
   SGHResetExtremum(latest);
   SGHResetExtremum(previous);

   int limit=scan_limit;
   if(limit>ArraySize(zigzag_buffer))
      limit=ArraySize(zigzag_buffer);
   if(limit>ArraySize(rates))
      limit=ArraySize(rates);

   // Native scan +0x4960..+0x5921 excludes shift 0 and examines shifts
   // 1..99.  It counts the first two non-zero values in the composite
   // ZigZag buffer exactly as stored; it does not skip equal/consecutive
   // candidate types.
   for(int shift=1;shift<limit;shift++)
     {
      const double value=zigzag_buffer[shift];
      if(value==0.0)
         continue;

      ENUM_SGH_EXTREMUM_TYPE type=SGH_EXTREMUM_NONE;
      if(high_buffer[shift]!=0.0 && value==high_buffer[shift])
         type=SGH_EXTREMUM_HIGH;
      else if(low_buffer[shift]!=0.0 && value==low_buffer[shift])
         type=SGH_EXTREMUM_LOW;

      if(latest.shift<0)
        {
         latest.type =type;
         latest.price=value;
         latest.time =rates[shift].time;
         latest.shift=shift;
         continue;
        }

      previous.type =type;
      previous.price=value;
      previous.time =rates[shift].time;
      previous.shift=shift;
      return(true);
     }

   return(false);
  }

double SGHNormalizePrice(const string symbol,const double price)
  {
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   return(NormalizeDouble(price,digits));
  }

// Returns true only when an actionable pending-order candidate is present.
// Inspect out.status to distinguish ordinary "no setup" from data/tick errors.
bool SGHGenerateSignal(const string symbol,const SGHEffectiveProfile &profile,
                       SGHSignal &out)
  {
   SGHResetSignal(out,symbol,profile.signalTimeframe);

   const double point=SGHRawPoint(symbol);
   const double normalized_point=SGHNormalizedPoint(symbol);
   if(point<=0.0 || normalized_point<=0.0)
     {
      out.status=SGH_STATUS_BAD_SYMBOL;
      out.errorCode=GetLastError();
      return(false);
     }

   out.rawPoint=point;
   out.normalizedPoint=normalized_point;

   MqlRates rates[];
   ArrayResize(rates,profile.copyRatesCount);
   ArraySetAsSeries(rates,true);
   ResetLastError();
   const int copied=CopyRates(symbol,profile.signalTimeframe,0,
                              profile.copyRatesCount,rates);
   out.copiedRates=copied;
   if(copied!=profile.copyRatesCount)
     {
      out.status=SGH_STATUS_NOT_ENOUGH_RATES;
      out.errorCode=GetLastError();
      return(false);
     }

   double high_buffer[];
   double low_buffer[];
   double zigzag_buffer[];

   // Recovered code applies normal 3/5-digit scaling to the 10-point ZigZag
   // deviation.  Entry/SL/TP formulas below intentionally use raw Point.
   const double deviation_price=
      profile.zigzagDeviationPoints*normalized_point;

   if(!SGHBuildZigZag(rates,profile.swingDepth,deviation_price,
                      profile.zigzagBackstep,high_buffer,low_buffer,
                      zigzag_buffer))
     {
      out.status=SGH_STATUS_ERROR;
      return(false);
     }

   SGHExtremum latest;
   SGHExtremum previous;
   if(!SGHFindLatestTwoExtrema(rates,high_buffer,low_buffer,zigzag_buffer,
                               profile.extremaScanLimit,latest,previous))
     {
      out.status=SGH_STATUS_NOT_ENOUGH_SWINGS;
      return(false);
     }
   out.latestExtremum=latest;
   out.previousExtremum=previous;

   MqlTick tick;
   ResetLastError();
   if(!SymbolInfoTick(symbol,tick))
     {
      out.status=SGH_STATUS_NO_TICK;
      out.errorCode=GetLastError();
      return(false);
     }

   out.bid=tick.bid;
   out.ask=tick.ask;

   // UNCERTAIN EDGE: JIT evidence proves a 10-point trigger and proves normal
   // 3/5-digit scaling in this swing path, but it does not isolate whether the
   // multiplier is applied before or after this exact comparison.  Using the
   // normalized point is exact on the captured two-digit XAUUSD and is the
   // conventional cross-digit interpretation.
   out.triggerDistance=SGH_TRIGGER_DISTANCE_POINTS*normalized_point;

   // JIT names: latest=x11 (newer), previous=x8 (older/actionable).  Direction
   // is selected by their prices, not by a reconstructed enum/type test:
   // older>newer -> BUY from the older high; newer>older -> SELL from the
   // older low.  This also preserves the native edge semantics if two stored
   // composite points receive the same provisional type classification.
   const SGHExtremum actionable=previous;

   if(previous.price>latest.price)
     {
      out.direction=SGH_DIRECTION_BUY_STOP;
      out.orderType=ORDER_TYPE_BUY_STOP;

      // Direction exists before actionability in the native flow.  The main
      // EA uses this raw branch to reset the opposite sticky exposure latch
      // even when the 10-point distance gate is not yet satisfied.
      if((actionable.price-tick.ask)<=out.triggerDistance)
        {
         out.status=SGH_STATUS_NO_SETUP;
         return(false);
        }

      // Recovered exact formula:
      //   buyEntry = swingHigh + offsetPoints * Point
      out.entryPrice=SGHNormalizePrice(symbol,
         actionable.price+profile.entryOffsetPoints*point);
      out.stopLossPrice=SGHNormalizePrice(symbol,
         out.entryPrice-profile.initialStopLossPoints*point);
      out.takeProfitPrice=SGHNormalizePrice(symbol,
         out.entryPrice+profile.initialTakeProfitPoints*point);
     }
   else if(latest.price>previous.price)
     {
      out.direction=SGH_DIRECTION_SELL_STOP;
      out.orderType=ORDER_TYPE_SELL_STOP;

      if((tick.bid-actionable.price)<=out.triggerDistance)
        {
         out.status=SGH_STATUS_NO_SETUP;
         return(false);
        }

      // Recovered exact formula:
      //   sellEntry = swingLow - offsetPoints * Point
      out.entryPrice=SGHNormalizePrice(symbol,
         actionable.price-profile.entryOffsetPoints*point);
      out.stopLossPrice=SGHNormalizePrice(symbol,
         out.entryPrice+profile.initialStopLossPoints*point);
      out.takeProfitPrice=SGHNormalizePrice(symbol,
         out.entryPrice-profile.initialTakeProfitPoints*point);
     }
   else
     {
      out.status=SGH_STATUS_NO_SETUP;
      return(false);
     }

   out.expiration=(datetime)(TimeCurrent()+profile.pendingExpiryHours*3600);
   out.status=SGH_STATUS_READY;
   return(true);
  }

// Recovered simultaneous-candidate edge: low wins the initial state tie;
// otherwise the opposite-buffer-zero predicates defer a bar carrying both a
// high and a low candidate.  The three-slot first-pass cleanup above decides
// which older provisional endpoint remains visible around such outside bars.
// Broker StopsLevel/FreezeLevel can still invalidate a candidate after a
// negative built-in offset places it too near price.  That is an order-
// validation concern and is deliberately not converted into a signal filter.

#endif // SGH_SIGNAL_ENGINE_MQH
//+------------------------------------------------------------------+
//| SGH_TradeEngine.mqh                                               |
//| Clean-room order, risk and protection helpers for MT5.            |
//|                                                                    |
//| Evidence labels used in this file:                                 |
//|   OBSERVED/JIT      - supported by the authorized runtime audit.   |
//|   OFFICIAL-ONLY     - advertised by the vendor, exact branch       |
//|                       semantics were not recovered.                |
//|   CLEAN-ROOM POLICY - conservative implementation choice.          |
//|                                                                    |
//| This is not original vendor source. It contains no entry-signal     |
//| reconstruction and is intended to be included by the clean-room EA.|
//+------------------------------------------------------------------+
#ifndef __SGH_TRADE_ENGINE_MQH__
#define __SGH_TRADE_ENGINE_MQH__

enum ENUM_SGH_DD_REFERENCE
  {
   SGH_DD_DAY_START_BALANCE = 0,
   SGH_DD_DAY_START_EQUITY  = 1
  };

struct SGHTradeEngineConfig
  {
   string                symbol;
   long                  magic;
   string                comment;
   bool                  verbose;
   int                   deviationPoints;

   // OBSERVED/JIT: fixed lot or equity-risk lot, with fixed-lot fallback
   // when SL is zero or symbol risk data are invalid.
   bool                  useRiskPercent;
   double                riskPercent;
   double                fixedLots;

   // OBSERVED/JIT: one-shot is directional, not global. One Buy Stop and
   // one Sell Stop may coexist; same-direction position+pending blocks.
   bool                  oneShot;
   double                duplicateTolerancePoints;

   // Entry-relative protection and pending lifetime supplied by profile.
   double                stopLossPoints;
   double                takeProfitPoints;
   int                   pendingExpirySeconds;

   // OBSERVED/JIT: trailing activates after a profit threshold and never
   // moves the stop backwards.
   double                trailStartPoints;
   double                trailDistancePoints;

   // OBSERVED/JIT: Prop Scalper starts at 2x normal SL/TP, then restores
   // normal protection after 120 seconds before normal trailing begins.
   bool                  propScalperMode;
   int                   propHoldSeconds;
   double                propInitialProtectionMultiplier;

   // Spread gate. Max <= 0 disables it. Deleting pendings on high spread
   // is directly exposed by the product input surface.
   int                   maxSpreadPoints;
   bool                  highSpreadDeletePendings;

   // OFFICIAL-ONLY: advertised account guards. They default disabled.
   bool                  useDailyProfitTarget;
   double                dailyProfitTargetMoney;
   bool                  useDailyLossLimit;
   double                dailyLossLimitMoney;
   bool                  useEquityProtection;
   double                dailyEquityProtectionPercent;
   ENUM_SGH_DD_REFERENCE ddReference;
   bool                  dailyTargetUsesEquity;
   bool                  protectionsAccountWide;

   // OFFICIAL-ONLY: exact news classification/provider is unverified.
   // The engine never invents news events. SetExternalNewsBlock() must
   // provide a known state; unknown state is fail-open/parity-safe.
   bool                  useNewsFilter;

   // Manual server-time session window recovered from the input surface.
   // Exact logging/gate order is still open: the oracle logged an order
   // attempt at 01:00 with a 01:15 reopen, then accepted on the 01:15 bar.
   bool                  useManualDailyCloseTime;
   int                   dailyCloseHour;
   int                   dailyCloseMinute;
   int                   dailyReopenHour;
   int                   dailyReopenMinute;
   bool                  dailyCloseDeletePendings;
   bool                  dailyCloseClosePositions;

   bool                  useFridayCloseProtection;
   bool                  useManualFridayCloseTime;
   int                   fridayCloseHour;
   int                   fridayCloseMinute;
   bool                  fridayCloseDeletePendings;
   bool                  fridayCloseClosePositions;
  };

struct SGHProtectionDecision
  {
   bool   blockEntries;
   bool   deletePendings;
   bool   closePositions;
   string reason;
  };

void SGHTradeEngineDefaults(SGHTradeEngineConfig &cfg)
  {
   cfg.symbol                          = _Symbol;
   cfg.magic                           = 878787;
   cfg.comment                         = "SGH clean-room";
   cfg.verbose                         = false;
   cfg.deviationPoints                 = 20;

   cfg.useRiskPercent                  = false;
   cfg.riskPercent                     = 1.0;
   cfg.fixedLots                       = 0.01;
   cfg.oneShot                         = true;
   cfg.duplicateTolerancePoints        = 1.0;

   cfg.stopLossPoints                  = 0.0;
   cfg.takeProfitPoints                = 0.0;
   cfg.pendingExpirySeconds            = 0;
   cfg.trailStartPoints                = 0.0;
   cfg.trailDistancePoints             = 0.0;

   cfg.propScalperMode                 = false;
   cfg.propHoldSeconds                 = 120;
   cfg.propInitialProtectionMultiplier = 2.0;

   cfg.maxSpreadPoints                 = 0;
   cfg.highSpreadDeletePendings        = false;

   // Unverified safety branches intentionally default OFF.
   cfg.useDailyProfitTarget            = false;
   cfg.dailyProfitTargetMoney          = 200.0;
   cfg.useDailyLossLimit               = false;
   cfg.dailyLossLimitMoney             = 100.0;
   cfg.useEquityProtection             = false;
   cfg.dailyEquityProtectionPercent    = 3.0;
   cfg.ddReference                     = SGH_DD_DAY_START_BALANCE;
   cfg.dailyTargetUsesEquity           = true;
   cfg.protectionsAccountWide          = true;
   cfg.useNewsFilter                   = false;

   cfg.useManualDailyCloseTime         = false;
   cfg.dailyCloseHour                  = 22;
   cfg.dailyCloseMinute                = 15;
   cfg.dailyReopenHour                 = 1;
   cfg.dailyReopenMinute               = 15;
   cfg.dailyCloseDeletePendings        = true;
   cfg.dailyCloseClosePositions        = true;

   cfg.useFridayCloseProtection        = false;
   cfg.useManualFridayCloseTime        = false;
   cfg.fridayCloseHour                 = 22;
   cfg.fridayCloseMinute               = 15;
   cfg.fridayCloseDeletePendings       = true;
   cfg.fridayCloseClosePositions       = true;
  }

class CSGHTradeEngine
  {
private:
   SGHTradeEngineConfig m_cfg;
   string               m_symbol;
   int                  m_digits;
   double               m_point;
   datetime             m_dayAnchor;
   double               m_dayStartBalance;
   double               m_dayStartEquity;
   bool                 m_newsStateKnown;
   bool                 m_newsBlocked;
   bool                 m_warnedUnknownNews;
   string               m_lastReason;
   ulong                m_propNormalizedTickets[];

   void Log(const string text)
     {
      if(m_cfg.verbose)
         Print("SGH TradeEngine | ",text);
     }

   void SetReason(const string text)
     {
      m_lastReason=text;
      Log(text);
     }

   void AddDecisionReason(SGHProtectionDecision &decision,const string text)
     {
      if(decision.reason=="")
         decision.reason=text;
      else if(StringFind(decision.reason,text)<0)
         decision.reason=decision.reason+"; "+text;
     }

   bool IsOurOrderSelected()
     {
      if(OrderGetString(ORDER_SYMBOL)!=m_symbol)
         return(false);
      if((long)OrderGetInteger(ORDER_MAGIC)!=m_cfg.magic)
         return(false);
      return(true);
     }

   bool IsOurPositionSelected()
     {
      if(PositionGetString(POSITION_SYMBOL)!=m_symbol)
         return(false);
      if((long)PositionGetInteger(POSITION_MAGIC)!=m_cfg.magic)
         return(false);
      return(true);
     }

   bool IsPendingType(const ENUM_ORDER_TYPE type)
     {
      return(type==ORDER_TYPE_BUY_LIMIT || type==ORDER_TYPE_SELL_LIMIT ||
             type==ORDER_TYPE_BUY_STOP  || type==ORDER_TYPE_SELL_STOP  ||
             type==ORDER_TYPE_BUY_STOP_LIMIT || type==ORDER_TYPE_SELL_STOP_LIMIT);
     }

   bool IsBuyPendingType(const ENUM_ORDER_TYPE type)
     {
      return(type==ORDER_TYPE_BUY_LIMIT || type==ORDER_TYPE_BUY_STOP ||
             type==ORDER_TYPE_BUY_STOP_LIMIT);
     }

   bool IsSellPendingType(const ENUM_ORDER_TYPE type)
     {
      return(type==ORDER_TYPE_SELL_LIMIT || type==ORDER_TYPE_SELL_STOP ||
             type==ORDER_TYPE_SELL_STOP_LIMIT);
     }

   int VolumeDigits(const double step)
     {
      if(step<=0.0)
         return(2);
      for(int digits=0; digits<=8; digits++)
        {
         const double scaled=step*MathPow(10.0,digits);
         if(MathAbs(scaled-MathRound(scaled))<1.0e-8)
            return(digits);
        }
      return(8);
     }

   ENUM_ORDER_TYPE_FILLING MarketFillingMode()
     {
      const long modes=SymbolInfoInteger(m_symbol,SYMBOL_FILLING_MODE);
      if((modes & SYMBOL_FILLING_FOK)==SYMBOL_FILLING_FOK)
         return(ORDER_FILLING_FOK);
      if((modes & SYMBOL_FILLING_IOC)==SYMBOL_FILLING_IOC)
         return(ORDER_FILLING_IOC);
      return(ORDER_FILLING_RETURN);
     }

   double BrokerMinimumDistancePrice()
     {
      const long stopLevel=SymbolInfoInteger(m_symbol,SYMBOL_TRADE_STOPS_LEVEL);
      const long freezeLevel=SymbolInfoInteger(m_symbol,SYMBOL_TRADE_FREEZE_LEVEL);
      long distanceLevel=stopLevel;
      if(freezeLevel>distanceLevel)
         distanceLevel=freezeLevel;
      return((double)distanceLevel*m_point);
     }

   ulong Deviation()
     {
      if(m_cfg.deviationPoints<=0)
         return(0);
      return((ulong)m_cfg.deviationPoints);
     }

   bool TradeEnvironmentReady()
     {
      if(!MQLInfoInteger(MQL_TESTER) && !TerminalInfoInteger(TERMINAL_CONNECTED))
        {
         SetReason("Terminal is not connected");
         return(false);
        }
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ||
         !MQLInfoInteger(MQL_TRADE_ALLOWED) ||
         !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
        {
         SetReason("Trading is not allowed");
         return(false);
        }
      return(true);
     }

   bool TradeResultSucceeded(const MqlTradeResult &result,const bool pendingRequest)
     {
      if(pendingRequest)
         return(result.retcode==TRADE_RETCODE_PLACED ||
                result.retcode==TRADE_RETCODE_DONE ||
                result.retcode==TRADE_RETCODE_DONE_PARTIAL);
      return(result.retcode==TRADE_RETCODE_DONE ||
             result.retcode==TRADE_RETCODE_DONE_PARTIAL ||
             result.retcode==TRADE_RETCODE_PLACED);
     }

   datetime ServerDayAnchor(const datetime when)
     {
      MqlDateTime tm;
      TimeToStruct(when,tm);
      tm.hour=0;
      tm.min=0;
      tm.sec=0;
      return(StructToTime(tm));
     }

   double RealizedTradingPnl(const datetime from,const datetime to)
     {
      if(!HistorySelect(from,to))
         return(0.0);

      double pnl=0.0;
      const int count=HistoryDealsTotal();
      for(int i=0;i<count;i++)
        {
         const ulong ticket=HistoryDealGetTicket(i);
         if(ticket==0)
            continue;

         const ENUM_DEAL_TYPE dealType=(ENUM_DEAL_TYPE)HistoryDealGetInteger(ticket,DEAL_TYPE);
         if(dealType!=DEAL_TYPE_BUY && dealType!=DEAL_TYPE_SELL)
            continue;

         if(!m_cfg.protectionsAccountWide)
           {
            if(HistoryDealGetString(ticket,DEAL_SYMBOL)!=m_symbol)
               continue;
            if((long)HistoryDealGetInteger(ticket,DEAL_MAGIC)!=m_cfg.magic)
               continue;
           }

         pnl+=HistoryDealGetDouble(ticket,DEAL_PROFIT);
         pnl+=HistoryDealGetDouble(ticket,DEAL_SWAP);
         pnl+=HistoryDealGetDouble(ticket,DEAL_COMMISSION);
         pnl+=HistoryDealGetDouble(ticket,DEAL_FEE);
        }
      return(pnl);
     }

   void SyncDayState(const datetime now)
     {
      const datetime anchor=ServerDayAnchor(now);
      if(anchor==m_dayAnchor)
         return;

      m_dayAnchor=anchor;
      const double realized=RealizedTradingPnl(anchor,now);
      // CLEAN-ROOM POLICY: reconstruct the day-opening balance so an EA
      // restart does not reset the monetary daily limit.
      m_dayStartBalance=AccountInfoDouble(ACCOUNT_BALANCE)-realized;
      // Exact original handling of pre-existing floating P/L is unverified.
      // Current equity is the least surprising restart-safe reference.
      m_dayStartEquity=AccountInfoDouble(ACCOUNT_EQUITY);
      m_warnedUnknownNews=false;
     }

   bool IsInDailyClosedWindow(const datetime now)
     {
      if(!m_cfg.useManualDailyCloseTime)
         return(false);

      MqlDateTime tm;
      TimeToStruct(now,tm);
      const int current=tm.hour*60+tm.min;
      const int closeAt=m_cfg.dailyCloseHour*60+m_cfg.dailyCloseMinute;
       // Oracle quirk: the reopen minute input is displayed as 15, but the
       // entry gate reopens at the beginning of that hour.  The original then
       // attempts at 01:00 (the broker may reject Market closed) and retries at
       // 01:15.  This is hour-relative behavior, not a date exception.
       const int reopenAt=m_cfg.dailyReopenHour*60;

      if(closeAt==reopenAt)
         return(false);
      if(closeAt>reopenAt)
         return(current>=closeAt || current<reopenAt);
      return(current>=closeAt && current<reopenAt);
     }

   bool IsFridayClosed(const datetime now)
     {
      if(!m_cfg.useFridayCloseProtection || !m_cfg.useManualFridayCloseTime)
         return(false);

      MqlDateTime tm;
      TimeToStruct(now,tm);
      if(tm.day_of_week==0 || tm.day_of_week==6)
         return(true);
      if(tm.day_of_week!=5)
         return(false);

      const int current=tm.hour*60+tm.min;
      const int closeAt=m_cfg.fridayCloseHour*60+m_cfg.fridayCloseMinute;
      return(current>=closeAt);
     }

   bool IsSymbolTradeSessionOpen(const string symbol)
     {
      // Native helper +0x8BD0 checks the broker's recurring trade sessions,
      // not a hardcoded clock window.  Prefer trade-server time and fall back
      // to the latest server tick time if it is temporarily unavailable.
      datetime now=TimeTradeServer();
      if(now<=0)
         now=TimeCurrent();

      MqlDateTime current;
      if(now<=0 || !TimeToStruct(now,current))
         return(false);
      const int currentSeconds=current.hour*3600+current.min*60+current.sec;

      for(uint index=0;index<10;index++)
        {
         datetime from=0;
         datetime to=0;
         if(!SymbolInfoSessionTrade(symbol,
                                    (ENUM_DAY_OF_WEEK)current.day_of_week,
                                    index,from,to))
           {
            if(index==0)
              {
               long mode=SYMBOL_TRADE_MODE_DISABLED;
               if(!SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE,mode))
                  return(false);
               // Exact fallback predicate: (mode-1)<4, i.e. modes 1..4.
               return(mode>=SYMBOL_TRADE_MODE_LONGONLY &&
                      mode<=SYMBOL_TRADE_MODE_FULL);
              }
            break;
           }

         MqlDateTime startParts;
         MqlDateTime endParts;
         if(!TimeToStruct(from,startParts) || !TimeToStruct(to,endParts))
            continue;
         const int startSeconds=
            startParts.hour*3600+startParts.min*60+startParts.sec;
         const int endSeconds=
            endParts.hour*3600+endParts.min*60+endParts.sec;

         // Start is inclusive and end is exclusive.  Wrapped sessions cross
         // midnight and therefore use OR rather than AND.
         if(startSeconds<=endSeconds)
           {
            if(currentSeconds>=startSeconds && currentSeconds<endSeconds)
               return(true);
           }
         else if(currentSeconds>=startSeconds || currentSeconds<endSeconds)
            return(true);
        }
      return(false);
     }

   bool PropTicketProcessed(const ulong ticket)
     {
      const int size=ArraySize(m_propNormalizedTickets);
      for(int i=0;i<size;i++)
         if(m_propNormalizedTickets[i]==ticket)
            return(true);
      return(false);
     }

   void MarkPropTicketProcessed(const ulong ticket)
     {
      if(PropTicketProcessed(ticket))
         return;
      const int size=ArraySize(m_propNormalizedTickets);
      ArrayResize(m_propNormalizedTickets,size+1);
      m_propNormalizedTickets[size]=ticket;
     }

   void PrunePropTickets()
     {
      int writeIndex=0;
      const int size=ArraySize(m_propNormalizedTickets);
      for(int i=0;i<size;i++)
        {
         if(PositionSelectByTicket(m_propNormalizedTickets[i]))
           {
            m_propNormalizedTickets[writeIndex]=m_propNormalizedTickets[i];
            writeIndex++;
           }
        }
      if(writeIndex!=size)
         ArrayResize(m_propNormalizedTickets,writeIndex);
     }

   bool BuildProtectionPrices(const ENUM_ORDER_TYPE orderType,
                              const double entryPrice,
                              const bool initialPropProtection,
                              double &sl,double &tp)
     {
      double multiplier=1.0;
      if(m_cfg.propScalperMode && initialPropProtection)
         multiplier=MathMax(1.0,m_cfg.propInitialProtectionMultiplier);

      const double slDistance=m_cfg.stopLossPoints*m_point*multiplier;
      const double tpDistance=m_cfg.takeProfitPoints*m_point*multiplier;
      sl=0.0;
      tp=0.0;

      if(orderType==ORDER_TYPE_BUY || orderType==ORDER_TYPE_BUY_STOP)
        {
         if(slDistance>0.0)
            sl=NormalizePrice(entryPrice-slDistance);
         if(tpDistance>0.0)
            tp=NormalizePrice(entryPrice+tpDistance);
        }
      else if(orderType==ORDER_TYPE_SELL || orderType==ORDER_TYPE_SELL_STOP)
        {
         if(slDistance>0.0)
            sl=NormalizePrice(entryPrice+slDistance);
         if(tpDistance>0.0)
            tp=NormalizePrice(entryPrice-tpDistance);
        }
      else
         return(false);
      return(true);
     }

   bool ValidatePendingGeometry(const ENUM_ORDER_TYPE orderType,
                                const double entryPrice,
                                const double sl,const double tp)
     {
      MqlTick tick;
      if(!SymbolInfoTick(m_symbol,tick))
        {
         SetReason("No current tick");
         return(false);
        }

      const double minDistance=BrokerMinimumDistancePrice();
      const double epsilon=m_point*0.1;

      if(orderType==ORDER_TYPE_BUY_STOP)
        {
         if(entryPrice+epsilon<tick.ask+minDistance)
           {
            SetReason("Buy Stop too close to Ask");
            return(false);
           }
         if(sl>0.0 && (sl>=entryPrice || entryPrice-sl+epsilon<minDistance))
           {
            SetReason(sl>=entryPrice ? "Buy Stop SL invalid side" : "Buy Stop SL too close");
            return(false);
           }
         if(tp>0.0 && (tp<=entryPrice || tp-entryPrice+epsilon<minDistance))
           {
            SetReason(tp<=entryPrice ? "Buy Stop TP invalid side" : "Buy Stop TP too close");
            return(false);
           }
        }
      else if(orderType==ORDER_TYPE_SELL_STOP)
        {
         if(entryPrice-epsilon>tick.bid-minDistance)
           {
            SetReason("Sell Stop too close to Bid");
            return(false);
           }
         if(sl>0.0 && (sl<=entryPrice || sl-entryPrice+epsilon<minDistance))
           {
            SetReason(sl<=entryPrice ? "Sell Stop SL invalid side" : "Sell Stop SL too close");
            return(false);
           }
         if(tp>0.0 && (tp>=entryPrice || entryPrice-tp+epsilon<minDistance))
           {
            SetReason(tp>=entryPrice ? "Sell Stop TP invalid side" : "Sell Stop TP too close");
            return(false);
           }
        }
      else
        {
         SetReason("Only Buy Stop and Sell Stop are supported");
         return(false);
        }
      return(true);
     }

   bool CheckFreeMargin(const ENUM_ORDER_TYPE pendingType,
                        const double lots,const double entryPrice)
     {
      const ENUM_ORDER_TYPE marketType=(pendingType==ORDER_TYPE_BUY_STOP ?
                                        ORDER_TYPE_BUY : ORDER_TYPE_SELL);
      double margin=0.0;
      if(!OrderCalcMargin(marketType,m_symbol,lots,entryPrice,margin))
        {
         SetReason("No free margin: OrderCalcMargin failed");
         return(false);
        }
      if(margin>AccountInfoDouble(ACCOUNT_MARGIN_FREE)+0.01)
        {
         SetReason("Not enough free margin");
         return(false);
        }
      return(true);
     }

   bool ModifyPosition(const ulong ticket,const double sl,const double tp)
     {
      if(!PositionSelectByTicket(ticket))
         return(false);

      MqlTradeRequest request;
      MqlTradeResult result;
      ZeroMemory(request);
      ZeroMemory(result);
      request.action   = TRADE_ACTION_SLTP;
      request.position = ticket;
      request.symbol   = PositionGetString(POSITION_SYMBOL);
      request.magic    = (ulong)m_cfg.magic;
      request.sl       = (sl>0.0 ? NormalizePrice(sl) : 0.0);
      request.tp       = (tp>0.0 ? NormalizePrice(tp) : 0.0);

      ResetLastError();
      if(!OrderSend(request,result) || !TradeResultSucceeded(result,false))
        {
         SetReason(StringFormat("Position modify failed ticket=%I64u retcode=%u error=%d",
                                ticket,result.retcode,GetLastError()));
         return(false);
        }
      return(true);
     }

   bool ClosePositionByTicket(const ulong ticket)
     {
      if(!PositionSelectByTicket(ticket) || !IsOurPositionSelected())
         return(false);

      MqlTick tick;
      if(!SymbolInfoTick(m_symbol,tick))
         return(false);

      const ENUM_POSITION_TYPE positionType=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      MqlTradeRequest request;
      MqlTradeResult result;
      ZeroMemory(request);
      ZeroMemory(result);
      request.action       = TRADE_ACTION_DEAL;
      request.position     = ticket;
      request.symbol       = m_symbol;
      request.magic        = (ulong)m_cfg.magic;
      request.volume       = PositionGetDouble(POSITION_VOLUME);
      request.deviation    = Deviation();
      request.type_filling = MarketFillingMode();

      if(positionType==POSITION_TYPE_BUY)
        {
         request.type=ORDER_TYPE_SELL;
         request.price=tick.bid;
        }
      else
        {
         request.type=ORDER_TYPE_BUY;
         request.price=tick.ask;
        }

      ResetLastError();
      if(!OrderSend(request,result) || !TradeResultSucceeded(result,false))
        {
         SetReason(StringFormat("Position close failed ticket=%I64u retcode=%u error=%d",
                                ticket,result.retcode,GetLastError()));
         return(false);
        }
      return(true);
     }

   bool DeletePendingByTicket(const ulong ticket)
     {
      // The original never sends TRADE_ACTION_REMOVE while the order's
      // symbol is outside a broker trade session.  It simply retries the
      // read-only session check on later ticks and deletes on the first open
      // tick, avoiding a flood of Market-closed OrderSend failures.
      if(!OrderSelect(ticket))
         return(false);
      const string orderSymbol=OrderGetString(ORDER_SYMBOL);
      if(orderSymbol=="" || !IsSymbolTradeSessionOpen(orderSymbol))
         return(false);

      MqlTradeRequest request;
      MqlTradeResult result;
      ZeroMemory(request);
      ZeroMemory(result);
      request.action=TRADE_ACTION_REMOVE;
      request.order=ticket;
      request.magic=(ulong)m_cfg.magic;

      ResetLastError();
      if(!OrderSend(request,result) || !TradeResultSucceeded(result,false))
        {
         SetReason(StringFormat("Pending delete failed ticket=%I64u retcode=%u error=%d",
                                ticket,result.retcode,GetLastError()));
         return(false);
        }
      return(true);
     }

public:
   CSGHTradeEngine()
     {
      SGHTradeEngineDefaults(m_cfg);
      m_symbol=_Symbol;
      m_digits=(int)SymbolInfoInteger(m_symbol,SYMBOL_DIGITS);
      m_point=SymbolInfoDouble(m_symbol,SYMBOL_POINT);
      m_dayAnchor=0;
      m_dayStartBalance=0.0;
      m_dayStartEquity=0.0;
      m_newsStateKnown=false;
      m_newsBlocked=false;
      m_warnedUnknownNews=false;
      m_lastReason="";
      ArrayResize(m_propNormalizedTickets,0);
     }

   bool Configure(const SGHTradeEngineConfig &cfg)
     {
      m_cfg=cfg;
      m_symbol=(cfg.symbol=="" ? _Symbol : cfg.symbol);
      if(!SymbolSelect(m_symbol,true))
        {
         SetReason("Unable to select symbol "+m_symbol);
         return(false);
        }

      m_digits=(int)SymbolInfoInteger(m_symbol,SYMBOL_DIGITS);
      m_point=SymbolInfoDouble(m_symbol,SYMBOL_POINT);
      if(m_digits<0 || m_point<=0.0)
        {
         SetReason("Invalid symbol point/digits for "+m_symbol);
         return(false);
        }

      if(m_cfg.magic<0)
         m_cfg.magic=0;
      if(m_cfg.propHoldSeconds<=0)
         m_cfg.propHoldSeconds=120;
      if(m_cfg.propInitialProtectionMultiplier<1.0)
         m_cfg.propInitialProtectionMultiplier=2.0;
      if(m_cfg.duplicateTolerancePoints<0.0)
         m_cfg.duplicateTolerancePoints=0.0;

      m_dayAnchor=0;
      SyncDayState(TimeTradeServer());
      return(true);
     }

   string LastReason() const
     {
      return(m_lastReason);
     }

   string Symbol() const
     {
      return(m_symbol);
     }

   double PointSize() const
     {
      return(m_point);
     }

   void ApplyProfileTradeParameters(const double stopLossPoints,
                                    const double takeProfitPoints,
                                    const double trailStartPoints,
                                    const double trailDistancePoints,
                                    const int pendingExpirySeconds,
                                    const bool propScalperMode)
     {
      m_cfg.stopLossPoints=stopLossPoints;
      m_cfg.takeProfitPoints=takeProfitPoints;
      m_cfg.trailStartPoints=trailStartPoints;
      m_cfg.trailDistancePoints=trailDistancePoints;
      m_cfg.pendingExpirySeconds=pendingExpirySeconds;
      m_cfg.propScalperMode=propScalperMode;
     }

   double NormalizePrice(const double price)
     {
      return(NormalizeDouble(price,m_digits));
     }

   double NormalizeVolumeDown(const double requestedLots)
     {
      const double minimum=SymbolInfoDouble(m_symbol,SYMBOL_VOLUME_MIN);
      const double maximum=SymbolInfoDouble(m_symbol,SYMBOL_VOLUME_MAX);
      const double step=SymbolInfoDouble(m_symbol,SYMBOL_VOLUME_STEP);
      if(requestedLots<=0.0 || minimum<=0.0 || maximum<=0.0 || step<=0.0)
         return(0.0);

      const double capped=MathMin(requestedLots,maximum);
      const double normalized=MathFloor((capped+step*1.0e-9)/step)*step;
      if(normalized+step*1.0e-9<minimum)
         return(0.0); // OBSERVED/JIT: "Volume below minimum", do not clamp up.
      return(NormalizeDouble(normalized,VolumeDigits(step)));
     }

   double CurrentSpreadPoints()
     {
      MqlTick tick;
      if(!SymbolInfoTick(m_symbol,tick) || m_point<=0.0)
         return(-1.0);
      return((tick.ask-tick.bid)/m_point);
     }

   int CountOurPositions()
     {
      int count=0;
      for(int i=PositionsTotal()-1;i>=0;i--)
        {
         const ulong ticket=PositionGetTicket(i);
         if(ticket!=0 && IsOurPositionSelected())
            count++;
        }
      return(count);
     }

   int CountOurPendings()
     {
      int count=0;
      for(int i=OrdersTotal()-1;i>=0;i--)
        {
         const ulong ticket=OrderGetTicket(i);
         if(ticket==0 || !IsOurOrderSelected())
            continue;
         if(IsPendingType((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)))
            count++;
        }
      return(count);
     }

   bool HasExposure()
     {
      return(CountOurPositions()>0 || CountOurPendings()>0);
     }

   bool HasDirectionalExposure(const ENUM_ORDER_TYPE pendingType)
     {
      const bool wantBuy=(pendingType==ORDER_TYPE_BUY_STOP ||
                          pendingType==ORDER_TYPE_BUY_LIMIT ||
                          pendingType==ORDER_TYPE_BUY_STOP_LIMIT);
      const bool wantSell=(pendingType==ORDER_TYPE_SELL_STOP ||
                           pendingType==ORDER_TYPE_SELL_LIMIT ||
                           pendingType==ORDER_TYPE_SELL_STOP_LIMIT);
      if(!wantBuy && !wantSell)
         return(false);

      for(int i=PositionsTotal()-1;i>=0;i--)
        {
         const ulong ticket=PositionGetTicket(i);
         if(ticket==0 || !IsOurPositionSelected())
            continue;
         const ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         if((wantBuy && type==POSITION_TYPE_BUY) ||
            (wantSell && type==POSITION_TYPE_SELL))
            return(true);
        }

      for(int i=OrdersTotal()-1;i>=0;i--)
        {
         const ulong ticket=OrderGetTicket(i);
         if(ticket==0 || !IsOurOrderSelected())
            continue;
         const ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         if((wantBuy && IsBuyPendingType(type)) ||
            (wantSell && IsSellPendingType(type)))
            return(true);
        }
      return(false);
     }

   bool HasDuplicateExposurePrice(const double price)
     {
      // Native helper +0xF670 scans live positions first and active orders
      // second.  It is deliberately side/type agnostic and uses an inclusive
      // 50-pip band, scaled in the standard way for 3/5-digit symbols.
      const double pipScale=(m_digits==3 || m_digits==5 ? 10.0 : 1.0);
      const double tolerance=m_point*pipScale*50.0;

      for(int i=PositionsTotal()-1;i>=0;i--)
        {
         const ulong ticket=PositionGetTicket(i);
         if(ticket==0 || !IsOurPositionSelected())
            continue;
         if(MathAbs(PositionGetDouble(POSITION_PRICE_OPEN)-price)<=tolerance)
            return(true);
        }

      for(int i=OrdersTotal()-1;i>=0;i--)
        {
         const ulong ticket=OrderGetTicket(i);
         if(ticket==0 || !IsOurOrderSelected())
            continue;
         if(MathAbs(OrderGetDouble(ORDER_PRICE_OPEN)-price)<=tolerance)
            return(true);
        }
      return(false);
     }

   double ComputeLots(const double entryPrice,const double stopLossPrice)
     {
      if(!m_cfg.useRiskPercent || m_cfg.riskPercent<=0.0 ||
         stopLossPrice<=0.0 || MathAbs(entryPrice-stopLossPrice)<m_point*0.1)
        {
         if(m_cfg.useRiskPercent && stopLossPrice<=0.0)
            Log("Risk lot disabled: SL is zero. Using fixed lot.");
         return(NormalizeVolumeDown(m_cfg.fixedLots));
        }

      double tickSize=SymbolInfoDouble(m_symbol,SYMBOL_TRADE_TICK_SIZE);
      double tickValue=SymbolInfoDouble(m_symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);
      if(tickValue<=0.0)
         tickValue=SymbolInfoDouble(m_symbol,SYMBOL_TRADE_TICK_VALUE);

      const double slPriceDistance=MathAbs(entryPrice-stopLossPrice);
      if(tickSize<=0.0 || tickValue<=0.0 || slPriceDistance<=0.0)
        {
         Log("Risk lot disabled: invalid symbol risk data. Using fixed lot.");
         return(NormalizeVolumeDown(m_cfg.fixedLots));
        }

      const double riskMoney=AccountInfoDouble(ACCOUNT_EQUITY)*m_cfg.riskPercent/100.0;
      const double lossPerOneLot=(slPriceDistance/tickSize)*tickValue;
      if(riskMoney<=0.0 || lossPerOneLot<=0.0)
         return(NormalizeVolumeDown(m_cfg.fixedLots));

      const double rawLots=riskMoney/lossPerOneLot;
      const double lots=NormalizeVolumeDown(rawLots);
      if(m_cfg.verbose)
         PrintFormat("RiskLot Debug | Equity=%.2f Risk%%=%.4f RiskMoney=%.2f "
                     "SLPriceDistance=%.8f TickSize=%.8f TickValue=%.8f "
                     "LossPer1Lot=%.2f RawLots=%.8f Lots=%.8f",
                     AccountInfoDouble(ACCOUNT_EQUITY),m_cfg.riskPercent,riskMoney,
                     slPriceDistance,tickSize,tickValue,lossPerOneLot,rawLots,lots);
      return(lots);
     }

   void SetExternalNewsBlock(const bool stateKnown,const bool blocked)
     {
      m_newsStateKnown=stateKnown;
      m_newsBlocked=(stateKnown && blocked);
      if(stateKnown)
         m_warnedUnknownNews=false;
     }

   void EvaluateProtectionDecision(const datetime now,SGHProtectionDecision &decision)
     {
      decision.blockEntries=false;
      decision.deletePendings=false;
      decision.closePositions=false;
      decision.reason="";
      SyncDayState(now);

      const double spread=CurrentSpreadPoints();
      if(m_cfg.maxSpreadPoints>0 &&
         (spread<0.0 || spread>(double)m_cfg.maxSpreadPoints))
        {
         decision.blockEntries=true;
         decision.deletePendings=m_cfg.highSpreadDeletePendings;
         AddDecisionReason(decision,"HighSpread");
        }

      if(IsFridayClosed(now))
        {
         decision.blockEntries=true;
         decision.deletePendings=(decision.deletePendings ||
                                  m_cfg.fridayCloseDeletePendings);
         decision.closePositions=(decision.closePositions ||
                                  m_cfg.fridayCloseClosePositions);
         AddDecisionReason(decision,"FridayClose");
        }
      else if(IsInDailyClosedWindow(now))
        {
         decision.blockEntries=true;
         decision.deletePendings=(decision.deletePendings ||
                                  m_cfg.dailyCloseDeletePendings);
         decision.closePositions=(decision.closePositions ||
                                  m_cfg.dailyCloseClosePositions);
         AddDecisionReason(decision,"DailyClose");
        }

      if(m_cfg.useNewsFilter)
        {
         if(m_newsStateKnown && m_newsBlocked)
           {
            decision.blockEntries=true;
            AddDecisionReason(decision,"NewsFilter");
           }
         else if(!m_newsStateKnown && !m_warnedUnknownNews)
           {
            // OFFICIAL-ONLY behavior is intentionally fail-open until an
            // external, tested news oracle supplies a state.
            Log("News filter enabled but state is unknown; fail-open.");
            m_warnedUnknownNews=true;
           }
        }

      const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
      const double balance=AccountInfoDouble(ACCOUNT_BALANCE);
      const double dayMetric=(m_cfg.dailyTargetUsesEquity ? equity : balance);
      const double dayPnl=dayMetric-m_dayStartBalance;

      if(m_cfg.useDailyProfitTarget && m_cfg.dailyProfitTargetMoney>0.0 &&
         dayPnl>=m_cfg.dailyProfitTargetMoney)
        {
         decision.blockEntries=true;
         decision.deletePendings=true;
         decision.closePositions=true;
         AddDecisionReason(decision,"DailyProfitTarget");
        }

      if(m_cfg.useDailyLossLimit && m_cfg.dailyLossLimitMoney>0.0 &&
         dayPnl<=-m_cfg.dailyLossLimitMoney)
        {
         decision.blockEntries=true;
         decision.deletePendings=true;
         decision.closePositions=true;
         AddDecisionReason(decision,"DailyLossLimit");
        }

      if(m_cfg.useEquityProtection && m_cfg.dailyEquityProtectionPercent>0.0)
        {
         const double reference=(m_cfg.ddReference==SGH_DD_DAY_START_EQUITY ?
                                 m_dayStartEquity : m_dayStartBalance);
         if(reference>0.0)
           {
            const double drawdownPercent=(reference-equity)*100.0/reference;
            if(drawdownPercent>=m_cfg.dailyEquityProtectionPercent)
              {
               decision.blockEntries=true;
               decision.deletePendings=true;
               decision.closePositions=true;
               AddDecisionReason(decision,"EquityProtection");
              }
           }
        }
     }

   bool EntryAllowed(const datetime now=0)
     {
      SGHProtectionDecision decision;
      EvaluateProtectionDecision(now>0 ? now : TimeTradeServer(),decision);
      if(decision.blockEntries)
        {
         SetReason(decision.reason);
         return(false);
        }
      return(true);
     }

    int DeleteAllPendings()
     {
      if(!IsSymbolTradeSessionOpen(m_symbol))
         return(0);
      int deleted=0;
      for(int i=OrdersTotal()-1;i>=0;i--)
        {
         const ulong ticket=OrderGetTicket(i);
         if(ticket==0 || !IsOurOrderSelected())
            continue;
         if(!IsPendingType((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)))
            continue;
         if(DeletePendingByTicket(ticket))
            deleted++;
        }
       return(deleted);
      }

    int DeleteExpiredPendings(const datetime now=0)
      {
       if(m_cfg.pendingExpirySeconds<=0)
          return(0);

       const datetime currentTime=(now>0 ? now : TimeTradeServer());
       int deleted=0;
       for(int i=OrdersTotal()-1;i>=0;i--)
         {
          const ulong ticket=OrderGetTicket(i);
          if(ticket==0 || !IsOurOrderSelected())
             continue;
          if(!IsPendingType((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)))
             continue;

          const datetime setup=(datetime)OrderGetInteger(ORDER_TIME_SETUP);
          // Exact oracle boundary: a 01:15:00 order is removed on the first
          // tick strictly after 13:15:00, producing "order canceled" rather
          // than broker-native "order expired".
          if(setup>0 && currentTime>setup+m_cfg.pendingExpirySeconds)
            {
             const string orderSymbol=OrderGetString(ORDER_SYMBOL);
             if(orderSymbol!="" && IsSymbolTradeSessionOpen(orderSymbol) &&
                DeletePendingByTicket(ticket))
                deleted++;
            }
         }
       return(deleted);
      }

   int CloseAllPositions()
     {
      int closed=0;
      for(int i=PositionsTotal()-1;i>=0;i--)
        {
         const ulong ticket=PositionGetTicket(i);
         if(ticket==0 || !IsOurPositionSelected())
            continue;
         if(ClosePositionByTicket(ticket))
            closed++;
        }
      return(closed);
     }

   void RunSafetyCycle(const datetime now=0)
     {
      SGHProtectionDecision decision;
      EvaluateProtectionDecision(now>0 ? now : TimeTradeServer(),decision);
      if(decision.deletePendings)
         DeleteAllPendings();
      if(decision.closePositions)
         CloseAllPositions();
     }

   bool PlacePendingStop(const ENUM_ORDER_TYPE pendingType,
                         const double requestedEntryPrice,
                         ulong &placedTicket)
     {
      placedTicket=0;
      m_lastReason="";
      if(pendingType!=ORDER_TYPE_BUY_STOP && pendingType!=ORDER_TYPE_SELL_STOP)
        {
         SetReason("Unsupported pending order type");
         return(false);
        }
      if(!TradeEnvironmentReady() || !EntryAllowed())
         return(false);

      const double entryPrice=NormalizePrice(requestedEntryPrice);
      if(m_cfg.oneShot && HasDirectionalExposure(pendingType))
        {
         SetReason("Same-direction position or pending already exists");
         return(false);
        }
      if(HasDuplicateExposurePrice(entryPrice))
        {
         SetReason("Duplicate live price");
         return(false);
        }

      double sl=0.0;
      double tp=0.0;
      if(!BuildProtectionPrices(pendingType,entryPrice,true,sl,tp) ||
         !ValidatePendingGeometry(pendingType,entryPrice,sl,tp))
         return(false);

      const double lots=ComputeLots(entryPrice,sl);
      if(lots<=0.0)
        {
         SetReason("Volume below minimum");
         return(false);
        }
      if(!CheckFreeMargin(pendingType,lots,entryPrice))
         return(false);

      MqlTradeRequest request;
      MqlTradeCheckResult check;
      MqlTradeResult result;
      ZeroMemory(request);
      ZeroMemory(check);
      ZeroMemory(result);
      request.action       = TRADE_ACTION_PENDING;
      request.magic        = (ulong)m_cfg.magic;
      request.symbol       = m_symbol;
      request.volume       = lots;
      request.price        = entryPrice;
      request.sl           = sl;
      request.tp           = tp;
      request.deviation    = Deviation();
      request.type         = pendingType;
      request.type_filling = ORDER_FILLING_RETURN;
      request.comment      = m_cfg.comment;

       // The original manages the profile lifetime itself.  Broker-native
       // ORDER_TIME_SPECIFIED expires on the exact boundary and is observably
       // one tick too early on the captured carrier.
       request.type_time=ORDER_TIME_GTC;

      ResetLastError();
      if(!OrderCheck(request,check))
        {
         SetReason(StringFormat("OrderCheck failed retcode=%u comment=%s error=%d",
                                check.retcode,check.comment,GetLastError()));
         return(false);
        }

      ResetLastError();
      if(!OrderSend(request,result) || !TradeResultSucceeded(result,true))
        {
         SetReason(StringFormat("Pending send failed retcode=%u comment=%s error=%d",
                                result.retcode,result.comment,GetLastError()));
         return(false);
        }

      placedTicket=(result.order>0 ? result.order : result.deal);
      Log(StringFormat("Pending placed ticket=%I64u type=%d lots=%.4f price=%s SL=%s TP=%s",
                       placedTicket,(int)pendingType,lots,
                       DoubleToString(entryPrice,m_digits),DoubleToString(sl,m_digits),
                       DoubleToString(tp,m_digits)));
      return(true);
     }

   void ManagePositions(const datetime now=0)
     {
      const datetime currentTime=(now>0 ? now : TimeTradeServer());
      PrunePropTickets();

      MqlTick tick;
      if(!SymbolInfoTick(m_symbol,tick))
         return;
      const double minDistance=BrokerMinimumDistancePrice();

      for(int i=PositionsTotal()-1;i>=0;i--)
        {
         const ulong ticket=PositionGetTicket(i);
         if(ticket==0 || !IsOurPositionSelected())
            continue;

         const ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         const double openPrice=PositionGetDouble(POSITION_PRICE_OPEN);
         double currentSL=PositionGetDouble(POSITION_SL);
         double currentTP=PositionGetDouble(POSITION_TP);

         if(m_cfg.propScalperMode && !PropTicketProcessed(ticket))
           {
            const datetime openedAt=(datetime)PositionGetInteger(POSITION_TIME);
            if(currentTime-openedAt<m_cfg.propHoldSeconds)
               continue; // No normal trailing during the observed hold.

            double normalSL=0.0;
            double normalTP=0.0;
            const ENUM_ORDER_TYPE side=(type==POSITION_TYPE_BUY ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
            BuildProtectionPrices(side,openPrice,false,normalSL,normalTP);

            // Never regress a stop which was already made more protective
            // (for example after an EA restart with an existing position).
            if(type==POSITION_TYPE_BUY && currentSL>normalSL)
               normalSL=currentSL;
            if(type==POSITION_TYPE_SELL && currentSL>0.0 &&
               (normalSL<=0.0 || currentSL<normalSL))
               normalSL=currentSL;

            // Exact behavior when price has already crossed the target at
            // second 120 was not observed. Avoid sending an invalid SL/TP.
            bool geometryValid=true;
            if(type==POSITION_TYPE_BUY)
              {
               if(normalSL>0.0 && normalSL>=tick.bid-minDistance)
                  geometryValid=false;
               if(normalTP>0.0 && normalTP<=tick.ask+minDistance)
                  geometryValid=false;
              }
            else
              {
               if(normalSL>0.0 && normalSL<=tick.ask+minDistance)
                  geometryValid=false;
               if(normalTP>0.0 && normalTP>=tick.bid-minDistance)
                  geometryValid=false;
              }

            if(geometryValid && ModifyPosition(ticket,normalSL,normalTP))
              {
               MarkPropTicketProcessed(ticket);
               currentSL=normalSL;
               currentTP=normalTP;
              }
            else
               continue;
           }

         if(m_cfg.trailStartPoints<=0.0 || m_cfg.trailDistancePoints<=0.0)
            continue;

         double candidateSL=0.0;
         if(type==POSITION_TYPE_BUY)
           {
            if(tick.bid-openPrice<m_cfg.trailStartPoints*m_point)
               continue;
            candidateSL=NormalizePrice(tick.bid-m_cfg.trailDistancePoints*m_point);
            if(candidateSL>=tick.bid-minDistance)
               continue;
            if(currentSL>0.0 && candidateSL<=currentSL+m_point*0.1)
               continue;
           }
         else
           {
            if(openPrice-tick.ask<m_cfg.trailStartPoints*m_point)
               continue;
            candidateSL=NormalizePrice(tick.ask+m_cfg.trailDistancePoints*m_point);
            if(candidateSL<=tick.ask+minDistance)
               continue;
            if(currentSL>0.0 && candidateSL>=currentSL-m_point*0.1)
               continue;
           }

         ModifyPosition(ticket,candidateSL,currentTP);
        }
     }
  };

// -------------------------------------------------------------------
// Small integration API. The signal include may keep ownership of its
// SGHEffectiveProfile / SGHSignal structures and pass only the resulting
// side and entry price here, avoiding shared-structure redefinitions.
// -------------------------------------------------------------------
CSGHTradeEngine g_sghTradeEngine;

bool SGHTradeInit(const SGHTradeEngineConfig &cfg)
  {
   return(g_sghTradeEngine.Configure(cfg));
  }

void SGHTradeApplyProfile(const double stopLossPoints,
                          const double takeProfitPoints,
                          const double trailStartPoints,
                          const double trailDistancePoints,
                          const int pendingExpirySeconds,
                          const bool propScalperMode)
  {
   g_sghTradeEngine.ApplyProfileTradeParameters(stopLossPoints,
                                                takeProfitPoints,
                                                trailStartPoints,
                                                trailDistancePoints,
                                                pendingExpirySeconds,
                                                propScalperMode);
  }

bool SGHSafetyGate(const datetime now=0)
  {
   return(g_sghTradeEngine.EntryAllowed(now));
  }

void SGHSetNewsBlock(const bool stateKnown,const bool blocked)
  {
   g_sghTradeEngine.SetExternalNewsBlock(stateKnown,blocked);
  }

bool SGHSubmitSignal(const ENUM_ORDER_TYPE pendingType,
                     const double entryPrice,ulong &placedTicket)
  {
   return(g_sghTradeEngine.PlacePendingStop(pendingType,entryPrice,placedTicket));
  }

#ifdef SGH_SIGNAL_ENGINE_MQH
// Convenience overloads are available when SGH_SignalEngine.mqh is included
// first. The primitive overload above keeps this module independently usable.
void SGHTradeApplyProfile(const SGHEffectiveProfile &profile)
  {
   long expirySeconds=profile.pendingExpiryHours*3600;
   if(expirySeconds>2147483647)
      expirySeconds=2147483647;
   if(expirySeconds<0)
      expirySeconds=0;
   SGHTradeApplyProfile(profile.stopLossPoints,profile.takeProfitPoints,
                        profile.trailStartPoints,profile.trailDistancePoints,
                        (int)expirySeconds,profile.isPropScalper);
  }

bool SGHSubmitSignal(const SGHSignal &signal,ulong &placedTicket)
  {
   placedTicket=0;
   if(signal.status!=SGH_STATUS_READY)
      return(false);
   if(signal.orderType!=ORDER_TYPE_BUY_STOP &&
      signal.orderType!=ORDER_TYPE_SELL_STOP)
      return(false);
   return(SGHSubmitSignal(signal.orderType,signal.entryPrice,placedTicket));
  }
#endif

void SGHManage(const datetime now=0)
  {
   g_sghTradeEngine.RunSafetyCycle(now);
   g_sghTradeEngine.DeleteExpiredPendings(now);
   g_sghTradeEngine.ManagePositions(now);
  }

#endif // __SGH_TRADE_ENGINE_MQH__

input group "MODE SETTINGS"
input ENUM_SGH_PROFILE_MODE inp_Mode=SGH_MODE_SCALPER;

input group "RISK SETTINGS"
input bool   inp_MM=false;
input double inp_RiskPercent=1.0;
input double inp_Lots=0.01;
input int    inp_MaxSpread=0;
input bool   inp_UseHighSpreadDeletePending=false;

input group "CUSTOM MODE SETTINGS"
input double inp_TP=250.0;
input double inp_SL=1500.0;
input double inp_TrailStart=100.0;
input double inp_TrailStop=50.0;
input int    inp_Pause=300;
input double inp_CustomPointsAway=0.0;

input group "PROP FIRM PROTECTION"
input bool   inp_UsePropFirmMode=true;
input bool   inp_UseDailyProfitTarget=false;
input double inp_DailyProfitTargetUSD=200.0;
input bool   inp_UseDailyLossLimit=false;
input double inp_DailyLossLimitUSD=100.0;
input bool   inp_UseEquityProtection=false;
input double inp_DailyEquityProtectionPercent=3.0;
input ENUM_SGH_DD_REFERENCE inp_DailyDDReference=SGH_DD_DAY_START_BALANCE;
input bool   inp_UseNewsFilter=false;
input int    inp_NewsMinutesBefore=30;
input int    inp_NewsMinutesAfter=30;
input bool   inp_UseManualDailyCloseTime=true;
input int    inp_DailyCloseHour=22;
input int    inp_DailyCloseMinute=15;
input int    inp_DailyReopenHour=1;
input int    inp_DailyReopenMinute=15;
input bool   inp_DailyCloseDeletePendings=true;
input bool   inp_DailyCloseClosePositions=true;
input bool   inp_UseFridayCloseProtection=true;
input bool   inp_UseManualFridayCloseTime=true;
input int    inp_FridayCloseHour=22;
input int    inp_FridayCloseMinute=15;
input bool   inp_FridayCloseDeletePendings=true;
input bool   inp_FridayCloseClosePositions=true;
input bool   inp_ShowPanel=false;

input group "EXPERT SETTINGS"
input long   inp_MagicNo=878787;
input string inp_TradeComment="@fundedtoday updatedV3";

SGHEffectiveProfile g_sghProfile;
int                 g_sghLastSignalBars=-1;

// Native sticky exposure memory.  Seeing a matching open position latches
// that side even after it closes.  The opposite raw ZigZag direction clears
// it.  Pending orders alone never set these latches.
bool g_sghBuyExposureLatch =false;
bool g_sghSellExposureLatch=false;

// Capture the native directional-exposure view before any tick-driven
// management can close a position or delete an expired pending.  The native
// signal gate consumes this frozen view later in the same tick, while the
// trade engine still performs its normal post-management live/duplicate scan.
void SGHSnapshotPreManageDirectionalExposure(int &buyExposureCount,
                                              int &sellExposureCount)
  {
   buyExposureCount=0;
   sellExposureCount=0;

   const int total=PositionsTotal();
   for(int i=0;i<total;i++)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket==0)
         continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol)
         continue;
      if((long)PositionGetInteger(POSITION_MAGIC)!=inp_MagicNo)
         continue;

      const ENUM_POSITION_TYPE type=
         (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      if(type==POSITION_TYPE_BUY)
        {
         buyExposureCount++;
         g_sghBuyExposureLatch=true;
        }
      else if(type==POSITION_TYPE_SELL)
        {
         sellExposureCount++;
         g_sghSellExposureLatch=true;
        }
     }

   const int orderTotal=OrdersTotal();
   for(int i=0;i<orderTotal;i++)
     {
      const ulong ticket=OrderGetTicket(i);
      if(ticket==0)
         continue;
      if(OrderGetString(ORDER_SYMBOL)!=_Symbol)
         continue;
      if((long)OrderGetInteger(ORDER_MAGIC)!=inp_MagicNo)
         continue;

      // The recovered native counters are exact BUY_STOP/SELL_STOP counts;
      // limit and stop-limit orders do not participate in this gate.
      const ENUM_ORDER_TYPE type=
         (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type==ORDER_TYPE_BUY_STOP)
         buyExposureCount++;
      else if(type==ORDER_TYPE_SELL_STOP)
         sellExposureCount++;
     }
  }

bool SGHStickySideBlocks(const SGHSignal &signal)
  {
   if(signal.direction==SGH_DIRECTION_BUY_STOP)
     {
      // Native resets the opposite latch on raw direction, before the
      // trigger-distance check.
      g_sghSellExposureLatch=false;
      return(g_sghBuyExposureLatch);
     }
   if(signal.direction==SGH_DIRECTION_SELL_STOP)
     {
      g_sghBuyExposureLatch=false;
      return(g_sghSellExposureLatch);
     }
   return(false);
  }

datetime SGHLastMatchingPauseDealTime(const datetime now)
  {
   if(!HistorySelect(0,now))
      return(0);

   datetime latest=0;
   const int total=HistoryDealsTotal();
   for(int i=0;i<total;i++)
     {
      const ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0)
         continue;
      if(HistoryDealGetString(ticket,DEAL_SYMBOL)!=_Symbol)
         continue;
      if((long)HistoryDealGetInteger(ticket,DEAL_MAGIC)!=inp_MagicNo)
         continue;

      // Native JIT reads integer property 4 (DEAL_TYPE), then applies the
      // exact predicate (value & ~2) == 1.  With the preceding symbol and
      // magic filters this normally selects SELL deals; preserve the bit
      // predicate instead of substituting an entry/exit interpretation.
      const int dealType=(int)HistoryDealGetInteger(ticket,DEAL_TYPE);
      if((dealType & ~2)!=1)
         continue;

      const datetime when=(datetime)HistoryDealGetInteger(ticket,DEAL_TIME);
      if(when>latest)
         latest=when;
     }
   return(latest);
  }

bool SGHConfigureProfile()
  {
   return(SGHResolveProfile((int)inp_Mode,
                            inp_TP,
                            inp_SL,
                            inp_TrailStart,
                            inp_TrailStop,
                            inp_Pause,
                            inp_CustomPointsAway,
                            g_sghProfile));
  }

void SGHBuildTradeConfiguration(SGHTradeEngineConfig &cfg)
  {
   SGHTradeEngineDefaults(cfg);
   cfg.symbol=_Symbol;
   cfg.magic=inp_MagicNo;
   cfg.comment=inp_TradeComment;
   cfg.verbose=false;
   cfg.deviationPoints=20;

   cfg.useRiskPercent=inp_MM;
   cfg.riskPercent=inp_RiskPercent;
   cfg.fixedLots=inp_Lots;
   cfg.oneShot=true;                    // one exposure per direction
   cfg.duplicateTolerancePoints=0.0;    // retained API field; native band is fixed

   cfg.maxSpreadPoints=inp_MaxSpread;
   cfg.highSpreadDeletePendings=inp_UseHighSpreadDeletePending;

   // The original groups these controls under its Prop Firm Protection
   // master input.  Disabled children remain inert when the master is off.
   cfg.useDailyProfitTarget=(inp_UsePropFirmMode && inp_UseDailyProfitTarget);
   cfg.dailyProfitTargetMoney=inp_DailyProfitTargetUSD;
   cfg.useDailyLossLimit=(inp_UsePropFirmMode && inp_UseDailyLossLimit);
   cfg.dailyLossLimitMoney=inp_DailyLossLimitUSD;
   cfg.useEquityProtection=(inp_UsePropFirmMode && inp_UseEquityProtection);
   cfg.dailyEquityProtectionPercent=inp_DailyEquityProtectionPercent;
   cfg.ddReference=inp_DailyDDReference;
   cfg.dailyTargetUsesEquity=true;
   cfg.protectionsAccountWide=true;
   cfg.useNewsFilter=(inp_UsePropFirmMode && inp_UseNewsFilter);

   cfg.useManualDailyCloseTime=(inp_UsePropFirmMode && inp_UseManualDailyCloseTime);
   cfg.dailyCloseHour=inp_DailyCloseHour;
   cfg.dailyCloseMinute=inp_DailyCloseMinute;
   cfg.dailyReopenHour=inp_DailyReopenHour;
   cfg.dailyReopenMinute=inp_DailyReopenMinute;
   cfg.dailyCloseDeletePendings=inp_DailyCloseDeletePendings;
   cfg.dailyCloseClosePositions=inp_DailyCloseClosePositions;

   cfg.useFridayCloseProtection=(inp_UsePropFirmMode && inp_UseFridayCloseProtection);
   cfg.useManualFridayCloseTime=inp_UseManualFridayCloseTime;
   cfg.fridayCloseHour=inp_FridayCloseHour;
   cfg.fridayCloseMinute=inp_FridayCloseMinute;
   cfg.fridayCloseDeletePendings=inp_FridayCloseDeletePendings;
   cfg.fridayCloseClosePositions=inp_FridayCloseClosePositions;
  }

int OnInit()
  {
   if(!SGHConfigureProfile())
     {
      Print("Smart Gold Hunter v2.0 decompiled by Jamo886: invalid profile configuration");
      return(INIT_PARAMETERS_INCORRECT);
     }

   SGHTradeEngineConfig cfg;
   SGHBuildTradeConfiguration(cfg);
   if(!SGHTradeInit(cfg))
     {
      Print("Smart Gold Hunter v2.0 decompiled by Jamo886: trade engine initialization failed");
      return(INIT_FAILED);
     }

   SGHTradeApplyProfile(g_sghProfile);
   g_sghLastSignalBars=-1;
   g_sghBuyExposureLatch=false;
   g_sghSellExposureLatch=false;

   PrintFormat("Smart Gold Hunter v2.0 decompiled by Jamo886 initialized | profile=%s tf=%s depth=%d",
               g_sghProfile.profileName,
               EnumToString(g_sghProfile.signalTimeframe),
               g_sghProfile.swingDepth);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   PrintFormat("Smart Gold Hunter v2.0 decompiled by Jamo886 terminated | reason=%d",reason);
  }

void OnTick()
  {
   // Native snapshots matching directional exposure before management.  An
   // expired pending deleted below therefore still blocks a replacement on
   // this tick/bar, and a position closed below remains visible to the gate.
   int preManageBuyExposureCount=0;
   int preManageSellExposureCount=0;
   SGHSnapshotPreManageDirectionalExposure(preManageBuyExposureCount,
                                           preManageSellExposureCount);

   // Protection and trailing paths are tick-driven in the oracle.
   SGHManage();

   // Native order is safety -> SELL-deal pause -> Bars() latch -> signal.
   // A blocked/paused bar is intentionally not consumed and can be retried
   // later in that same bar when the gate clears.
   if(!SGHSafetyGate())
      return;

   const datetime now=TimeCurrent();
   const datetime lastPauseDeal=SGHLastMatchingPauseDealTime(now);
   if(lastPauseDeal>0 && now-lastPauseDeal<g_sghProfile.pauseSeconds)
      return;

   const int signalBars=Bars(_Symbol,g_sghProfile.signalTimeframe);
   if(signalBars<=0 || signalBars==g_sghLastSignalBars)
      return;
   // Native latch starts at -1: the first eligible tick is evaluated rather
   // than merely seeding and returning.
   g_sghLastSignalBars=signalBars;

   SGHSignal signal;
   const bool ready=SGHGenerateSignal(_Symbol,g_sghProfile,signal);

   // Apply the raw-direction reset even when distance/actionability failed.
   const bool stickyBlocked=SGHStickySideBlocks(signal);
   if(!ready || stickyBlocked)
      return;

   // Consume the frozen pre-management counters.  SGHSubmitSignal retains
   // the independent live directional and duplicate-price checks against the
   // post-management order book.
   if((signal.direction==SGH_DIRECTION_BUY_STOP &&
       preManageBuyExposureCount>0) ||
      (signal.direction==SGH_DIRECTION_SELL_STOP &&
       preManageSellExposureCount>0))
      return;

   ulong ticket=0;
   SGHSubmitSignal(signal,ticket);
  }

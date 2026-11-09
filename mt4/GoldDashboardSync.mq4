//+------------------------------------------------------------------+
//|                                     GoldDashboardSync.mq4 (EA版) |
//|        黄金震荡指数 & 马丁EA风控台 — MT4 实盘数据+12项震荡指标同步 |
//|   100%只读安全保证：绝不调用任何下单/改单/平仓函数，零交易干预！  |
//+------------------------------------------------------------------+
#property copyright "Gold Range Index Dashboard"
#property version   "2.00"
#property strict

input string DashboardUrl    = "https://gold-range-index-dashboard.onrender.com/api/mt4"; // 线上接收地址(需在MT4白名单添加域名)
input string LocalBackupUrl  = "http://localhost:3000/api/mt4";  // 本地备用接收地址(如开启本地服务也会同步)
input int    SyncIntervalSec = 5;               // 同步间隔秒数 (建议 3~10 秒)
input string GoldSymbolKey   = "XAU";           // 黄金品种匹配关键字 (自动兼容 XAUUSD / GOLD)
input int    MagicFilter     = 0;               // EA魔术号过滤 (0 = 统计账户内所有黄金订单)
input string SyncToken       = "";              // 推送口令 (与环境变量 MT4_TOKEN 一致；未设置则留空)

int OnInit() {
   Print("🚀 [GoldDashboardSync v2.0] EA已启动，正在向网站同步真实 MT4 账户 #", AccountNumber(), " 及 MT4 自带 12 项震荡指标");
   EventSetTimer(MathMax(1, SyncIntervalSec));
   PushAccountDataToWeb();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
   Comment("");
}

void OnTick() {
   // 由 OnTimer 定时触发，避免 Tick 洪峰卡顿
}

void OnTimer() {
   PushAccountDataToWeb();
}

bool IsGoldSymbol(string sym) {
   if(sym == Symbol()) return true;
   if(StringFind(sym, GoldSymbolKey) >= 0) return true;
   if(StringFind(sym, "GOLD") >= 0 || StringFind(sym, "Gold") >= 0 || StringFind(sym, "gold") >= 0) return true;
   return false;
}

// 采集单周期 MT4 原生自带的 12 项震荡指标 + ADX:
// 顺序: iATR, BearsPower, BullsPower, CCI, DeMarker, ForceIndex, Momentum, OsMA, RSI, RVI_Main, RVI_Sig, Stoch_K, Stoch_D, Williams%R, ADX, +DI, -DI
string BuildTfOsc(string sym, int tf) {
   double atr   = iATR(sym, tf, 14, 0);
   double bears = iBearsPower(sym, tf, 13, PRICE_CLOSE, 0);
   double bulls = iBullsPower(sym, tf, 13, PRICE_CLOSE, 0);
   double cci   = iCCI(sym, tf, 14, PRICE_TYPICAL, 0);
   double dem   = iDeMarker(sym, tf, 14, 0);
   double force = iForce(sym, tf, 13, MODE_EMA, PRICE_CLOSE, 0);
   double mom   = iMomentum(sym, tf, 14, PRICE_CLOSE, 0);
   double osma  = iOsMA(sym, tf, 12, 26, 9, PRICE_CLOSE, 0);
   double rsi   = iRSI(sym, tf, 14, PRICE_CLOSE, 0);
   double rviM  = iRVI(sym, tf, 10, MODE_MAIN, 0);
   double rviS  = iRVI(sym, tf, 10, MODE_SIGNAL, 0);
   double stoK  = iStochastic(sym, tf, 14, 3, 3, MODE_SMA, 0, MODE_MAIN, 0);
   double stoD  = iStochastic(sym, tf, 14, 3, 3, MODE_SMA, 0, MODE_SIGNAL, 0);
   double wpr   = iWPR(sym, tf, 14, 0);
   double adxV  = iADX(sym, tf, 14, PRICE_CLOSE, MODE_MAIN, 0);
   double pdiV  = iADX(sym, tf, 14, PRICE_CLOSE, MODE_PLUSDI, 0);
   double mdiV  = iADX(sym, tf, 14, PRICE_CLOSE, MODE_MINUSDI, 0);
   return StringConcatenate(
      DoubleToString(atr, 3), ",",
      DoubleToString(bears, 2), ",",
      DoubleToString(bulls, 2), ",",
      DoubleToString(cci, 1), ",",
      DoubleToString(dem, 3), ",",
      DoubleToString(force, 1), ",",
      DoubleToString(mom, 2), ",",
      DoubleToString(osma, 3), ",",
      DoubleToString(rsi, 1), ",",
      DoubleToString(rviM, 3), ",",
      DoubleToString(rviS, 3), ",",
      DoubleToString(stoK, 1), ",",
      DoubleToString(stoD, 1), ",",
      DoubleToString(wpr, 1), ",",
      DoubleToString(adxV, 1), ",",
      DoubleToString(pdiV, 1), ",",
      DoubleToString(mdiV, 1)
   );
}

void PushAccountDataToWeb() {
   RefreshRates();
   int    buyCount = 0, sellCount = 0, buyStopCount = 0, sellStopCount = 0;
   double buyLots = 0.0, sellLots = 0.0;
   double buyWeightedPx = 0.0, sellWeightedPx = 0.0;
   double buyPnl = 0.0, sellPnl = 0.0;

   int total = OrdersTotal();
   for(int i = 0; i < total; i++) {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(MagicFilter > 0 && OrderMagicNumber() != MagicFilter) continue;
      if(!IsGoldSymbol(OrderSymbol())) continue;

      int    type = OrderType();
      double lots = OrderLots();
      double oPx  = OrderOpenPrice();
      double pnl  = OrderProfit() + OrderSwap() + OrderCommission();

      if(type == OP_BUY) {
         buyCount++;
         buyLots += lots;
         buyWeightedPx += lots * oPx;
         buyPnl += pnl;
      } else if(type == OP_SELL) {
         sellCount++;
         sellLots += lots;
         sellWeightedPx += lots * oPx;
         sellPnl += pnl;
      } else if(type == OP_BUYSTOP || type == OP_BUYLIMIT) {
         buyStopCount++;
      } else if(type == OP_SELLSTOP || type == OP_SELLLIMIT) {
         sellStopCount++;
      }
   }

   double buyAvg  = (buyLots > 0.0)  ? (buyWeightedPx / buyLots)   : 0.0;
   double sellAvg = (sellLots > 0.0) ? (sellWeightedPx / sellLots) : 0.0;
   double totalPnl = buyPnl + sellPnl;

   double bal    = AccountBalance();
   double eq     = AccountEquity();
   double mar    = AccountMargin();
   double freeM  = AccountFreeMargin();
   double mLevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   int    accNum = AccountNumber();
   string srv    = AccountServer();
   StringReplace(srv, " ", "_");
   StringReplace(srv, "#", "");
   StringReplace(srv, "&", "");
   string symRaw = Symbol();
   string symClean = symRaw;
   StringReplace(symClean, " ", "");
   StringReplace(symClean, "#", "");
   int    sprd   = (int)MarketInfo(symRaw, MODE_SPREAD);

   // 采集 MT4 全部 6 个周期的 12 项原生震荡指标
   string oscPayload = StringConcatenate(
      "1M:",  BuildTfOsc(symRaw, PERIOD_M1),  ";",
      "5M:",  BuildTfOsc(symRaw, PERIOD_M5),  ";",
      "15M:", BuildTfOsc(symRaw, PERIOD_M15), ";",
      "1H:",  BuildTfOsc(symRaw, PERIOD_H1),  ";",
      "4H:",  BuildTfOsc(symRaw, PERIOD_H4),  ";",
      "1D:",  BuildTfOsc(symRaw, PERIOD_D1)
   );

   string qs = StringConcatenate(
      "?account=", IntegerToString(accNum),
      "&server=", srv,
      "&symbol=", symClean,
      "&bid=", DoubleToString(Bid, 2),
      "&ask=", DoubleToString(Ask, 2),
      "&spread=", IntegerToString(sprd),
      "&balance=", DoubleToString(bal, 2),
      "&equity=", DoubleToString(eq, 2),
      "&margin=", DoubleToString(mar, 2),
      "&freeMargin=", DoubleToString(freeM, 2),
      "&marginLevel=", DoubleToString(mLevel, 2),
      "&buyCount=", IntegerToString(buyCount),
      "&buyLots=", DoubleToString(buyLots, 2),
      "&buyAvgPrice=", DoubleToString(buyAvg, 2),
      "&buyPnl=", DoubleToString(buyPnl, 2),
      "&sellCount=", IntegerToString(sellCount),
      "&sellLots=", DoubleToString(sellLots, 2),
      "&sellAvgPrice=", DoubleToString(sellAvg, 2),
      "&sellPnl=", DoubleToString(sellPnl, 2),
      "&totalPnl=", DoubleToString(totalPnl, 2),
      "&buyStopCount=", IntegerToString(buyStopCount),
      "&sellStopCount=", IntegerToString(sellStopCount),
      "&osc=", oscPayload,
      "&token=", SyncToken
   );

   char postData[];
   char resultData[];
   string resultHeaders;
   ResetLastError();
   int res = WebRequest("GET", DashboardUrl + qs, "", NULL, 3000, postData, 0, resultData, resultHeaders);
   int err = GetLastError();
   int resLocal = -1;
   if(StringLen(LocalBackupUrl) > 0 && LocalBackupUrl != DashboardUrl) {
      char resData2[]; string resHdr2;
      resLocal = WebRequest("GET", LocalBackupUrl + qs, "", NULL, 1500, postData, 0, resData2, resHdr2);
   }
   if(res == 200 || resLocal == 200) {
      Comment(
         "=== 🟢 黄金震荡指数网站 v2.0 · 您的真实 MT4 账户 + 12项自带震荡指标已连接 ===\n",
         "真实账号: #", accNum, " (", srv, ") | 余额: $", DoubleToString(bal, 2), " | 净值: $", DoubleToString(eq, 2), "\n",
         "买单(Buy): ", buyCount, "层 / ", DoubleToString(buyLots, 2), "手 (均价 $", DoubleToString(buyAvg, 2), " | 浮盈 $", DoubleToString(buyPnl, 2), ")\n",
         "卖单(Sell): ", sellCount, "层 / ", DoubleToString(sellLots, 2), "手 (均价 $", DoubleToString(sellAvg, 2), " | 浮盈 $", DoubleToString(sellPnl, 2), ")\n",
         "已直传MT4原生指标: iATR / Bears / Bulls / CCI / DeM / Force / Mom / OsMA / RSI / RVI / Stoch / WPR\n",
         "同步状态: 线上=", (res == 200 ? "🟢成功" : "⚪未通"), " | 本地localhost=", (resLocal == 200 ? "🟢成功" : "⚪未开")
      );
   } else {
      Comment(
         "=== ⚠️ MT4 同步等待授权 (错误码: ", err, " / HTTP: ", res, ") ===\n",
         "您的真实账号: #", accNum, " | 余额: $", DoubleToString(bal, 2), "\n",
         "请在 MT4 顶部菜单点击：【工具(T) -> 选项(O) -> EA交易】\n",
         "勾选 ☑【允许 WebRequest 用于所列 URL】，并在下方列表添加您的网站域名！"
      );
      Print("⚠️ [GoldDashboardSync] WebRequest 失败! 错误码=", err, " HTTP=", res, " 请将网站域名添加到 MT4 工具->选项->EA交易->允许WebRequest白名单!");
   }
}

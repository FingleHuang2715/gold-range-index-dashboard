//+------------------------------------------------------------------+
//|                                     GoldDashboardSync.mq4 (EA版) |
//|        黄金震荡指数 & 马丁EA风控台 — MT4 实盘数据实时同步脚本     |
//|   100%只读安全保证：绝不调用任何下单/改单/平仓函数，零交易干预！  |
//+------------------------------------------------------------------+
#property copyright "Gold Range Index Dashboard"
#property version   "1.10"
#property strict


input string DashboardUrl    = "https://gold-range-index-dashboard.vercel.app/api/mt4"; // 线上Vercel接收地址(需在MT4白名单添加域名)
input string LocalBackupUrl  = "http://localhost:3000/api/mt4";  // 本地备用接收地址(如开启本地服务也会同步)
input int    SyncIntervalSec = 5;               // 同步间隔秒数 (建议 3~10 秒)
input string GoldSymbolKey   = "XAU";           // 黄金品种匹配关键字 (自动兼容 XAUUSD / GOLD)
input int    MagicFilter     = 0;               // EA魔术号过滤 (0 = 统计账户内所有黄金订单)
input string SyncToken       = "";              // 推送口令 (与 Vercel 环境变量 MT4_TOKEN 一致；未设置则留空)

int OnInit() {
   Print("🚀 [GoldDashboardSync] EA已启动，正在向网站同步您的真实 MT4 账户 #", AccountNumber());
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

void PushAccountDataToWeb() {
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
   string symClean = Symbol();
   StringReplace(symClean, " ", "");
   StringReplace(symClean, "#", "");
   int    sprd   = (int)MarketInfo(Symbol(), MODE_SPREAD);

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
         "=== 🟢 黄金震荡指数网站 · 您的真实 MT4 实时同步已连接 ===\n",
         "真实账号: #", accNum, " (", srv, ") | 余额: $", DoubleToString(bal, 2), " | 净值: $", DoubleToString(eq, 2), "\n",
         "买单(Buy): ", buyCount, "层 / ", DoubleToString(buyLots, 2), "手 (均价 $", DoubleToString(buyAvg, 2), " | 浮盈 $", DoubleToString(buyPnl, 2), ")\n",
         "卖单(Sell): ", sellCount, "层 / ", DoubleToString(sellLots, 2), "手 (均价 $", DoubleToString(sellAvg, 2), " | 浮盈 $", DoubleToString(sellPnl, 2), ")\n",
         "同步状态: 线上Vercel=", (res == 200 ? "🟢成功" : "⚪未通"), " | 本地localhost=", (resLocal == 200 ? "🟢成功" : "⚪未开")
      );
   } else {
      Comment(
         "=== ⚠️ MT4 同步等待授权 (错误码: ", err, " / HTTP: ", res, ") ===\n",
         "您的真实账号: #", accNum, " | 余额: $", DoubleToString(bal, 2), "\n",
         "请在 MT4 顶部菜单点击：【工具(T) -> 选项(O) -> EA交易】\n",
         "勾选 ☑【允许 WebRequest 用于所列 URL】，并在下方列表添加：\n",
         "👉 https://gold-range-index-dashboard.vercel.app\n",
         "👉 http://localhost:3000"
      );
      Print("⚠️ [GoldDashboardSync] WebRequest 失败! 错误码=", err, " HTTP=", res, " 请将 https://gold-range-index-dashboard.vercel.app 添加到 MT4 工具->选项->EA交易->允许WebRequest白名单!");
   }
}
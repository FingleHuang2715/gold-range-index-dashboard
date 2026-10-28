//+------------------------------------------------------------------+
//|                                      GoldDashboardSyncScript.mq4 |
//|   黄金震荡指数决策台 · MT4 实盘持仓只读同步【脚本版 Scripts】      |
//|   放入 MQL4\Scripts 文件夹。脚本可与马丁EA同时挂在同一张图表上！    |
//|   100% 只读：不开仓/不平仓/不改单。                                |
//+------------------------------------------------------------------+
#property copyright "Gold Range Index Dashboard"
#property version   "1.00"
#property strict
#property show_inputs   // 拖上图表时弹出参数窗口

input string   DashboardUrl = "http://localhost:3000/api/mt4"; // 网站接收地址
input string   SymbolFilter = "XAUUSD";                        // 监控品种
input int      SyncSeconds  = 3;                               // 同步间隔秒数
input string   SyncToken    = "";                              // 可选口令

// 脚本只运行一次，所以这里用死循环常驻，直到手动移除脚本/关闭图表/关闭MT4
void OnStart()
{
   while(!IsStopped())
   {
      SendAccountAndOrders();
      Sleep(MathMax(1, SyncSeconds) * 1000);
   }
   Comment("");
}
bool IsGoldSymbol(string sym)
{
   if(sym == Symbol()) return true;
   if(StringFind(sym, SymbolFilter) >= 0) return true;
   if(StringFind(sym, "XAU") >= 0 || StringFind(sym, "GOLD") >= 0 || StringFind(sym, "gold") >= 0) return true;
   return false;
}

//+------------------------------------------------------------------+
//| 汇总当前账户与黄金多空持仓/挂单并通过 WebRequest 推送到网站         |
//+------------------------------------------------------------------+
void SendAccountAndOrders()
{
   double bal        = AccountBalance();
   double eq         = AccountEquity();
   double margin     = AccountMargin();
   double freeMargin = AccountFreeMargin();
   int    leverage   = AccountLeverage();

   int    buyCount   = 0,    sellCount   = 0;
   double buyLots    = 0.0,  sellLots    = 0.0;
   double buyWeightedPx = 0.0, sellWeightedPx = 0.0;
   double buyPnl     = 0.0,  sellPnl     = 0.0;

   int    buyStopCnt = 0,    sellStopCnt = 0;
   double nearBuyStopPx = 0.0, nearSellStopPx = 0.0;

   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(!IsGoldSymbol(OrderSymbol())) continue;

      int    type = OrderType();
      double lots = OrderLots();
      double opx  = OrderOpenPrice();
      double pnl  = OrderProfit() + OrderSwap() + OrderCommission();

      if(type == OP_BUY)
      {
         buyCount++;
         buyLots += lots;
         buyWeightedPx += lots * opx;
         buyPnl += pnl;
      }
      else if(type == OP_SELL)
      {
         sellCount++;
         sellLots += lots;
         sellWeightedPx += lots * opx;
         sellPnl += pnl;
      }
      else if(type == OP_BUYSTOP)
      {
         buyStopCnt++;
         if(nearBuyStopPx == 0.0 || opx < nearBuyStopPx) nearBuyStopPx = opx;
      }
      else if(type == OP_SELLSTOP)
      {
         sellStopCnt++;
         if(nearSellStopPx == 0.0 || opx > nearSellStopPx) nearSellStopPx = opx;
      }
   }

   double buyAvgPx  = (buyLots > 0.0)  ? (buyWeightedPx / buyLots)   : 0.0;
   double sellAvgPx = (sellLots > 0.0) ? (sellWeightedPx / sellLots) : 0.0;
   double totalPnl  = buyPnl + sellPnl;
   double netLots   = MathAbs(buyLots - sellLots);
   double marginLvl = (margin > 0.0) ? (eq / margin * 100.0) : 0.0;

   double bid = MarketInfo(Symbol(), MODE_BID);
   double ask = MarketInfo(Symbol(), MODE_ASK);
   double spr = (ask - bid) * 100.0; // 黄金1美元=100点

   // 构造 URL 查询参数（使用 GET 方式兼容性最强，绝无字符编码报错）
   string qs = StringConcatenate(
      "?sym=", Symbol(),
      "&bal=", DoubleToString(bal, 2),
      "&eq=", DoubleToString(eq, 2),
      "&margin=", DoubleToString(margin, 2),
      "&freeMargin=", DoubleToString(freeMargin, 2),
      "&marginLvl=", DoubleToString(marginLvl, 1),
      "&lev=", IntegerToString(leverage),
      "&buyCnt=", IntegerToString(buyCount),
      "&buyLots=", DoubleToString(buyLots, 2),
      "&buyAvg=", DoubleToString(buyAvgPx, 2),
      "&buyPnl=", DoubleToString(buyPnl, 2),
      "&sellCnt=", IntegerToString(sellCount),
      "&sellLots=", DoubleToString(sellLots, 2),
      "&sellAvg=", DoubleToString(sellAvgPx, 2),
      "&sellPnl=", DoubleToString(sellPnl, 2),
      "&totalPnl=", DoubleToString(totalPnl, 2),
      "&buyStopCnt=", IntegerToString(buyStopCnt),
      "&sellStopCnt=", IntegerToString(sellStopCnt),
      "&buyStopPx=", DoubleToString(nearBuyStopPx, 2),
      "&sellStopPx=", DoubleToString(nearSellStopPx, 2),
      "&bid=", DoubleToString(bid, 2),
      "&ask=", DoubleToString(ask, 2),
      "&spread=", DoubleToString(spr, 1),
      "&token=", SyncToken
   );

   string fullUrl = DashboardUrl + qs;
   char   postData[];
   char   resultData[];
   string resultHeaders;

   ResetLastError();
   int res = WebRequest("GET", fullUrl, "", NULL, 2500, postData, 0, resultData, resultHeaders);

   if(res == 200)
   {
      Comment(
         "=== 🟢 黄金震荡指数网站 · MT4 实时同步已连接 ===\n",
         "同步地址: ", DashboardUrl, "\n",
         "账户余额: $", DoubleToString(bal, 2), " | 净值: $", DoubleToString(eq, 2), " | 黄金浮盈亏: $", DoubleToString(totalPnl, 2), "\n",
         "买单(Buy): ", buyCount, "层 / 共 ", DoubleToString(buyLots, 2), "手 (均价 $", DoubleToString(buyAvgPx, 2), " | 浮盈 $", DoubleToString(buyPnl, 2), ")\n",
         "卖单(Sell): ", sellCount, "层 / 共 ", DoubleToString(sellLots, 2), "手 (均价 $", DoubleToString(sellAvgPx, 2), " | 浮盈 $", DoubleToString(sellPnl, 2), ")\n",
         "多空净敞口 N: ", DoubleToString(netLots, 2), "手 | 追踪挂单: BuyStop ", buyStopCnt, "笔 / SellStop ", sellStopCnt, "笔"
      );
   }
   else
   {
      int err = GetLastError();
      Comment(
         "=== ⚠️ MT4 同步等待授权 (错误码: ", err, " / HTTP: ", res, ") ===\n",
         "若错误码为 4060，请在 MT4 顶部菜单点击：【工具(Tools) -> 选项(Options) -> EA交易(Expert Advisors)】\n",
         "勾选【允许 WebRequest 用于所列 URL】，并在下方添加：\n",
         DashboardUrl
      );
   }
}
//+------------------------------------------------------------------+

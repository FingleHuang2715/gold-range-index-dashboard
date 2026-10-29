// 黄金震荡指数网站 - 后端 (零依赖, Node 18+)
// 运行: node server.js  ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { knnModel, composite, indexSeries } = require('./model');
const PORT = process.env.PORT || 3000;
const REFRESH_MS = 20 * 60 * 1000; // 低频数据(10年日线kNN/GVZ/金十周历)缓存 20 分钟，后台静默更新不阻塞打开速度
const DISK_CACHE_FILE = path.join(os.tmpdir(), 'gold_dashboard_cache_v2.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ---------- 抓取工具 ----------
async function getJSON(url, headers = {}, timeout = 15000, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw new Error((lastErr && (lastErr.cause && lastErr.cause.code || lastErr.message)) || 'fetch failed');
}

// 实时现货黄金 XAUUSD K线接口 (华尔街见闻 DDC 行情源, 0秒延迟秒级实时, 失败自动降级 Yahoo GC=F)
async function wscnGold(periodSec, count = 600, fallbackInterval = '1h', fallbackRange = '3mo') {
  const url = `https://api-ddc-wscn.awtmt.com/market/kline?prod_code=XAUUSD&tick_count=${count}&period_type=${periodSec}&fields=tick_at,open_px,close_px,high_px,low_px`;
  try {
    const j = await getJSON(url);
    const c = j.data && j.data.candle && j.data.candle.XAUUSD;
    const fields = (j.data && j.data.fields) || ['open_px', 'close_px', 'high_px', 'low_px', 'tick_at'];
    if (!c || !c.lines || !c.lines.length) throw new Error('WSCN XAUUSD 空数据');
    const io = fields.indexOf('open_px'), ic = fields.indexOf('close_px');
    const ih = fields.indexOf('high_px'), il = fields.indexOf('low_px'), it = fields.indexOf('tick_at');
    const bars = c.lines.map((r) => ({ t: r[it], o: r[io], h: r[ih], l: r[il], c: r[ic] }))
      .filter((b) => [b.t, b.o, b.h, b.l, b.c].every((v) => v != null && !isNaN(v)));
    if (bars.length < 30) throw new Error('WSCN K线数量不足');
    return { bars, meta: { gmtoffset: 0, source: 'WSCN_XAUUSD', url } };
  } catch (e) {
    const fb = await yahoo('GC=F', fallbackInterval, fallbackRange);
    fb.meta.source = 'YAHOO_GCF_FALLBACK';
    return fb;
  }
}

async function yahoo(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const j = await getJSON(url);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('Yahoo 无数据 ' + symbol);
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some((v) => v == null)) return;
    bars.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  });
  return { bars, meta: r.meta };
}

function resample(bars, hours) {
  const step = hours * 3600, out = [];
  let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / step) * step;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  return out;
}

// ---------- 指标计算 ----------
function trueRanges(bars) {
  return bars.map((b, i) => i === 0 ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
}

function wilderATR(tr, n) {
  const out = new Array(tr.length).fill(null);
  if (tr.length < n) return out;
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  out[n - 1] = a;
  for (let i = n; i < tr.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

function adx(bars, n = 14) {
  const len = bars.length;
  if (len < n * 2 + 1) return null;
  const tr = [0], pdm = [0], mdm = [0];
  for (let i = 1; i < len; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 1; i <= n; i++) { sTR += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dxs = [];
  let pdi = 0, mdi = 0;
  for (let i = n; i < len; i++) {
    if (i > n) { sTR = sTR - sTR / n + tr[i]; sP = sP - sP / n + pdm[i]; sM = sM - sM / n + mdm[i]; }
    pdi = 100 * sP / sTR; mdi = 100 * sM / sTR;
    dxs.push(pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi));
  }
  let a = dxs.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const series = [a];
  for (let i = n; i < dxs.length; i++) { a = (a * (n - 1) + dxs[i]) / n; series.push(a); }
  return { adx: a, prev: series[series.length - 4] ?? series[0], pdi, mdi };
}

function chop(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const tr = trueRanges(bars).slice(-n);
  const w = bars.slice(-n);
  const hh = Math.max(...w.map((b) => b.h)), ll = Math.min(...w.map((b) => b.l));
  if (hh === ll) return 100;
  return 100 * Math.log10(tr.reduce((x, y) => x + y, 0) / (hh - ll)) / Math.log10(n);
}

function atrRatio(bars, fast = 14, slow = 100) {
  if (bars.length < slow + 1) return null;
  const tr = trueRanges(bars);
  const f = wilderATR(tr, fast), s = wilderATR(tr, slow);
  const i = tr.length - 1;
  return { fast: f[i], slow: s[i], ratio: f[i] / s[i] };
}

// ---- 扩展指标 ----
const pctRank = (arr, v) => (arr.filter((x) => x <= v).length / arr.length) * 100;

// Kaufman 效率比 ER: |净位移| / 路径总长, 0=纯震荡, 1=纯单边
function efficiency(bars, n = 20) {
  if (bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1)).map((b) => b.c);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
  return path === 0 ? 0 : Math.abs(w[w.length - 1] - w[0]) / path;
}

function rsi(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const c = bars.map((b) => b.c);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// 布林带宽 BBW=(上-下)/中, 及其在近 N 根内的百分位 (低=收窄挤压), 以及近20根K线穿越中轨MA20的次数 maCross20
function bbWidth(bars, n = 20, k = 2) {
  const c = bars.map((b) => b.c), s = [], mids = new Array(bars.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    const w = c.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    mids[i] = m;
    s.push((2 * k * sd) / m * 100);
  }
  if (!s.length) return null;
  let cross20 = 0;
  for (let i = Math.max(n - 1, bars.length - 20); i < bars.length; i++) {
    if (mids[i] != null && bars[i].l <= mids[i] && bars[i].h >= mids[i]) cross20++;
  }
  const recent = s.slice(-500);
  return { bbw: s[s.length - 1], pct: pctRank(recent, s[s.length - 1]), cross20 };
}

function emaLast(vals, n) { const k = 2 / (n + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }

function analyze(bars) {
  const A = adx(bars), C = chop(bars), R = atrRatio(bars);
  const last = bars[bars.length - 1];
  const ER = efficiency(bars), RS = rsi(bars), BB = bbWidth(bars);
  const atrSeries = wilderATR(trueRanges(bars), 14).filter((x) => x != null).slice(-500);
  const ema50 = bars.length >= 50 ? emaLast(bars.map((b) => b.c), 50) : null;
  const atrNow = atrSeries[atrSeries.length - 1];
  const box = (k) => {
    const w = bars.slice(-k);
    if (!w.length) return null;
    const hi = Math.max(...w.map((b) => b.h)), lo = Math.min(...w.map((b) => b.l));
    return { span: +(hi - lo).toFixed(2), hi: +hi.toFixed(2), lo: +lo.toFixed(2), net: +(w[w.length - 1].c - w[0].o).toFixed(2) };
  };
  const b14 = box(14), b24 = box(24), b48 = box(48);
  const res = {
    er: ER != null ? +ER.toFixed(3) : null,
    rsi: RS != null ? +RS.toFixed(1) : null,
    bbw: BB ? +BB.bbw.toFixed(3) : null, bbwPct: BB ? +BB.pct.toFixed(1) : null,
    maCross20: BB ? BB.cross20 : null,
    atrPct: atrSeries.length ? +pctRank(atrSeries, atrNow).toFixed(1) : null,
    ema50: ema50 && +ema50.toFixed(2), emaDist: ema50 && atrNow ? +((last.c - ema50) / atrNow).toFixed(2) : null,
    price: +last.c.toFixed(2), lastBarTime: last.t, count: bars.length,
    adx: A && +A.adx.toFixed(2), adxPrev: A && +A.prev.toFixed(2),
    pdi: A && +A.pdi.toFixed(2), mdi: A && +A.mdi.toFixed(2),
    chop: C != null ? +C.toFixed(2) : null,
    atrFast: R && +R.fast.toFixed(3), atrSlow: R && +R.slow.toFixed(3), atrRatio: R && +R.ratio.toFixed(3),
    span14: b14 && b14.span, hi14: b14 && b14.hi, lo14: b14 && b14.lo, net14: b14 && b14.net,
    span24: b24 && b24.span, hi24: b24 && b24.hi, lo24: b24 && b24.lo, net24: b24 && b24.net,
    span48: b48 && b48.span, hi48: b48 && b48.hi, lo48: b48 && b48.lo,
  };
  // 判定上涨/下跌趋势方向 (综合 +DI/-DI、EMA50偏离、近14根净涨跌、RSI)
  let dirVotes = 0;
  if (res.pdi != null && res.mdi != null) dirVotes += res.pdi > res.mdi ? 1 : -1;
  if (res.emaDist != null) dirVotes += res.emaDist > 0.2 ? 1 : res.emaDist < -0.2 ? -1 : 0;
  if (res.net14 != null) dirVotes += res.net14 > 0 ? 1 : res.net14 < 0 ? -1 : 0;
  res.trendDir = dirVotes > 0 ? 'UP' : dirVotes < 0 ? 'DOWN' : (res.pdi >= res.mdi ? 'UP' : 'DOWN');
  res.trendDirText = res.trendDir === 'UP' ? '📈 上涨趋势' : '📉 下跌趋势';
  // 状态判定 + 打分 (正=震荡, 负=单边)
  let score = 0; const notes = [];
  if (res.adx != null) {
    if (res.adx < 20) { score += 2; notes.push(`ADX ${res.adx} < 20 → 震荡`); }
    else if (res.adx > 25) { score -= 2; notes.push(`ADX ${res.adx} > 25 → 趋势`); }
    else notes.push(`ADX ${res.adx} 处于 20-25 过渡区`);
  }
  if (res.chop != null) {
    if (res.chop > 61.8) { score += 2; notes.push(`CHOP ${res.chop} > 61.8 → 震荡`); }
    else if (res.chop < 38.2) { score -= 2; notes.push(`CHOP ${res.chop} < 38.2 → 趋势`); }
    else notes.push(`CHOP ${res.chop} 处于 38.2-61.8 中性区`);
  }
  if (res.atrRatio != null) {
    if (res.atrRatio < 0.82) { score += 1; res.squeeze = true; notes.push(`ATR比率 ${res.atrRatio} < 0.82 → 波动挤压(蓄势,警惕突破)`); }
    else if (res.atrRatio > 1.25) { score -= 1; res.expansion = true; notes.push(`ATR比率 ${res.atrRatio} > 1.25 → 波动扩张`); }
    else notes.push(`ATR比率 ${res.atrRatio} 正常`);
  }
  if (res.er != null) {
    if (res.er < 0.25) { score += 1; notes.push(`效率比ER ${res.er} < 0.25 → 来回拉锯(震荡)`); }
    else if (res.er > 0.5) { score -= 1; notes.push(`效率比ER ${res.er} > 0.5 → 单向运动(趋势)`); }
    else notes.push(`效率比ER ${res.er} 中性`);
  }
  if (res.bbwPct != null) {
    if (res.bbwPct < 20) { score += 1; notes.push(`布林带宽分位 ${res.bbwPct}% 偏低 → 收窄(震荡,警惕突破)`); }
    else if (res.bbwPct > 80) { score -= 1; notes.push(`布林带宽分位 ${res.bbwPct}% 偏高 → 带宽张开(趋势)`); }
  }
  if (res.emaDist != null) {
    if (Math.abs(res.emaDist) > 2) { score -= 1; notes.push(`价格偏离EMA50 ${res.emaDist} 倍ATR → 远离均线(趋势)`); }
    else if (Math.abs(res.emaDist) < 1) { notes.push(`价格贴近EMA50(${res.emaDist}倍ATR)`); }
  }
  if (res.rsi != null && (res.rsi > 70 || res.rsi < 30)) notes.push(`RSI ${res.rsi} 进入${res.rsi > 70 ? '超买' : '超卖'}区,单边动能强`);
  res.score = score;
  res.state = score >= 4 ? 'RANGE' : score <= -4 ? 'TREND' : 'MIXED';
  res.stateText = { RANGE: '震荡', TREND: res.trendDir === 'UP' ? '单边·📈上涨趋势' : '单边·📉下跌趋势', MIXED: '过渡/不明' }[res.state];
  res.notes = notes;
  return res;
}

// ---------- 交易时段 (北京时间) ----------
function sessionInfo(date = new Date()) {
  const h = (date.getUTCHours() + 8) % 24, m = date.getUTCMinutes();
  const hm = h + m / 60;
  const act = [];
  if (hm >= 7 && hm < 15) act.push('亚洲时段');
  if (hm >= 15 && hm < 24) act.push('欧洲时段');
  if (hm >= 21 || hm < 5) act.push('美洲时段');
  if (hm >= 20 && hm < 24) act.push('欧美重叠(峰值)');
  let vol, tip;
  if (hm >= 20 && hm < 24) { vol = '峰值'; tip = '流动性最高,大行情最易出现,网格马丁风险最大'; }
  else if (hm >= 24 || hm < 5) { vol = '最高'; tip = '纽约主导,波动最大'; }
  else if (hm >= 15) { vol = '逐渐升高'; tip = '伦敦开市,波动开始放大'; }
  else if (hm >= 7) { vol = '较低'; tip = '交投清淡,方向不明显,最适合网格'; }
  else { vol = '较低/收盘清淡'; tip = '美盘尾段,流动性下降'; }
  return { bjHour: h, bjTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, active: act.length ? act : ['休整时段'], volatility: vol, tip };
}

// ---------- 金十经济日历 ----------
function bjDate(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3);
  return { y: d.getUTCFullYear(), m: String(d.getUTCMonth() + 1).padStart(2, '0'), d: String(d.getUTCDate()).padStart(2, '0') };
}

const JIN10_HEADERS = { 'x-app-id': 'fiXF2nOnDycGutVA', 'x-version': '2.0', origin: 'https://www.jin10.com', referer: 'https://www.jin10.com/' };

// 金十「经济日历周历」页面(www.jin10.com/minipro)实际使用的数据接口, 取本周完整7天(周一至周日)及下周
function weekRange() {
  const now = new Date(Date.now() + 8 * 3600e3);
  const dow = (now.getUTCDay() + 6) % 7; // 周一=0
  const f = (t) => new Date(t).toISOString().slice(0, 10);
  const mon = now.getTime() - dow * 86400e3;
  return { start: f(mon), end: f(mon + 6 * 86400e3), today: f(now.getTime()), tomorrow: f(now.getTime() + 86400e3) };
}

function fmtValUnit(v, u) {
  if (v == null || v === '') return '';
  return String(v) + (u ? String(u) : '');
}

function parseJin10(j) {
  const out = [];
  for (const row of j.data || []) {
    const e = row.data || {};
    if (row.type === 'data') {
      const u = e.unit || '';
      const fullTitle = (e.time_period || '') + (e.indicator_name || '');
      let aff = '';
      if (e.actual != null && e.actual !== '' && e.show_affect) {
        aff = e.affect === 1 ? '利多金银/美元' : e.affect === 2 ? '利空金银/美元' : '影响较小';
      }
      out.push({
        kind: 'data',
        time: e.pub_time || '',
        date: (e.pub_time || '').slice(0, 10),
        star: Number(e.star) || 0,
        country: e.country || '',
        summary: e.summary || '',
        title: fullTitle + (e.summary && e.summary !== fullTitle ? ` 【${e.summary}】` : ''),
        previous: fmtValUnit(e.previous, u),
        consensus: fmtValUnit(e.consensus, u),
        actual: fmtValUnit(e.actual, u),
        affect: aff,
        pending: e.time_status === '待定'
      });
    } else if (row.type === 'event') {
      const content = (e.event_content || e.summary || '') + (e.people && !(e.event_content || '').includes(e.people) ? ' - ' + e.people : '');
      out.push({
        kind: 'event',
        time: e.event_time || '',
        date: (e.event_time || '').slice(0, 10),
        star: Number(e.star) || 0,
        country: e.country || '',
        summary: e.summary || content,
        title: '[事件] ' + content + (e.summary && e.summary !== content ? ` 【${e.summary}】` : ''),
        previous: '', consensus: '', actual: e.time_status === '待定' ? '待定' : '', affect: '',
        pending: e.time_status === '待定'
      });
    } else if (row.type === 'holiday') {
      const d = (e.date || '').slice(0, 10);
      const hSummary = (e.country ? e.country + '-' : '') + (e.name || '');
      out.push({
        kind: 'holiday',
        time: d + ' 全天',
        date: d,
        star: 3,
        country: e.country || '',
        summary: hSummary,
        title: `[休市] ${e.exchange_name || ''} ${e.name || ''} — ${e.rest_note || '休市'}`,
        previous: '', consensus: '', actual: '休市', affect: '',
        pending: true
      });
    }
  }
  return out;
}

// 构造与金十「经济日历周历」官网 (weeklyEconomic) 1:1 完全一致的 7 天周历总览表 (日期 | 重要数据公布 | 事件与假期)
function buildWeeklyGrid(weekItems, startStr, todayStr) {
  const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const baseMs = Date.parse(startStr + 'T00:00:00Z');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dStr = new Date(baseMs + i * 86400e3).toISOString().slice(0, 10);
    const dayList = weekItems.filter((x) => x.date === dStr);
    // 官网「重要数据公布」列: 展示有 summary 的核心数据项(去重保留时间与前值/预期/公布)
    const seenData = new Set();
    const dataTags = [];
    for (const x of dayList) {
      if (x.kind === 'data' && x.summary && !seenData.has(x.summary)) {
        seenData.add(x.summary);
        dataTags.push({
          summary: x.summary, star: x.star, hm: x.time.slice(11, 16),
          country: x.country, title: x.title, previous: x.previous, consensus: x.consensus, actual: x.actual
        });
      }
    }
    // 官网「事件与假期」列: 展示事件 summary 与 假期休市 summary
    const seenEv = new Set();
    const evTags = [];
    for (const x of dayList) {
      if ((x.kind === 'event' || x.kind === 'holiday') && x.summary && !seenEv.has(x.summary)) {
        seenEv.add(x.summary);
        evTags.push({
          kind: x.kind, summary: x.summary, star: x.star, hm: x.pending ? '待定' : x.time.slice(11, 16),
          country: x.country, title: x.title
        });
      }
    }
    days.push({
      date: dStr,
      md: dStr.slice(5).replace('-', '/'),
      wd: WD[i],
      isToday: dStr === todayStr,
      dataTags,
      evTags,
      totalCount: dayList.length
    });
  }
  return days;
}

// 金十「经济日历周历」页面(www.jin10.com/minipro)实际使用的数据接口; 取本周+下周, 用于周历1:1展示与未来5日预测
async function jin10Calendar() {
  const { start, end, today, tomorrow } = weekRange();
  const add7 = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 7 * 86400e3).toISOString().slice(0, 10);
  const mk = (s, e) => `https://rili-open-api.jin10.com/data/week_info?start_date=${s}&end_date=${e}&include_holiday=true`;
  const url = mk(start, end), urlNext = mk(add7(start), add7(end));
  const [r1, r2] = await Promise.allSettled([getJSON(url, JIN10_HEADERS, 15000, 2), getJSON(urlNext, JIN10_HEADERS, 15000, 2)]);
  if (r1.status !== 'fulfilled') return { items: [], weeklyGrid: [], all: [], error: r1.reason.message, url, urlNext, start, end, today, tomorrow };
  const weekItems = parseJin10(r1.value);
  const nextItems = r2.status === 'fulfilled' ? parseJin10(r2.value) : [];
  const all = weekItems.concat(nextItems);
  all.sort((a, b) => a.time.localeCompare(b.time));
  weekItems.sort((a, b) => a.time.localeCompare(b.time));
  const weeklyGrid = buildWeeklyGrid(weekItems, start, today);
  return { items: weekItems, weeklyGrid, all, error: null, url, urlNext, start, end, today, tomorrow, nextWeekError: r2.status === 'fulfilled' ? null : r2.reason.message };
}

// ---------- 跨市场实时联动指标 (DXY美元指数 / US10Y美债 / XAG白银&金银比 / VIX恐慌 / AUTD沪金) ----------
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 6) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i] / n; mb += b[i] / n; }
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return (da > 0 && db > 0) ? +(num / Math.sqrt(da * db)).toFixed(2) : 0;
}

async function wscnMacro(xau15mBarsOrPromise) {
  const codes = 'XAUUSD.OTC,XAGUSD.OTC,DXY.OTC,US10YR.OTC,US2YR.OTC,VIX.OTC,AUTD.SGE';
  const realUrl = `https://api-ddc-wscn.awtmt.com/market/real?prod_code=${codes}&fields=prod_name,last_px,px_change,px_change_rate,high_px,low_px,open_px,preclose_px,update_time`;
  const dxyKlineUrl = 'https://api-ddc-wscn.awtmt.com/market/kline?prod_code=DXY.OTC&tick_count=150&period_type=900&fields=tick_at,open_px,close_px,high_px,low_px';
  const [rSnap, rDxy, rXau15] = await Promise.allSettled([
    getJSON(realUrl, {}, 10000, 1),
    getJSON(dxyKlineUrl, {}, 10000, 1),
    Promise.resolve(xau15mBarsOrPromise),
  ]);
  const xau15mBars = rXau15.status === 'fulfilled' && rXau15.value
    ? (Array.isArray(rXau15.value) ? rXau15.value : rXau15.value.bars)
    : null;
  if (rSnap.status !== 'fulfilled') throw new Error(rSnap.reason.message);
  const snap = (rSnap.value.data && rSnap.value.data.snapshot) || {};
  const fields = (rSnap.value.data && rSnap.value.data.fields) || [];
  const pick = (code) => {
    const row = snap[code];
    if (!row) return null;
    const g = (f) => row[fields.indexOf(f)];
    return {
      code,
      name: g('prod_name'),
      last: +Number(g('last_px')).toFixed(code.includes('US') ? 3 : 2),
      chg: +Number(g('px_change')).toFixed(code.includes('US') ? 3 : 2),
      chgPct: +Number(g('px_change_rate')).toFixed(2),
      high: +Number(g('high_px')).toFixed(code.includes('US') ? 3 : 2),
      low: +Number(g('low_px')).toFixed(code.includes('US') ? 3 : 2),
      time: g('update_time'),
    };
  };
  const xau = pick('XAUUSD.OTC'), xag = pick('XAGUSD.OTC'), dxy = pick('DXY.OTC');
  const us10y = pick('US10YR.OTC'), us2y = pick('US2YR.OTC'), vix = pick('VIX.OTC'), autd = pick('AUTD.SGE');

  let dxyAdx = null, corrXauDxy = null;
  if (rDxy.status === 'fulfilled') {
    const dc = rDxy.value.data && rDxy.value.data.candle && rDxy.value.data.candle['DXY.OTC'];
    const df = (rDxy.value.data && rDxy.value.data.fields) || ['open_px', 'close_px', 'high_px', 'low_px', 'tick_at'];
    if (dc && dc.lines && dc.lines.length >= 35) {
      const io = df.indexOf('open_px'), ic = df.indexOf('close_px'), ih = df.indexOf('high_px'), il = df.indexOf('low_px'), it = df.indexOf('tick_at');
      const dBars = dc.lines.map((r) => ({ t: r[it], o: r[io], h: r[ih], l: r[il], c: r[ic] }));
      const A = adx(dBars);
      if (A) dxyAdx = +A.adx.toFixed(1);
      if (xau15mBars && xau15mBars.length >= 25) {
        const xMap = new Map(xau15mBars.map((b) => [b.t, b.c]));
        const pairs = dBars.filter((b) => xMap.has(b.t)).slice(-21);
        if (pairs.length >= 10) {
          const rx = [], rd = [];
          for (let i = 1; i < pairs.length; i++) {
            rx.push(xMap.get(pairs[i].t) - xMap.get(pairs[i - 1].t));
            rd.push(pairs[i].c - pairs[i - 1].c);
          }
          corrXauDxy = pearsonCorr(rx, rd);
        }
      }
    }
  }

  const gsr = (xau && xag && xag.last > 0) ? +(xau.last / xag.last).toFixed(2) : null;
  const agLead = (xau && xag) ? +(xag.chgPct - xau.chgPct).toFixed(2) : null;
  const yieldSpread = (us10y && us2y) ? +((us10y.last - us2y.last) * 100).toFixed(1) : null;

  return {
    realUrl, dxyKlineUrl,
    xau, xag, dxy, us10y, us2y, vix, autd,
    dxyAdx, corrXauDxy, gsr, agLead, yieldSpread
  };
}

// ---------- 特朗普言论 & 关税/地缘/美联储突发实时监控 (7x24快讯流 + 黄金冲击量化分级) ----------
function classifyTrumpItem(title, text, wscnScore) {
  const full = `${title || ''} ${text || ''}`;
  const isDirect = /特朗普\s*[：:]|特朗普(表示|称|宣布|威胁|签署|警告|要求|呼吁|发文|下令|社交媒体)/.test(full);
  const tags = [];
  if (/关税|贸易|加征|税率|谈判|进口|出口|制裁|美加|中美|美墨|美欧|世贸/.test(full)) tags.push('关税/贸易');
  if (/美联储|鲍威尔|降息|加息|利率|央行|美元指数|强势美元|弱势美元|美元汇率|汇率|通胀|国债|美债|债务上限|赤字|税改/.test(full)) tags.push('美联储/利率/美元');
  if (/伊朗|以色列|中东|哈马斯|黎巴嫩|俄|乌|普京|泽连斯基|朝鲜|军事|打击|停火|战争|导弹|核|北约|胡塞/.test(full)) tags.push('地缘/军事冲突');
  if (/黄金|金价|储备|白银|原油|大宗商品/.test(full)) tags.push('黄金/战略储备');

  const isGoldRelevant = tags.length > 0;
  if (!isGoldRelevant) tags.push('美国内政/一般动态');

  let impactScore = 18;
  if (isGoldRelevant) {
    impactScore = 48 + (tags.length - 1) * 12 + (isDirect ? 12 : 0) + (wscnScore >= 2 ? 15 : 0);
    if (/加征.*关税|100%关税|全面关税|紧急状态|解雇鲍威尔|必须降息|大幅降息|军事打击|空袭|全面制裁|撕毁|黄金储备|停摆|违约/.test(full)) {
      impactScore += 22;
    }
  } else if (wscnScore >= 2) {
    impactScore = 35;
  }
  impactScore = Math.min(98, Math.max(10, impactScore));
  const impact = impactScore >= 70 ? 'HIGH' : impactScore >= 45 ? 'MED' : 'LOW';

  let goldBias = '影响较小(常规内政)';
  let biasCls = 'NEUT';
  if (impact !== 'LOW') {
    const bull = /加征|威胁|升级|打击|制裁|破裂|紧张|降息|弱势美元|不愿意.*签字|拒绝|报复|翻倍|不确定性|避险|关税反噬/.test(full);
    const bear = /达成.*协议|释放乐观|回暖|停火|撤军|豁免|取消关税|下调关税|谈判进展|和平/.test(full);
    if (bull && !bear) { goldBias = '📈 避险/宽松 · 偏利多黄金'; biasCls = 'RANGE'; }
    else if (bear && !bull) { goldBias = '📉 缓和/达成协议 · 偏利空黄金'; biasCls = 'TREND'; }
    else { goldBias = '⚡ 政策博弈 · 双向巨震预警'; biasCls = 'MIXED'; }
  }

  return { isDirect, tags, isGoldRelevant, impact, impactScore, goldBias, biasCls };
}

async function wscnTrump(calEvents) {
  const apiUrl = 'https://api-one-wscn.awtmt.com/apiv1/search/live?query=%E7%89%B9%E6%9C%97%E6%99%AE&limit=25';
  const j = await getJSON(apiUrl, {}, 10000, 1);
  const rawItems = (j && j.data && j.data.items) || [];
  const nowSec = Math.floor(Date.now() / 1000);

  const items = rawItems.map((x) => {
    const title = (x.title || '').trim();
    const text = (x.content_text || '').replace(/\s+/g, ' ').trim();
    const cls = classifyTrumpItem(title, text, x.score || 1);
    const ageMin = Math.max(0, Math.round((nowSec - (x.display_time || nowSec)) / 60));
    return {
      id: x.id,
      time: x.display_time,
      ageMin,
      title,
      text,
      uri: x.uri || `https://wallstreetcn.com/livenews/${x.id}`,
      wscnScore: x.score || 1,
      ...cls
    };
  });

  // 从金十周历中提取本周与特朗普/美国总统相关的日程事件
  const schedule = (calEvents || []).filter((e) => /特朗普|美国总统|白宫/.test((e.title || '') + (e.summary || ''))).map((e) => ({
    time: e.time,
    date: e.date,
    star: e.star || 3,
    title: e.title,
    summary: e.summary || '特朗普日程'
  }));

  // 检查最近 2 小时 (120分钟) 内是否有中高冲击的黄金相关特朗普言论
  const recent2h = items.filter((x) => x.ageMin <= 120 && (x.impact === 'HIGH' || x.impact === 'MED'));
  const recent6h = items.filter((x) => x.ageMin <= 360 && (x.impact === 'HIGH' || x.impact === 'MED'));

  return {
    apiUrl,
    webUrl: 'https://wallstreetcn.com/live/global',
    updatedAt: new Date().toISOString(),
    recent2hCount: recent2h.length,
    recent6hCount: recent6h.length,
    latestAlert: recent2h[0] || recent6h[0] || null,
    schedule,
    items
  };
}

// ---------- 黄金受关注度综合指数 (5维全球统计：7x24涉金快讯密度 / COMEX期货实时量比 / GLD机构ETF量比 / 沪金主连量比与资金 / 全球搜索与链上热度) ----------
let cachedAttnSlow = null, lastAttnSlowTs = 0;

function lerpVal(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

async function fetchGoldAttention(fastMode = false) {
  const prevAttn = (cache && cache.attention) || {};
  const liveStreamUrl = 'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=100';
  const searchGoldUrl = 'https://api-one-wscn.awtmt.com/apiv1/search/live?query=%E9%BB%84%E9%87%91&limit=40';
  const shfeUrl = 'https://push2.eastmoney.com/api/qt/stock/get?secid=113.aum&fields=f43,f47,f48,f49,f50,f58,f133,f170';
  const gcfUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1h&range=5d';
  const gldUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/GLD?interval=1d&range=3mo';

  // Wikipedia 30天日期范围
  const dEnd = new Date(), dStart = new Date(Date.now() - 32 * 86400e3);
  const fmtYMD = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const wikiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Gold/daily/${fmtYMD(dStart)}/${fmtYMD(dEnd)}`;
  const cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=pax-gold,tether-gold&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true';

  const needSlow = !cachedAttnSlow || !fastMode || (Date.now() - lastAttnSlowTs > 15 * 60 * 1000);
  const [rLive, rSearch, rShfe, rGcf, rGld, rWiki, rCg] = await Promise.allSettled([
    getJSON(liveStreamUrl, {}, 6000, 1),
    getJSON(searchGoldUrl, {}, 6000, 1),
    getJSON(shfeUrl, {}, 6000, 1),
    needSlow ? getJSON(gcfUrl, {}, 8000, 1) : Promise.resolve(cachedAttnSlow.gcfRaw),
    needSlow ? getJSON(gldUrl, {}, 8000, 1) : Promise.resolve(cachedAttnSlow.gldRaw),
    needSlow ? getJSON(wikiUrl, {}, 8000, 1) : Promise.resolve(cachedAttnSlow.wikiRaw),
    needSlow ? getJSON(cgUrl, {}, 8000, 1) : Promise.resolve(cachedAttnSlow.cgRaw),
  ]);

  if (needSlow) {
    cachedAttnSlow = {
      gcfRaw: rGcf.status === 'fulfilled' ? rGcf.value : (cachedAttnSlow && cachedAttnSlow.gcfRaw),
      gldRaw: rGld.status === 'fulfilled' ? rGld.value : (cachedAttnSlow && cachedAttnSlow.gldRaw),
      wikiRaw: rWiki.status === 'fulfilled' ? rWiki.value : (cachedAttnSlow && cachedAttnSlow.wikiRaw),
      cgRaw: rCg.status === 'fulfilled' ? rCg.value : (cachedAttnSlow && cachedAttnSlow.cgRaw),
    };
    lastAttnSlowTs = Date.now();
  }

  // 1) 7x24 快讯黄金提及密度与舆论关注度
  const nowSec = Math.floor(Date.now() / 1000);
  const liveItems = (rLive.status === 'fulfilled' && rLive.value && rLive.value.data && rLive.value.data.items) || [];
  const searchItems = (rSearch.status === 'fulfilled' && rSearch.value && rSearch.value.data && rSearch.value.data.items) || [];
  const seenIds = new Set();
  const goldNews = [];
  for (const x of [...liveItems, ...searchItems]) {
    if (!x || !x.id || seenIds.has(x.id)) continue;
    const txt = `${x.title || ''} ${x.content_text || ''}`.replace(/\s+/g, ' ').trim();
    if (/黄金|金价|金银|XAU|贵金属|沪金|伦敦金|COMEX金/.test(txt)) {
      seenIds.add(x.id);
      const ageMin = Math.max(0, Math.round((nowSec - (x.display_time || nowSec)) / 60));
      goldNews.push({
        id: x.id,
        time: x.display_time,
        ageMin,
        title: (x.title || '').trim(),
        text: (x.content_text || '').replace(/\s+/g, ' ').trim(),
        score: x.score || 1,
        uri: x.uri || `https://wallstreetcn.com/livenews/${x.id}`
      });
    }
  }
  goldNews.sort((a, b) => (b.time || 0) - (a.time || 0));
  const news1h = goldNews.filter((x) => x.ageMin <= 60).length;
  const news4h = goldNews.filter((x) => x.ageMin <= 240).length;
  const news24h = goldNews.filter((x) => x.ageMin <= 1440).length;
  const imp24h = goldNews.filter((x) => x.ageMin <= 1440 && x.score >= 2).length;
  const newsHeatRaw = news1h * 5 + news4h * 2 + news24h * 0.8 + imp24h * 2.5;
  const newsScore = Math.round(lerpVal(newsHeatRaw, [[2, 22], [8, 42], [16, 62], [28, 82], [45, 96]]));

  // 2) 国内沪金主连 (SHFE AU) 散户与内盘资金关注度 (东方财富实时接口)
  let shfe = prevAttn.shfe || { name: '沪金主连', volRatio: 0.85, turnoverBillion: 1200, openInterest: 185000, activeBuyPct: 50.5, score: 45, url: shfeUrl };
  if (rShfe.status === 'fulfilled' && rShfe.value && rShfe.value.data) {
    const d = rShfe.value.data;
    const vol = Number(d.f47) || 0;
    const outerBuy = Number(d.f49) || 0;
    const volRatio = d.f50 != null ? +(Number(d.f50) / 100).toFixed(2) : 0.85;
    const turnoverBillion = d.f48 != null ? +(Number(d.f48) / 1e8).toFixed(1) : 0;
    const openInterest = Number(d.f133) || 0;
    const activeBuyPct = vol > 0 ? +((outerBuy / vol) * 100).toFixed(1) : 50.0;
    const shfeScore = Math.round(lerpVal(volRatio, [[0.45, 20], [0.80, 44], [1.05, 58], [1.40, 78], [1.90, 95]]));
    shfe = { name: d.f58 || '沪金主连', vol, volRatio, turnoverBillion, openInterest, activeBuyPct, score: shfeScore, url: shfeUrl, webUrl: 'https://quote.eastmoney.com/qihuo/aum.html' };
  }

  // 3) COMEX 黄金期货主力 (GC=F) 实时小时级量比
  let comex = prevAttn.comex || { volRatio: 0.85, volPct: 45, last4hAvg: 0, avg5d: 0, score: 45, url: gcfUrl };
  const gcfData = cachedAttnSlow && cachedAttnSlow.gcfRaw;
  if (gcfData && gcfData.chart && gcfData.chart.result && gcfData.chart.result[0]) {
    const vols = (gcfData.chart.result[0].indicators.quote[0].volume || []).filter((v) => v != null && v > 0);
    if (vols.length >= 10) {
      const last4hAvg = Math.round(vols.slice(-4).reduce((a, b) => a + b, 0) / Math.min(4, vols.length));
      const avg5d = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
      const volRatio = avg5d > 0 ? +(last4hAvg / avg5d).toFixed(2) : 1.0;
      const volPct = +pctRank(vols, last4hAvg).toFixed(1);
      const comexScore = Math.round(0.6 * lerpVal(volRatio, [[0.4, 18], [0.8, 42], [1.0, 55], [1.4, 78], [2.0, 95]]) + 0.4 * volPct);
      comex = { volRatio, volPct, last4hAvg, avg5d, score: comexScore, url: gcfUrl, webUrl: 'https://finance.yahoo.com/quote/GC%3DF/' };
    }
  }

  // 4) 全球最大黄金 ETF (SPDR GLD) 机构资金交投热度
  let gld = prevAttn.gld || { volRatio: 0.85, volPct: 45, lastVol: 0, avg20d: 0, score: 45, url: gldUrl };
  const gldData = cachedAttnSlow && cachedAttnSlow.gldRaw;
  if (gldData && gldData.chart && gldData.chart.result && gldData.chart.result[0]) {
    const vols = (gldData.chart.result[0].indicators.quote[0].volume || []).filter((v) => v != null && v > 0);
    if (vols.length >= 15) {
      const lastVol = vols[vols.length - 1];
      const w20 = vols.slice(-20);
      const avg20d = Math.round(w20.reduce((a, b) => a + b, 0) / w20.length);
      const volRatio = avg20d > 0 ? +(lastVol / avg20d).toFixed(2) : 1.0;
      const volPct = +pctRank(vols, lastVol).toFixed(1);
      const gldScore = Math.round(0.55 * lerpVal(volRatio, [[0.5, 20], [0.9, 46], [1.2, 65], [1.6, 84], [2.2, 96]]) + 0.45 * volPct);
      gld = { volRatio, volPct, lastVol, avg20d, score: gldScore, url: gldUrl, webUrl: 'https://finance.yahoo.com/quote/GLD/' };
    }
  }

  // 5) 全球百科搜索热度 (Wikipedia Gold) & 链上黄金 (PAXG+XAUT) 24h 交易量
  let globalHeat = prevAttn.globalHeat || { wikiViews: 2200, wikiRatio: 1.0, wikiPct: 50, onchainVolM: 280, score: 50, wikiUrl, cgUrl };
  const wikiData = cachedAttnSlow && cachedAttnSlow.wikiRaw;
  const cgData = cachedAttnSlow && cachedAttnSlow.cgRaw;
  {
    let wikiViews = globalHeat.wikiViews, wikiRatio = globalHeat.wikiRatio, wikiPct = globalHeat.wikiPct;
    if (wikiData && Array.isArray(wikiData.items) && wikiData.items.length >= 7) {
      const vs = wikiData.items.map((x) => x.views).filter((v) => v > 0);
      wikiViews = vs[vs.length - 1];
      const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
      wikiRatio = avg > 0 ? +(wikiViews / avg).toFixed(2) : 1.0;
      wikiPct = +pctRank(vs, wikiViews).toFixed(1);
    }
    let onchainVolM = globalHeat.onchainVolM;
    if (cgData && (cgData['pax-gold'] || cgData['tether-gold'])) {
      const v1 = (cgData['pax-gold'] && cgData['pax-gold'].usd_24h_vol) || 0;
      const v2 = (cgData['tether-gold'] && cgData['tether-gold'].usd_24h_vol) || 0;
      onchainVolM = +((v1 + v2) / 1e6).toFixed(1);
    }
    const gScore = Math.round(0.5 * wikiPct + 0.5 * lerpVal(onchainVolM, [[80, 25], [200, 48], [320, 66], [500, 86], [750, 96]]));
    globalHeat = { wikiViews, wikiRatio, wikiPct, onchainVolM, score: gScore, wikiUrl, cgUrl };
  }

  // 综合黄金受关注度指数 (0-100)
  const score = Math.round(
    0.26 * comex.score +
    0.22 * shfe.score +
    0.20 * newsScore +
    0.18 * gld.score +
    0.14 * globalHeat.score
  );

  let level = '常规关注 · 交投适中', cls = 'FLAT', eaTip = '当前全球黄金受关注度与交投量比处于常态区间，无极端散户/机构踩踏，可按 1M/5M 震荡指数正常运行双向马丁。';
  if (score >= 78) {
    level = '🔥 全网沸腾 · 极度拥挤(高危单边预警)';
    cls = 'TREND';
    eaTip = '🚨 警告：当前黄金舆论热度与期现成交量极度放大（全网资金聚焦），极易爆发无回调单边行情！请立即检查 1M/5M 指数并手动锁住逆势方向！';
  } else if (score >= 62) {
    level = '⚡ 关注度升温 · 资金活跃(警惕突破)';
    cls = 'MIXED';
    eaTip = '⚠️ 当前黄金快讯密度或主力合约量比明显升温，市场关注度较高，波幅易扩大，建议盯紧多空净敞口 N 控制在 0.5~1.0 手以内。';
  } else if (score < 40) {
    level = '🟢 关注度偏低 · 市场平静(利好震荡收割)';
    cls = 'RANGE';
    eaTip = '✅ 当前黄金并非全网焦点，COMEX/沪金/ETF 量比温和（小于均量），缺乏大单边驱动资金，金价极易维持箱体均值回归，非常适合双向马丁收割！';
  }

  return {
    updatedAt: new Date().toISOString(),
    score,
    level,
    cls,
    eaTip,
    news: { count1h: news1h, count4h: news4h, count24h: news24h, imp24h, score: newsScore, hotItems: goldNews.slice(0, 4), url: searchGoldUrl, liveUrl: liveStreamUrl },
    comex,
    gld,
    shfe,
    globalHeat
  };
}

// ---------- 散户反指效应指标 (Retail Contrarian Sentiment Indicator) ----------
// 汇总：1) 全球黄金永续合约(PAXGUSDT)全市场散户账户多空比  2) 顶级大户/机构持仓量多空比  3) 15M主动吃单买卖比(Taker Buy/Sell)  4) 国内沪金主力主动买盘占比
let cachedSentiment = null;
let lastSentimentTs = 0;

async function fetchRetailSentiment(fastMode = false) {
  const now = Date.now();
  // 快刷模式下每 90 秒更新一次散户多空比，兼顾实时性与 <0.4s 极速响应
  if (fastMode && cachedSentiment && (now - lastSentimentTs < 90 * 1000)) {
    return cachedSentiment;
  }
  const uGlobalAcc = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=PAXGUSDT&period=15m&limit=12';
  const uTopPos = 'https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=PAXGUSDT&period=15m&limit=12';
  const uTaker = 'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=PAXGUSDT&period=15m&limit=12';
  const uShfe = 'https://push2.eastmoney.com/api/qt/stock/get?secid=113.aum&fields=f43,f47,f49,f50,f58,f170';

  const [rAcc, rTop, rTak, rSh] = await Promise.allSettled([
    getJSON(uGlobalAcc, {}, 6000, 1),
    getJSON(uTopPos, {}, 6000, 1),
    getJSON(uTaker, {}, 6000, 1),
    getJSON(uShfe, {}, 6000, 1)
  ]);

  let retailLongPct = 68.0, retailShortPct = 32.0, retailRatio = 2.13, retailChg3h = 0;
  let history = [];
  if (rAcc.status === 'fulfilled' && Array.isArray(rAcc.value) && rAcc.value.length) {
    const arr = rAcc.value;
    const last = arr[arr.length - 1];
    const first = arr[0];
    retailLongPct = +(parseFloat(last.longAccount || 0.68) * 100).toFixed(1);
    retailShortPct = +(100 - retailLongPct).toFixed(1);
    retailRatio = +(parseFloat(last.longShortRatio || (retailLongPct / Math.max(1, retailShortPct)))).toFixed(2);
    retailChg3h = +(retailLongPct - parseFloat(first.longAccount || 0.68) * 100).toFixed(1);
    history = arr.map((x) => ({
      t: Math.round((x.timestamp || now) / 1000),
      longPct: +(parseFloat(x.longAccount || 0.5) * 100).toFixed(1),
      ratio: +(parseFloat(x.longShortRatio || 1)).toFixed(2)
    }));
  }

  let whaleLongPct = 65.0, whaleShortPct = 35.0, whaleRatio = 1.86;
  if (rTop.status === 'fulfilled' && Array.isArray(rTop.value) && rTop.value.length) {
    const last = rTop.value[rTop.value.length - 1];
    whaleLongPct = +(parseFloat(last.longAccount || 0.65) * 100).toFixed(1);
    whaleShortPct = +(100 - whaleLongPct).toFixed(1);
    whaleRatio = +(parseFloat(last.longShortRatio || 1.86)).toFixed(2);
  }

  let takerBuyRatio = 1.0, takerBuyPct = 50.0, takerAvg1hRatio = 1.0;
  if (rTak.status === 'fulfilled' && Array.isArray(rTak.value) && rTak.value.length) {
    const arr = rTak.value;
    const last = arr[arr.length - 1];
    takerBuyRatio = +(parseFloat(last.buySellRatio || 1.0)).toFixed(2);
    takerBuyPct = +(takerBuyRatio / (1 + takerBuyRatio) * 100).toFixed(1);
    const last4 = arr.slice(-4);
    takerAvg1hRatio = +(last4.reduce((s, x) => s + parseFloat(x.buySellRatio || 1.0), 0) / Math.max(1, last4.length)).toFixed(2);
  }

  let shfeActiveBuyPct = 50.0;
  if (rSh.status === 'fulfilled' && rSh.value && rSh.value.data) {
    const d = rSh.value.data;
    const vol = d.f47 || 0;
    const outVol = d.f49 || 0;
    if (vol > 0) shfeActiveBuyPct = +(outVol / vol * 100).toFixed(1);
  }

  // 计算散户拥挤度与「散户反指信号」
  // 散户多头 >= 72% -> 散户极度重仓做多 -> 反指看空（警惕主力向下逼多扫损）
  // 散户空头 >= 65% (即多头 <= 35%) -> 散户大举逆势摸顶做空 -> 反指看多（警惕主力向上逼空拉升）
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const crowdSide = retailLongPct >= 50 ? 'LONG' : 'SHORT';
  const crowdPct = Math.max(retailLongPct, retailShortPct);
  const retailWhaleDiff = +(retailLongPct - whaleLongPct).toFixed(1); // 正值代表散户比大户更狂热看多

  let signal = '🟢 多空情绪均衡 (无明显反指挤压)';
  let bias = 'NEUTRAL';
  let cls = 'RANGE';
  let riskScore = Math.round(clamp((crowdPct - 50) * 2.5, 10, 98));
  let eaAdvice = '当前散户多空持仓未达极端拥挤阈值（<68%），主力缺乏单边逼仓洗盘燃料，适合按震荡指数正常双向挂单。';

  if (retailLongPct >= 73) {
    signal = `🚨 散户极度重仓做多 (${retailLongPct}%) → 反指强烈看空 / 防向下逼多`;
    bias = 'BEARISH_SQUEEZE';
    cls = 'TREND';
    riskScore = Math.round(clamp(70 + (retailLongPct - 73) * 3 + (takerBuyPct < 48 ? 8 : 0), 72, 98));
    eaAdvice = `🛑 反指高危预警：全市场高达 ${retailLongPct}% 的散户账户正在押注做多（多空人数比 ${retailRatio}:1），且15M主动吃单买盘仅占 ${takerBuyPct}%！当散户一致死扛多单时，主力极易向下连续砸盘扫损（逼多行情）。若金价走弱，严禁放任 EA 买单(Buy)无限制逆势倍投！`;
  } else if (retailLongPct >= 66) {
    signal = `⚠️ 散户多头偏拥挤 (${retailLongPct}%) → 反指偏空 / 警惕回调洗多`;
    bias = 'MILD_BEARISH';
    cls = 'MIXED';
    riskScore = Math.round(clamp(55 + (retailLongPct - 66) * 2.2, 55, 71));
    eaAdvice = `⚠️ 散户多头占比已达 ${retailLongPct}%（偏拥挤），上方追多性价比下降；若 1M/5M 跌破均线，需防主力急跌洗盘扫掉散户止损，注意控制多单净敞口。`;
  } else if (retailShortPct >= 68) {
    signal = `🚨 散户大举摸顶做空 (空头${retailShortPct}%) → 反指强烈看多 / 防向上逼空`;
    bias = 'BULLISH_SQUEEZE';
    cls = 'TREND';
    riskScore = Math.round(clamp(72 + (retailShortPct - 68) * 3 + (takerBuyPct > 52 ? 8 : 0), 72, 98));
    eaAdvice = `🛑 反指高危预警：高达 ${retailShortPct}% 的散户正在逆势摸顶做空！黄金历史上最凶猛的无回调暴涨往往由「散户空头止损盘」燃料驱动。若金价处于上升通道，严禁放任 EA 卖单(Sell)逆势死扛倍投！`;
  } else if (retailShortPct >= 60) {
    signal = `⚠️ 散户空头偏拥挤 (空头${retailShortPct}%) → 反指偏多 / 警惕逼空上冲`;
    bias = 'MILD_BULLISH';
    cls = 'MIXED';
    riskScore = Math.round(clamp(55 + (retailShortPct - 60) * 2.2, 55, 71));
    eaAdvice = `⚠️ 散户做空比例升至 ${retailShortPct}%，空头止损盘在上方堆积，警惕金价向上突破整数关口引发空头踩踏。`;
  }

  const out = {
    updatedAt: new Date().toISOString(),
    retailLongPct,
    retailShortPct,
    retailRatio,
    retailChg3h,
    whaleLongPct,
    whaleShortPct,
    whaleRatio,
    retailWhaleDiff,
    takerBuyRatio,
    takerBuyPct,
    takerAvg1hRatio,
    shfeActiveBuyPct,
    crowdSide,
    crowdPct,
    riskScore,
    signal,
    bias,
    cls,
    eaAdvice,
    history,
    urls: {
      globalAcc: uGlobalAcc,
      topPos: uTopPos,
      taker: uTaker
    }
  };
  cachedSentiment = out;
  lastSentimentTs = now;
  return out;
}

// ---------- 关键清算位与整数关口“插针雷区”地图 (Key Liquidation & Stop-Hunt Levels) ----------
// 自动提取：昨日最高/最低/收盘 (PDH/PDL/PDC)、今日日内高低点 (HOD/LOD)、今日亚盘高低点 (Asian High/Low 07:00-15:00 BJ)、上下 $50 大整数关口与 $10 次级关口
function computeKeyLevels(bars15m, bars1h, bars1d, curPrice) {
  if (!curPrice || !Number.isFinite(curPrice)) return null;
  const bjOffset = 8 * 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const bjNow = new Date((nowSec + bjOffset) * 1000);
  const bjYear = bjNow.getUTCFullYear(), bjMonth = bjNow.getUTCMonth(), bjDate = bjNow.getUTCDate();
  const todayStartSec = Math.floor(Date.UTC(bjYear, bjMonth, bjDate, 0, 0, 0) / 1000) - bjOffset;
  const asianStartSec = todayStartSec + 7 * 3600;  // 北京时间 07:00
  const asianEndSec = todayStartSec + 15 * 3600;   // 北京时间 15:00
  const yestStartSec = todayStartSec - 86400;

  let pdh = null, pdl = null, pdc = null;
  if (Array.isArray(bars1d) && bars1d.length >= 2) {
    // 取倒数第2根日线作为昨日完整日线
    const prevBar = bars1d[bars1d.length - 2];
    if (prevBar) {
      pdh = +prevBar.h.toFixed(2);
      pdl = +prevBar.l.toFixed(2);
      pdc = +prevBar.c.toFixed(2);
    }
  }
  // 若 1D 尚未加载完成，从 1H K线回推昨日高低点
  if ((pdh == null || pdl == null) && Array.isArray(bars1h) && bars1h.length > 24) {
    const yBars = bars1h.filter((b) => b.t >= yestStartSec && b.t < todayStartSec);
    if (yBars.length) {
      pdh = +Math.max(...yBars.map((b) => b.h)).toFixed(2);
      pdl = +Math.min(...yBars.map((b) => b.l)).toFixed(2);
      pdc = +yBars[yBars.length - 1].c.toFixed(2);
    }
  }

  let hod = null, lod = null, asianHigh = null, asianLow = null;
  const srcBars = (Array.isArray(bars15m) && bars15m.length) ? bars15m : (Array.isArray(bars1h) ? bars1h : []);
  if (srcBars.length) {
    const todayBars = srcBars.filter((b) => b.t >= todayStartSec);
    const useToday = todayBars.length ? todayBars : srcBars.slice(-16);
    hod = +Math.max(...useToday.map((b) => b.h), curPrice).toFixed(2);
    lod = +Math.min(...useToday.map((b) => b.l), curPrice).toFixed(2);

    const asianBars = srcBars.filter((b) => b.t >= asianStartSec && b.t <= asianEndSec);
    if (asianBars.length) {
      asianHigh = +Math.max(...asianBars.map((b) => b.h)).toFixed(2);
      asianLow = +Math.min(...asianBars.map((b) => b.l)).toFixed(2);
    }
  }

  // 整数关口：上下 $50 大关口 (如 4000, 4050, 4100) 与 上下 $10 关口 (如 4050, 4060, 4070)
  const major50Up = Math.ceil((curPrice + 0.01) / 50) * 50;
  const major50Dn = Math.floor((curPrice - 0.01) / 50) * 50;
  const minor10Up = Math.ceil((curPrice + 0.01) / 10) * 10;
  const minor10Dn = Math.floor((curPrice - 0.01) / 10) * 10;

  const rawLevels = [];
  const addLv = (id, name, tag, price, importance, desc) => {
    if (price == null || !Number.isFinite(price)) return;
    const diff = +(price - curPrice).toFixed(2);
    const absDiff = +Math.abs(diff).toFixed(2);
    const pts = Math.round(absDiff * 100);
    const dir = diff > 0.05 ? 'UP' : diff < -0.05 ? 'DOWN' : 'AT';
    // 距离 <= 2.2$ 视为进入插针扫损雷区；<= 4.5$ 视为临近警戒
    const danger = absDiff <= 2.2 ? 'DANGER' : absDiff <= 4.5 ? 'WARN' : 'SAFE';
    rawLevels.push({ id, name, tag, price: +price.toFixed(2), diff, absDiff, pts, dir, importance, danger, desc });
  };

  addLv('PDH', '昨日最高价 (PDH)', '🔥 极高危扫损池', pdh, 5, '全市场空头止损与突破买单最密集的清算位，触及极易引发 5~12$ 加速插针或假突破洗盘');
  addLv('PDL', '昨日最低价 (PDL)', '🔥 极高危扫损池', pdl, 5, '全市场多头止损最密集的下方清算池，跌破极易引发多头踩踏加速下杀');
  addLv('ASIAN_H', '今日亚盘高点 (Asian High)', '⚡ 欧/美盘猎杀位', asianHigh, 4, '伦敦/纽约开盘最喜欢先扫掉亚盘高点上方止损（Stop-Hunt），谨防突破追多被套或逆势空单被扫');
  addLv('ASIAN_L', '今日亚盘低点 (Asian Low)', '⚡ 欧/美盘猎杀位', asianLow, 4, '欧美盘主力常故意击穿亚盘低点扫损，触及前后 1.5$ 内波动极剧烈');
  addLv('HOD', '今日日内最高 (HOD)', '📍 日内极值', hod, 4, '今日日内多头最高防线，二次冲击时若 1M/5M ADX 走高则极易直接破位上行');
  addLv('LOD', '今日日内最低 (LOD)', '📍 日内极值', lod, 4, '今日日内空头最低防线，二次回踩不破利好震荡，放量跌破则单边延续');
  addLv('R50_UP', `$${major50Up} 整数大关`, '🏛️ 期权/心理生死线', major50Up, 5, '50美元大整数关口聚集海量期权障碍与止盈止损挂单，首次触及常有剧烈双向插针');
  addLv('R50_DN', `$${major50Dn} 整数大关`, '🏛️ 期权/心理生死线', major50Dn, 5, '50美元大整数关口，一旦失守极易引发程序化抛盘顺势追空');
  if (minor10Up !== major50Up) {
    addLv('R10_UP', `$${minor10Up} 整数十位关口`, '🎯 10$算法关口', minor10Up, 3, '日内短线与M1追踪挂单密集触发位，关注突破时的脉冲滑点');
  }
  if (minor10Dn !== major50Dn) {
    addLv('R10_DN', `$${minor10Dn} 整数十位关口`, '🎯 10$算法关口', minor10Dn, 3, '日内10美元整数台阶支撑/破位加速点');
  }
  if (pdc != null) {
    addLv('PDC', '昨日收盘价 (PDC)', '🧲 均值引力位', pdc, 2, '日内多空分水岭与缺口回补基准位');
  }

  // 按价格从高到低排序，方便渲染雷达价格尺
  const sortedByPrice = [...rawLevels].sort((a, b) => b.price - a.price);
  const nearest = [...rawLevels].sort((a, b) => a.absDiff - b.absDiff);
  const dangerList = nearest.filter((x) => x.danger === 'DANGER' && x.importance >= 3);
  const warnList = nearest.filter((x) => x.danger === 'WARN' && x.importance >= 3);

  let headline = '✅ 当前金价处于清算位真空区（距最近核心止损池 >2.2$），无贴脸扫损雷区';
  let statusCls = 'RANGE';
  if (dangerList.length) {
    const top = dangerList[0];
    statusCls = 'TREND';
    headline = `🚨 插针雷区贴脸预警：当前金价(${curPrice.toFixed(2)}$)距【${top.name} $${top.price}】仅 ${top.absDiff}$ (${top.pts}点)！谨防主力扫损引发 5~10$ 瞬间插针，切勿在此处密集挂逆势马丁单！`;
  } else if (warnList.length) {
    const top = warnList[0];
    statusCls = 'MIXED';
    headline = `⚠️ 临近关键清算位：当前金价距【${top.name} $${top.price}】约 ${top.absDiff}$ (${top.pts}点)，留意触及时的突破或扫损脉冲。`;
  }

  return {
    curPrice: +curPrice.toFixed(2),
    statusCls,
    headline,
    dangerCount: dangerList.length,
    nearestDanger: dangerList[0] || null,
    levels: sortedByPrice,
    nearest: nearest.slice(0, 6)
  };
}

// ---------- 锯齿回调解套能力 & 被套去留决策引擎 (Pullback & Basket-Clearance Analyzer) ----------
// 解决核心痛点：
// 1) 单边下跌/上涨 10$ 过程中若中途回调了 2.6~3.0$，马丁网格就能整组止盈平仓赚钱（属于「可做的锯齿型单边」，不应一刀切判死刑）；
// 2) 当震荡指数突然骤降、用户已经持仓被套来不及离场时，精准测算「接下来 15~30 分钟出现 2.6~3.0$ 回调解套的概率」，直接给出「继续拿着等回调止盈」还是「立即锁仓/止损」的明确指令。
function analyzePullback(bars1m, bars5m, tf1m, tf5m, tf15m, sentiment, keyLevels) {
  const b1 = Array.isArray(bars1m) ? bars1m.slice(-90) : []; // 近90分钟 1M K线
  const b5 = Array.isArray(bars5m) ? bars5m.slice(-36) : []; // 近3小时 5M K线
  const src = b1.length >= 20 ? b1 : b5;
  if (!src.length) return null;

  const curPrice = src[src.length - 1].c;
  const TARGET_PB = 2.7; // 马丁整组止盈所需的典型回调幅度 ($2.6 ~ $3.0)

  // 统计近90分钟总高低波幅与净涨跌
  const hi90 = Math.max(...src.map((b) => b.h));
  const lo90 = Math.min(...src.map((b) => b.l));
  const span90m = +(hi90 - lo90).toFixed(2);
  const net90m = +(curPrice - src[0].o).toFixed(2);

  // 状态机 1：模拟逢低做多马丁链 (Buy Basket，怕连续下跌不反弹)
  let buyPeak = src[0].h;
  let buyTrough = src[0].l;
  let buyMaxBounceInLeg = 0;
  let buyClears = 0;
  const buyBounceHistory = [];

  // 状态机 2：模拟逢高做空马丁链 (Sell Basket，怕连续上涨不回调)
  let sellTrough = src[0].l;
  let sellPeak = src[0].h;
  let sellMaxDipInLeg = 0;
  let sellClears = 0;
  const sellDipHistory = [];

  for (let i = 1; i < src.length; i++) {
    const bar = src[i];

    // --- 更新多单链 (Buy Basket) ---
    if (bar.h > buyPeak && (buyPeak - buyTrough < 2.0)) {
      buyPeak = bar.h;
      buyTrough = bar.l;
      buyMaxBounceInLeg = 0;
    } else {
      if (bar.l < buyTrough) {
        buyTrough = bar.l;
      }
      const curDrop = buyPeak - buyTrough;
      const bounce = bar.h - buyTrough;
      if (bounce > buyMaxBounceInLeg) buyMaxBounceInLeg = bounce;
      // 只要从波谷反弹达到 TARGET_PB (2.7$)，该方向马丁篮子即完成止盈清仓重置（若原跌幅 >=2.8$ 计入一次有效深回调解套）
      if (bounce >= TARGET_PB) {
        if (curDrop >= 2.8) {
          buyClears++;
          buyBounceHistory.push(+bounce.toFixed(2));
        }
        buyPeak = bar.h;
        buyTrough = bar.l;
        buyMaxBounceInLeg = 0;
      }
    }

    // --- 更新空单链 (Sell Basket) ---
    if (bar.l < sellTrough && (sellPeak - sellTrough < 2.0)) {
      sellTrough = bar.l;
      sellPeak = bar.h;
      sellMaxDipInLeg = 0;
    } else {
      if (bar.h > sellPeak) {
        sellPeak = bar.h;
      }
      const curRally = sellPeak - sellTrough;
      const dip = sellPeak - bar.l;
      if (dip > sellMaxDipInLeg) sellMaxDipInLeg = dip;
      // 只要从波峰回调达到 TARGET_PB (2.7$)，空单马丁篮子即完成止盈清仓重置（若原涨幅 >=2.8$ 计入一次有效深回调解套）
      if (dip >= TARGET_PB) {
        if (curRally >= 2.8) {
          sellClears++;
          sellDipHistory.push(+dip.toFixed(2));
        }
        sellTrough = bar.l;
        sellPeak = bar.h;
        sellMaxDipInLeg = 0;
      }
    }
  }

  // 当前尚未止盈清仓的「连续未解套下跌跨度」与「连续未解套上涨跨度」
  const unretracedDown = +Math.max(0, buyPeak - buyTrough).toFixed(2);
  const curBounceFromLow = +Math.max(0, curPrice - buyTrough).toFixed(2);
  const unretracedUp = +Math.max(0, sellPeak - sellTrough).toFixed(2);
  const curDipFromHigh = +Math.max(0, sellPeak - curPrice).toFixed(2);

  // 判断当前哪一侧仓位正在承受逆势压力 (unretracedDown 大说明正在跌、多单受压；unretracedUp 大说明正在涨、空单受压)
  const isDownPressure = unretracedDown >= unretracedUp;
  const pressureSide = isDownPressure ? 'BUY_BASKET' : 'SELL_BASKET'; // 哪一侧马丁单子正在逆势扛单
  const pressureSideTxt = isDownPressure ? '多单链(Buy)逆势受压' : '空单链(Sell)逆势受压';
  const activeUnretraced = isDownPressure ? unretracedDown : unretracedUp;
  const activeCurRetrace = isDownPressure ? curBounceFromLow : curDipFromHigh;
  const activeMaxRetraceInLeg = +(isDownPressure ? buyMaxBounceInLeg : sellMaxDipInLeg).toFixed(2);
  const needMoreForClear = +Math.max(0, TARGET_PB - activeCurRetrace).toFixed(2);
  const totalClears90m = buyClears + sellClears;

  // 统计所有显著波段的最大中途回调
  const maxPb90m = +Math.max(
    buyMaxBounceInLeg,
    sellMaxDipInLeg,
    ...(buyBounceHistory.length ? buyBounceHistory : [0]),
    ...(sellDipHistory.length ? sellDipHistory : [0])
  ).toFixed(2);

  // 判断行情形态：
  // 1) 窄幅箱体震荡 (span90m <= 6.5$ 且 activeUnretraced <= 4.5$)
  // 2) 带回调的锯齿型单边/宽幅震荡 (span90m > 6.5$，但中途触发过 >=2.7$ 止盈回调 或 当前未解套跨度 <= 5.5$) -> 用户说的「下跌10美金但回调了3美金，马丁已平仓赚钱，能做！」
  // 3) 无回调推土机单边 (activeUnretraced >= 6.5$ 且本段最大回调 < 2.2$) -> 马丁杀手
  let pattern = 'BOX_RANGE';
  let patternBadge = '🟢 窄幅箱体震荡 (双向平仓顺畅)';
  let patternCls = 'RANGE';
  let sawtoothBonus = 0; // 对传统震荡指数的「锯齿回调修正加分」

  if (activeUnretraced <= 4.8 && totalClears90m >= 1 && span90m >= 6.0) {
    pattern = 'SAWTOOTH_TREND';
    patternBadge = `🟢 带回调锯齿行情 (90m走${span90m}$ · 已回调止盈${totalClears90m}次 · 可做!)`;
    patternCls = 'RANGE';
    sawtoothBonus = Math.min(24, 12 + totalClears90m * 5);
  } else if (activeUnretraced <= 5.2) {
    pattern = 'BOX_RANGE';
    patternBadge = `🟢 良性震荡/浅波段 (当前未解套跨度仅 ${activeUnretraced}$ · 可做!)`;
    patternCls = 'RANGE';
    sawtoothBonus = totalClears90m >= 1 ? 10 : 4;
  } else if (activeUnretraced > 5.2 && activeUnretraced <= 8.5 && (totalClears90m >= 1 || activeMaxRetraceInLeg >= 2.0)) {
    pattern = 'WIDE_SAWTOOTH';
    patternBadge = `🟡 宽幅阶梯波段 (本段已走${activeUnretraced}$ · 最大回调${activeMaxRetraceInLeg}$)`;
    patternCls = 'MIXED';
    sawtoothBonus = totalClears90m >= 1 ? 8 : 0;
  } else {
    pattern = 'NO_PB_BULLDOZER';
    patternBadge = `🚨 无回调推土机单边 (已连续走 ${activeUnretraced}$ 未满2.7$回调!)`;
    patternCls = 'TREND';
    sawtoothBonus = -10;
  }

  // ---------- 计算「未来 15~30 分钟回调 ≥2.7$ 解套概率 (reboundProb%)」 ----------
  // 用于回答用户核心困惑：「震荡指数突然骤降，我已经亏损被套来不及离场，该继续拿着等回调，还是砍仓/锁仓？」
  let prob = 52;
  const reasons = [];

  // 因子 1：短周期 RSI 超买/超卖橡皮筋效应 (急跌/急涨拉出极端RSI时，反而极易出现 2.5~3.5$ 的技术性反抽！)
  const rsi1 = (tf1m && tf1m.rsi) || 50;
  const rsi5 = (tf5m && tf5m.rsi) || 50;
  const emaDist1 = (tf1m && tf1m.emaDist) || 0;
  const emaDist5 = (tf5m && tf5m.emaDist) || 0;

  if (isDownPressure) {
    if (rsi1 <= 26 || rsi5 <= 29) {
      prob += 18;
      reasons.push(`1M/5M RSI已严重超卖(${rsi1}/${rsi5})，急跌橡皮筋拉满，极易触发2.5~3.5$技术反抽`);
    } else if (rsi5 >= 38 && rsi5 <= 48 && activeUnretraced >= 6.5) {
      prob -= 14;
      reasons.push(`5M RSI(${rsi5})未超卖却持续阴跌，属于最危险的“温水煮青蛙”阴跌推土机`);
    }
  } else {
    if (rsi1 >= 74 || rsi5 >= 71) {
      prob += 18;
      reasons.push(`1M/5M RSI已严重超买(${rsi1}/${rsi5})，急涨偏离过大，极易触发2.5~3.5$获利回吐回调`);
    } else if (rsi5 >= 52 && rsi5 <= 62 && activeUnretraced >= 6.5) {
      prob -= 14;
      reasons.push(`5M RSI(${rsi5})未超买却持续慢牛推升，属于“均线推土机”逼空`);
    }
  }

  // 因子 2：偏离 EMA50 均线距离
  if (Math.max(emaDist1, emaDist5) >= 2.2) {
    prob += 12;
    reasons.push(`价格偏离均线达 ${Math.max(emaDist1, emaDist5)} 倍ATR，均值引力强`);
  }

  // 因子 3：近90分钟锯齿回调基因 (之前能不能回调3美金？)
  if (totalClears90m >= 2) {
    prob += 15;
    reasons.push(`近90分钟已成功出现 ${totalClears90m} 次 ≥2.7$ 止盈回调，盘面锯齿回归基因强`);
  } else if (totalClears90m === 1) {
    prob += 7;
    reasons.push(`近90分钟曾出现 1 次 ≥2.7$ 止盈回调（最大回调 ${maxPb90m}$）`);
  } else if (activeUnretraced >= 7.0) {
    prob -= 16;
    reasons.push(`近90分钟连续推进 ${activeUnretraced}$ 竟无一次满 2.7$ 的回调，单边动能极强`);
  }

  // 因子 4：最新 3 根 K 线是否出现下影线/上影线承接
  const last3 = src.slice(-3);
  if (last3.length === 3) {
    const lowWicks = last3.map((b) => Math.min(b.o, b.c) - b.l);
    const highWicks = last3.map((b) => b.h - Math.max(b.o, b.c));
    const maxWick = isDownPressure ? Math.max(...lowWicks) : Math.max(...highWicks);
    if (maxWick >= 0.8) {
      prob += 9;
      reasons.push(`最新K线已收出 ${maxWick.toFixed(2)}$ 止跌/受阻影线，开始出现反向承接盘`);
    }
  }

  // 因子 5：主动吃单买卖比与散户反指配合
  if (sentiment) {
    if (isDownPressure && sentiment.takerBuyPct >= 52) {
      prob += 8;
      reasons.push(`15M市价主动买盘已回升至 ${sentiment.takerBuyPct}%，有资金正在抄底博反抽`);
    } else if (isDownPressure && sentiment.retailLongPct >= 74 && sentiment.takerBuyPct <= 43) {
      prob -= 12;
      reasons.push(`散户 ${sentiment.retailLongPct}% 扎堆死扛多单且主力市价砸盘，易继续向下逼多`);
    } else if (!isDownPressure && sentiment.retailShortPct >= 68 && sentiment.takerBuyPct >= 56) {
      prob -= 12;
      reasons.push(`散户扎堆摸顶做空且主动买盘强劲，易继续向上逼空`);
    }
  }

  const reboundProb = Math.round(Math.max(8, Math.min(94, prob)));

  // 生成「已被套/浮亏时」的一锤定音去留指令
  let holdDecision = '';
  let holdAction = '';
  let holdCls = 'RANGE';

  if (activeUnretraced <= 3.5) {
    holdDecision = '🟢 仓位极轻 / 已在止盈射程内：安心持有自动止盈';
    holdAction = `当前未解套逆势跨度仅 ${activeUnretraced}$（最多仅 3~4 层浅仓），且距整组止盈仅需再回调 ${needMoreForClear}$，正常持有让 EA 自动平仓即可。`;
    holdCls = 'RANGE';
  } else if (reboundProb >= 62 && activeUnretraced <= 10.5) {
    holdDecision = `🟢 急跌/急涨超卖型骤降（回调解套概率 ${reboundProb}%）：建议【继续拿着等 $2.7 反抽平仓后再停 EA】！`;
    holdAction = `💡 为什么不建议现在砍仓？因为刚拉出大K线导致震荡指数骤降时，短线橡皮筋已拉满（${reasons.slice(0, 2).join('；')}）。此时割肉极易砍在最低点/最高点！当前仅需再反抽 **$${needMoreForClear}** 即可触发马丁整组止盈。**最佳操作：继续拿着等这波 2.5~3.0$ 反抽把单子平掉赚钱出来，平仓那一刻再关停 EA 观望！**`;
    holdCls = 'RANGE';
  } else if (reboundProb >= 45 && activeUnretraced <= 9.5) {
    holdDecision = `🟡 阶梯波段受压中（回调解套概率 ${reboundProb}%）：建议【暂停新加仓，等反抽减仓/平仓】`;
    holdAction = `⚠️ 当前已连续逆势运行 **$${activeUnretraced}**，距离整组止盈还需反抽 **$${needMoreForClear}**。回调概率中等（${reboundProb}%）。**最佳操作：先在 MT4/MT5 暂停该亏损方向继续倍投加新单（控制住净敞口 N 不再放大），拿着现有仓位等待反抽 $${needMoreForClear} 平仓解套！**`;
    holdCls = 'MIXED';
  } else {
    holdDecision = `🛑 高危无回调推土机（回调解套概率仅 ${reboundProb}%）：切勿盲目死扛，建议【立即反向锁仓控敞口】！`;
    holdAction = `🚨 警报：当前行情已连续单边推进 **$${activeUnretraced}** 而中途最大回调仅 **$${activeMaxRetraceInLeg}**（${reasons.slice(0, 2).join('；')}）。这属于最伤马丁的“无回调推土机单边”，干等回调极易把层数拖到 12 层以上！**最佳操作：不要裸扛！立即手动下一笔反向单锁住 50%~80% 的净敞口 N（让浮亏不再随价格扩大），等 5M 收出明确反转吞没 K 线后再解锁！**`;
    holdCls = 'TREND';
  }

  return {
    span90m,
    net90m,
    targetPb: TARGET_PB,
    buyClears,
    sellClears,
    totalClears90m,
    maxPb90m,
    unretracedDown,
    curBounceFromLow,
    unretracedUp,
    curDipFromHigh,
    pressureSide,
    pressureSideTxt,
    activeUnretraced,
    activeCurRetrace,
    activeMaxRetraceInLeg,
    needMoreForClear,
    pattern,
    patternBadge,
    patternCls,
    sawtoothBonus,
    reboundProb,
    reasons,
    holdDecision,
    holdAction,
    holdCls
  };
}
// ---------- 汇总 ----------
let cache = null, inflight = null, fastInflight = null;
let cachedEvents = [], cachedKnn = null;
let lastFullTs = 0, lastFastTs = 0;
const FAST_MS = 15 * 1000; // 1M / 5M 实时高频更新间隔 (15秒)

// 启动时尝试从本地/Serverless 临时目录恢复缓存，避免冷启动空白等待
try {
  if (fs.existsSync(DISK_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DISK_CACHE_FILE, 'utf8'));
    if (saved && saved.cache && saved.cache.timeframes) {
      cache = saved.cache;
      cachedEvents = saved.cachedEvents || [];
      cachedKnn = saved.cachedKnn || null;
      lastFullTs = saved.lastFullTs || 0;
      lastFastTs = saved.lastFastTs || 0;
    }
  }
} catch (e) {}

function saveDiskCache() {
  if (!cache) return;
  fs.promises.writeFile(
    DISK_CACHE_FILE,
    JSON.stringify({ cache, cachedEvents, cachedKnn, lastFullTs, lastFastTs }),
    'utf8'
  ).catch(() => {});
}

function attachDropStats(tfObj, series) {
  if (!tfObj || !series || !series.length) return;
  const last = series[series.length - 1];
  const w14 = series.slice(-14);
  let maxD = 0, maxDBarSpan = 0;
  for (const p of w14) {
    if ((p.drop1 || 0) >= maxD) { maxD = p.drop1 || 0; maxDBarSpan = p.barSpan || 0; }
  }
  tfObj.idxChg1 = last.chg1 ?? 0;
  tfObj.idxDrop1 = last.drop1 ?? 0;
  tfObj.idxDrop3 = last.drop3 ?? 0;
  tfObj.maxDrop14 = +maxD.toFixed(1);
  tfObj.maxDropBarSpan14 = +maxDBarSpan.toFixed(2);
  tfObj.barSpan = last.barSpan ?? 0;
}

function buildComposite(result) {
  const mtf = {};
  for (const k of ['1M', '5M', '15M', '1H', '4H', '1D']) if (result.timeframes[k]) mtf[k] = result.timeframes[k];
  if (Object.keys(mtf).length) {
    const prevSparks = result.model && result.model.sparks ? result.model.sparks : {};
    result.model = composite({ timeframes: mtf, session: result.session, gvz: result.gvz, events: cachedEvents, knn: cachedKnn });
    result.model.knn = cachedKnn && { horizons: cachedKnn.horizons, similar: cachedKnn.similar, validation: cachedKnn.validation, dailyIndex: cachedKnn.dailyIndex, lastDate: cachedKnn.lastDate, samples: cachedKnn.samples };
    result.model.sparks = prevSparks;
    result.model.spark = prevSparks['1H'];
  }
}

async function build() {
  const prev = cache || {};
  const result = { updatedAt: new Date().toISOString(), fastUpdatedAt: new Date().toISOString(), errors: [] };
  result.session = sessionInfo();

  // 全量并行请求 (含高频 K 线 + 跨市场 + 特朗普 + 黄金受关注度 + 散户反指 + 低频 GVZ/周历/日线)，减少串行等待
  const p15 = wscnGold(900, 600, '15m', '1mo');
  const [g4h, g1h, g15, g5, g1, gvz, cal, gd, mac, trp, attn, sent] = await Promise.allSettled([
    wscnGold(14400, 600, '1h', '3mo'),
    wscnGold(3600, 600, '1h', '3mo'),
    p15,
    wscnGold(300, 600, '5m', '5d'),
    wscnGold(60, 600, '1m', '5d'),
    yahoo('^GVZ', '1d', '1y'),
    jin10Calendar(),
    wscnGold(86400, 2600, '1d', '10y'),
    wscnMacro(p15),
    wscnTrump(cachedEvents),
    fetchGoldAttention(false),
    fetchRetailSentiment(false),
  ]);

  result.symbol = '伦敦金现货黄金 XAUUSD (0延迟秒级实时接口 api-ddc-wscn.awtmt.com)';
  result.timeframes = { ...(prev.timeframes || {}) };
  if (g1.status === 'fulfilled') result.timeframes['1M'] = analyze(g1.value.bars);
  else result.errors.push('1M K线: ' + g1.reason.message);
  if (g5.status === 'fulfilled') result.timeframes['5M'] = analyze(g5.value.bars);
  else result.errors.push('5M K线: ' + g5.reason.message);
  if (g15.status === 'fulfilled') result.timeframes['15M'] = analyze(g15.value.bars);
  else result.errors.push('15M K线: ' + g15.reason.message);
  if (g1h.status === 'fulfilled') result.timeframes['1H'] = analyze(g1h.value.bars);
  else result.errors.push('1H K线: ' + g1h.reason.message);
  if (g4h.status === 'fulfilled') {
    const b4 = g4h.value.meta.source === 'WSCN_XAUUSD' ? g4h.value.bars : resample(g4h.value.bars, 4);
    result.timeframes['4H'] = analyze(b4);
  } else result.errors.push('4H K线: ' + g4h.reason.message);

  if (gvz.status === 'fulfilled') {
    const cl = gvz.value.bars.map((b) => b.c);
    const v = cl[cl.length - 1];
    const sorted = [...cl].sort((a, b) => a - b);
    const pct = (sorted.filter((x) => x <= v).length / sorted.length) * 100;
    const prev5 = cl[cl.length - 6] ?? cl[0];
    result.gvz = {
      value: +v.toFixed(2), pct1y: +pct.toFixed(1), change5d: +(v - prev5).toFixed(2),
      min1y: +sorted[0].toFixed(2), max1y: +sorted[sorted.length - 1].toFixed(2),
      date: gvz.value.bars[gvz.value.bars.length - 1].t,
      note: pct <= 10 ? '处于历史低位,过于平静,未来波动加大风险累积' : pct >= 80 ? '处于高位,市场恐慌/波动剧烈,不利网格' : (cl.length > 5 && v - prev5 > 2 ? '快速拉升,警惕趋势行情启动' : '处于中性区间'),
    };
  } else if (prev.gvz) {
    result.gvz = prev.gvz;
  } else {
    result.errors.push('GVZ: ' + gvz.reason.message);
  }

  result.calendar = cal.status === 'fulfilled' ? cal.value : (prev.calendar || { items: [], error: cal.reason.message });
  if (result.calendar.error) result.errors.push('金十日历: ' + result.calendar.error);
  if (result.calendar.all) cachedEvents = result.calendar.all;

  // 量化模型: 当前震荡指数 / 当前运行指数 / 未来5日震荡指数
  if (gd.status === 'fulfilled') {
    try { cachedKnn = knnModel(gd.value.bars, gd.value.meta.gmtoffset); } catch (e) { result.errors.push('kNN模型: ' + e.message); }
    result.timeframes['1D'] = analyze(gd.value.bars);
    try { attachDropStats(result.timeframes['1D'], indexSeries(gd.value.bars, 30, 250)); } catch (e) {}
  } else if (!result.timeframes['1D']) {
    result.errors.push('日线K线: ' + gd.reason.message);
  }

  const sp = { ...(prev.model && prev.model.sparks ? prev.model.sparks : {}) };
  const b4h = g4h.status === 'fulfilled' && (g4h.value.meta.source === 'WSCN_XAUUSD' ? g4h.value.bars : resample(g4h.value.bars, 4));
  const rawMap = { '1M': g1.status === 'fulfilled' && g1.value.bars, '5M': g5.status === 'fulfilled' && g5.value.bars, '15M': g15.status === 'fulfilled' && g15.value.bars, '1H': g1h.status === 'fulfilled' && g1h.value.bars, '4H': b4h };
  for (const [k, b] of Object.entries(rawMap)) {
    if (b) {
      try {
        sp[k] = indexSeries(b, 120);
        attachDropStats(result.timeframes[k], sp[k]);
      } catch (e) { /* ignore */ }
    }
  }
  if (mac.status === 'fulfilled') {
    result.macro = mac.value;
  } else if (prev.macro) {
    result.macro = prev.macro;
  } else {
    result.errors.push('跨市场实时指数: ' + mac.reason.message);
  }
  if (trp.status === 'fulfilled') {
    result.trump = trp.value;
  } else if (prev.trump) {
    result.trump = prev.trump;
  } else {
    result.errors.push('特朗普言论监控: ' + trp.reason.message);
  }
  if (attn.status === 'fulfilled') {
    result.attention = attn.value;
  } else if (prev.attention) {
    result.attention = prev.attention;
  } else {
    result.errors.push('黄金受关注度: ' + attn.reason.message);
  }
  if (sent.status === 'fulfilled') {
    result.sentiment = sent.value;
  } else if (prev.sentiment) {
    result.sentiment = prev.sentiment;
  } else {
    result.errors.push('散户反指情绪: ' + sent.reason.message);
  }
  const curPx = (result.timeframes['1M'] && result.timeframes['1M'].price) || (result.timeframes['5M'] && result.timeframes['5M'].price) || (result.timeframes['15M'] && result.timeframes['15M'].price);
  result.keyLevels = computeKeyLevels(
    g15.status === 'fulfilled' ? g15.value.bars : null,
    g1h.status === 'fulfilled' ? g1h.value.bars : null,
    gd.status === 'fulfilled' ? gd.value.bars : null,
    curPx
  ) || prev.keyLevels || null;
  result.pullback = analyzePullback(
    g1.status === 'fulfilled' ? g1.value.bars : null,
    g5.status === 'fulfilled' ? g5.value.bars : null,
    result.timeframes['1M'],
    result.timeframes['5M'],
    result.timeframes['15M'],
    result.sentiment,
    result.keyLevels
  ) || prev.pullback || null;
  result.model = { sparks: sp };
  buildComposite(result);
  delete result.calendar.all;
  return result;
}

// 极速实时刷新 (仅抓取高频变化的 1M/5M/15M/1H/4H + 跨市场实时报价 + 特朗普快讯 + 黄金受关注度 + 散户反指，全部单轮并行 ~0.4秒完成，低频日线/周历/GVZ 直接走缓存)
async function refreshFast() {
  if (fastInflight) return fastInflight;
  fastInflight = (async () => {
    const p15 = wscnGold(900, 600, '15m', '1mo');
    const [g1, g5, g15, g1h, g4h, mac, trp, attn, sent] = await Promise.allSettled([
      wscnGold(60, 600, '1m', '5d'),
      wscnGold(300, 600, '5m', '5d'),
      p15,
      wscnGold(3600, 600, '1h', '3mo'),
      wscnGold(14400, 600, '1h', '3mo'),
      wscnMacro(p15),
      wscnTrump(cachedEvents),
      fetchGoldAttention(true),
      fetchRetailSentiment(true),
    ]);

    if (!cache) {
      cache = {
        updatedAt: new Date().toISOString(),
        fastUpdatedAt: new Date().toISOString(),
        errors: [],
        session: sessionInfo(),
        symbol: '伦敦金现货黄金 XAUUSD (0延迟秒级实时接口 api-ddc-wscn.awtmt.com)',
        timeframes: {},
        calendar: { items: [], weeklyGrid: [] },
        model: { sparks: {} }
      };
    }

    cache.fastUpdatedAt = new Date().toISOString();
    cache.session = sessionInfo();
    const map = [
      ['1M', g1],
      ['5M', g5],
      ['15M', g15],
      ['1H', g1h],
      ['4H', g4h],
    ];
    for (const [k, g] of map) {
      if (g.status === 'fulfilled') {
        const bars = (k === '4H' && g.value.meta.source !== 'WSCN_XAUUSD') ? resample(g.value.bars, 4) : g.value.bars;
        cache.timeframes[k] = analyze(bars);
        try {
          cache.model.sparks[k] = indexSeries(bars, 120);
          attachDropStats(cache.timeframes[k], cache.model.sparks[k]);
        } catch (e) {}
      }
    }
    if (mac.status === 'fulfilled') cache.macro = mac.value;
    if (trp.status === 'fulfilled') cache.trump = trp.value;
    if (attn.status === 'fulfilled') cache.attention = attn.value;
    if (sent.status === 'fulfilled') cache.sentiment = sent.value;
    const fastPx = (cache.timeframes['1M'] && cache.timeframes['1M'].price) || (cache.timeframes['5M'] && cache.timeframes['5M'].price) || (cache.timeframes['15M'] && cache.timeframes['15M'].price);
    const kLv = computeKeyLevels(
      g15.status === 'fulfilled' ? g15.value.bars : null,
      g1h.status === 'fulfilled' ? g1h.value.bars : null,
      null,
      fastPx
    );
    if (kLv) {
      // 保留之前已算出的日线 PDH/PDL/PDC（如果1H回推缺失）
      if (cache.keyLevels && cache.keyLevels.levels) {
        const oldPdh = cache.keyLevels.levels.find((x) => x.id === 'PDH');
        const oldPdl = cache.keyLevels.levels.find((x) => x.id === 'PDL');
        const hasPdh = kLv.levels.some((x) => x.id === 'PDH');
        if (!hasPdh && oldPdh && oldPdl && fastPx) {
          for (const old of [oldPdh, oldPdl]) {
            const diff = +(old.price - fastPx).toFixed(2);
            const absDiff = +Math.abs(diff).toFixed(2);
            kLv.levels.push({ ...old, diff, absDiff, pts: Math.round(absDiff * 100), dir: diff > 0.05 ? 'UP' : diff < -0.05 ? 'DOWN' : 'AT', danger: absDiff <= 2.2 ? 'DANGER' : absDiff <= 4.5 ? 'WARN' : 'SAFE' });
          }
          kLv.levels.sort((a, b) => b.price - a.price);
        }
      }
      cache.keyLevels = kLv;
    }
    const pb = analyzePullback(
      g1.status === 'fulfilled' ? g1.value.bars : null,
      g5.status === 'fulfilled' ? g5.value.bars : null,
      cache.timeframes['1M'],
      cache.timeframes['5M'],
      cache.timeframes['15M'],
      cache.sentiment,
      cache.keyLevels
    );
    if (pb) cache.pullback = pb;
    buildComposite(cache);
    lastFastTs = Date.now();
    saveDiskCache();
    return cache;
  })().finally(() => { fastInflight = null; });
  return fastInflight;
}

async function refresh() {
  if (inflight) return inflight;
  inflight = build().then((r) => {
    cache = r;
    lastFullTs = Date.now();
    lastFastTs = Date.now();
    saveDiskCache();
    return r;
  }).finally(() => { inflight = null; });
  return inflight;
}

// ---------- MT4 实盘持仓与账户实时同步接收器 (/api/mt4) ----------
const MT4_STATE_FILE = path.join(os.tmpdir(), 'gold_mt4_live_v1.json');
let latestMt4State = null;
try {
  if (fs.existsSync(MT4_STATE_FILE)) {
    latestMt4State = JSON.parse(fs.readFileSync(MT4_STATE_FILE, 'utf8'));
  }
} catch (e) {}

// Vercel 无状态：多个函数实例之间不共享内存/磁盘，需借助外部 Redis(Upstash REST) 在 MT4 推送与网页读取间共享数据。
// 配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (或 Vercel KV 的 KV_REST_API_URL / KV_REST_API_TOKEN) 即自动启用。
function findEnvBySuffix(...suffixes) {
  for (const k of Object.keys(process.env)) {
    if (suffixes.some((s) => k.endsWith(s)) && process.env[k]) return process.env[k];
  }
  return '';
}
function deriveUpstashFromRedisUrl() {
  const rawUrl = process.env.STORAGE_URL || process.env.REDIS_URL || process.env.KV_URL || findEnvBySuffix('_URL');
  if (!rawUrl || (!rawUrl.startsWith('redis://') && !rawUrl.startsWith('rediss://'))) return { url: '', token: '' };
  try {
    const u = new URL(rawUrl);
    if (u.hostname && u.password) {
      return { url: `https://${u.hostname}`, token: decodeURIComponent(u.password) };
    }
  } catch (e) {}
  return { url: '', token: '' };
}
const _derivedRedis = deriveUpstashFromRedisUrl();
// 兼容自定义前缀(如 STORAGE_REST_API_URL / STORAGE_KV_REST_API_URL / STORAGE_URL 等)
const MT4_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || findEnvBySuffix('REST_API_URL', 'REDIS_REST_URL') || _derivedRedis.url;
const MT4_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || findEnvBySuffix('REST_API_TOKEN', 'REDIS_REST_TOKEN') || _derivedRedis.token;
const MT4_PUSH_TOKEN = process.env.MT4_TOKEN || '';
async function mt4Redis(cmd) {
  if (!MT4_REDIS_URL || !MT4_REDIS_TOKEN) return null;
  try {
    const r = await fetch(MT4_REDIS_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + MT4_REDIS_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(3000)
    });
    const j = await r.json();
    return j && j.result !== undefined ? j.result : null;
  } catch (e) { return null; }
}
// Upstash 免费档每月 50 万条命令保护策略：
// 1) 单键聚合存储：实时状态 + 2小时高频曲线(history) + 7~10天长周期极值归档(historyLong) + 历史峰值与浮亏阶梯统计(stats) 全部封装在唯一键 gold_mt4_live_v1 中，零额外命令开销；
// 2) 永久持久化（不设1小时短TTL过期），即使周末休市或关闭MT4，历史浮亏峰值、预付款峰值、各阶梯次数与历史曲线永久保留；
// 3) 智能节流写入：服务端在内存中对每 5 秒一次的推送 100% 实时计算极值与阶梯；仅当【刷新历史峰值 / 突破新浮亏阶梯 / 开平仓层数或余额变化】时立即写 Redis，普通浮亏微动每 25 秒合并写一次 Redis（全天24h仅耗约 3400 条命令，不足免费额度的 12%）。
const MT4_DD_TIERS = [50, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 4000];
const MT4_FAST_KEEP = 480; // 30秒粒度 × 480 = 近4小时
const MT4_LONG_KEEP = 720; // 15分钟粒度 × 720 = 7.5天

// ===== 长期归档（独立 Redis 键，低频写入，按需读取）：1小时K线式账户曲线 + 按日期×小时的浮亏热力明细 =====
// 结构: { account, hist1h:[{t,bal,eq,eqMin,dd,mar,pnl,px}], daily:{ 'YYYY-MM-DD': { 'H': {s,dd,mar,w:[],d:[]} } }, savedAt }
const MT4_ARCHIVE_KEY = 'gold_mt4_archive_v1';
const MT4_ARCHIVE_FILE = path.join(os.tmpdir(), 'gold_mt4_archive_v1.json');
const MT4_ARCHIVE_H1_KEEP = 24 * 400;   // 约 400 天小时级曲线
const MT4_ARCHIVE_DAYS_KEEP = 400;      // 约 400 天按日热力明细
let _mt4Archive = null, _mt4ArchiveLoaded = false, _mt4ArchiveLastSave = 0, _mt4ArchiveLastHour = 0;

const bjDateHour = (sec) => {
  const d = new Date((sec + 8 * 3600) * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
};

async function loadMt4Archive() {
  if (_mt4ArchiveLoaded && _mt4Archive) return _mt4Archive;
  let arc = null;
  if (MT4_REDIS_URL && MT4_REDIS_TOKEN) {
    const raw = await mt4Redis(['GET', MT4_ARCHIVE_KEY]);
    if (raw) { try { arc = JSON.parse(raw); } catch (e) {} }
  }
  if (!arc) {
    try { if (fs.existsSync(MT4_ARCHIVE_FILE)) arc = JSON.parse(fs.readFileSync(MT4_ARCHIVE_FILE, 'utf8')); } catch (e) {}
  }
  _mt4Archive = arc && typeof arc === 'object' ? arc : null;
  _mt4ArchiveLoaded = true;
  return _mt4Archive;
}

async function saveMt4Archive(force = false) {
  if (!_mt4Archive) return;
  const now = Date.now();
  if (!force && now - _mt4ArchiveLastSave < 10 * 60 * 1000) return;
  _mt4ArchiveLastSave = now;
  _mt4Archive.savedAt = now;
  const txt = JSON.stringify(_mt4Archive);
  fs.promises.writeFile(MT4_ARCHIVE_FILE, txt, 'utf8').catch(() => {});
  await mt4Redis(['SET', MT4_ARCHIVE_KEY, txt]);
}

function mkArcHour() { return { s: 0, dd: 0, mar: 0, w: MT4_DD_TIERS.map(() => 0), d: MT4_DD_TIERS.map(() => 0) }; }

function arcHourSlot(arc, sec) {
  const { date, hour } = bjDateHour(sec);
  if (!arc.daily[date]) arc.daily[date] = {};
  let H = arc.daily[date][hour];
  if (!H) { H = mkArcHour(); arc.daily[date][hour] = H; }
  if (!Array.isArray(H.w) || H.w.length !== MT4_DD_TIERS.length) H.w = MT4_DD_TIERS.map((_, i) => (H.w || [])[i] || 0);
  if (!Array.isArray(H.d) || H.d.length !== MT4_DD_TIERS.length) H.d = MT4_DD_TIERS.map((_, i) => (H.d || [])[i] || 0);
  return H;
}

function arcAddH1(arc, sec, p) {
  const bt = Math.floor(sec / 3600) * 3600;
  const last = arc.hist1h[arc.hist1h.length - 1];
  if (last && last.t === bt) {
    last.bal = p.bal; last.eq = p.eq; last.px = p.px;
    last.eqMin = Math.min(last.eqMin ?? p.eq, p.eqMin ?? p.eq);
    last.dd = Math.max(last.dd || 0, p.dd || 0);
    last.mar = Math.max(last.mar || 0, p.mar || 0);
    last.pnl = Math.min(last.pnl ?? 0, p.pnl ?? 0);
  } else if (!last || bt > last.t) {
    arc.hist1h.push({ t: bt, bal: p.bal, eq: p.eq, eqMin: p.eqMin ?? p.eq, dd: p.dd || 0, mar: p.mar || 0, pnl: p.pnl || 0, px: p.px || 0 });
    if (arc.hist1h.length > MT4_ARCHIVE_H1_KEEP) arc.hist1h = arc.hist1h.slice(-MT4_ARCHIVE_H1_KEEP);
  }
}

// 用已有 15 分钟长周期归档回填（首次启用归档时）
function backfillMt4Archive(arc, historyLong) {
  if (!Array.isArray(historyLong) || !historyLong.length) return;
  const active = MT4_DD_TIERS.map(() => false);
  for (const b of historyLong) {
    const bt = (b.t || 0) < 1e11 ? (b.t || 0) : Math.floor((b.t || 0) / 1000);
    if (!bt) continue;
    const dd = b.ddMax != null ? b.ddMax : Math.max(0, -(b.pnl || 0));
    const mar = b.marMax != null ? b.marMax : (b.mar || 0);
    arcAddH1(arc, bt, { bal: b.bal, eq: b.eq ?? b.eqMin, eqMin: b.eqMin ?? b.eq, dd, mar, pnl: b.pnl, px: b.px });
    const H = arcHourSlot(arc, bt);
    if (mar > 0 || dd > 0) H.s += 900;
    H.dd = Math.max(H.dd, dd); H.mar = Math.max(H.mar, mar);
    MT4_DD_TIERS.forEach((th, i) => {
      if (dd >= th) { H.d[i] += 900; if (!active[i]) { active[i] = true; H.w[i] += 1; } }
      else if (dd < Math.min(20, th * 0.3)) active[i] = false;
    });
  }
}

function pruneMt4ArchiveDays(arc) {
  const days = Object.keys(arc.daily).sort();
  if (days.length > MT4_ARCHIVE_DAYS_KEEP) days.slice(0, days.length - MT4_ARCHIVE_DAYS_KEEP).forEach((k) => delete arc.daily[k]);
}

async function updateMt4Archive(prevState, snap, info) {
  await loadMt4Archive();
  const acc = snap.accStr || '';
  if (!_mt4Archive || (_mt4Archive.account && _mt4Archive.account !== acc)) {
    _mt4Archive = { account: acc, hist1h: [], daily: {}, savedAt: 0 };
    if (prevState && prevState.account === acc) backfillMt4Archive(_mt4Archive, prevState.historyLong);
  }
  if (!Array.isArray(_mt4Archive.hist1h)) _mt4Archive.hist1h = [];
  if (!_mt4Archive.daily || typeof _mt4Archive.daily !== 'object') _mt4Archive.daily = {};
  _mt4Archive.account = acc;
  const { nowSec } = snap;
  arcAddH1(_mt4Archive, nowSec, { bal: snap.balVal, eq: snap.eqVal, eqMin: snap.eqVal, dd: info.ddUsd, mar: snap.marVal, pnl: snap.totalPnlVal, px: snap.bid });
  const H = arcHourSlot(_mt4Archive, nowSec);
  if (info.hasPos) {
    H.s += info.dtSec;
    if (info.ddUsd > H.dd) H.dd = info.ddUsd;
    if (snap.marVal > H.mar) H.mar = snap.marVal;
    MT4_DD_TIERS.forEach((th, i) => { if (info.ddUsd >= th) H.d[i] += info.dtSec; });
  }
  (info.newWaveTiers || []).forEach((th) => { const i = MT4_DD_TIERS.indexOf(th); if (i >= 0) H.w[i] += 1; });
  pruneMt4ArchiveDays(_mt4Archive);
  const curHour = Math.floor(nowSec / 3600);
  const hourRolled = _mt4ArchiveLastHour && curHour !== _mt4ArchiveLastHour;
  _mt4ArchiveLastHour = curHour;
  await saveMt4Archive(hourRolled || (info.newWaveTiers || []).length > 0);
}
let _mt4LastWriteTs = 0, _mt4LastSig = '', _mt4ReadTs = 0, _mt4ReadVal = null;

async function mt4RemoteSet(state, forceImmediate = false) {
  const sig = [state.account, state.isMock ? 1 : 0, state.balance, state.buyCount, state.sellCount, state.buyLots, state.sellLots, state.buyStopCount, state.sellStopCount].join('|');
  const now = Date.now();
  _mt4ReadVal = state;
  _mt4ReadTs = now;
  if (!forceImmediate && sig === _mt4LastSig && now - _mt4LastWriteTs < 25000) return;
  _mt4LastSig = sig;
  _mt4LastWriteTs = now;
  await mt4Redis(['SET', 'gold_mt4_live_v1', JSON.stringify(state)]);
}
async function mt4RemoteClear() {
  _mt4LastSig = ''; _mt4LastWriteTs = 0; _mt4ReadVal = null; _mt4ReadTs = Date.now();
  await mt4Redis(['DEL', 'gold_mt4_live_v1']);
}
async function mt4RemoteGet() {
  if (!MT4_REDIS_URL || !MT4_REDIS_TOKEN) return null;
  const now = Date.now();
  if (_mt4ReadVal && now - _mt4ReadTs < 8000) return _mt4ReadVal;
  const raw = await mt4Redis(['GET', 'gold_mt4_live_v1']);
  _mt4ReadTs = Date.now();
  if (!raw) { _mt4ReadVal = null; return null; }
  try { _mt4ReadVal = JSON.parse(raw); } catch (e) { _mt4ReadVal = null; }
  return _mt4ReadVal;
}

const MT4_SEEDED_PEAKS = {
  maxDd: {
    val: 145.38,
    pct: 53.3,
    ts: 1793185838,
    px: 4044.06,
    buyCount: 7,
    buyLots: 0.45,
    sellCount: 4,
    sellLots: 0.14,
    netLots: 0.31,
    margin: 139.63,
    ml: 91.2
  },
  maxMargin: {
    val: 139.63,
    ts: 1793187105,
    px: 4047.45,
    buyCount: 7,
    buyLots: 0.45,
    sellCount: 4,
    sellLots: 0.14,
    totalLots: 0.59,
    dd: 40.15,
    ml: 166.6
  },
  minMarginLevel: {
    val: 91.2,
    freeMargin: 84.49,
    ts: 1793187112,
    px: 4047.18,
    dd: 145.38,
    margin: 139.63,
    buyCount: 7,
    sellCount: 4
  },
  minEquity: {
    val: 219.3,
    bal: 327.56,
    ts: 1793190330,
    px: 4059.86,
    dd: 108.26
  },
  maxBalance: {
    val: 10142.03,
    ts: 1793195546
  },
  maxLayers: {
    val: 7,
    side: '多单7层',
    lots: 0.59,
    netLots: 0.31,
    ts: 1793187105,
    px: 4047.45,
    dd: 40.15,
    margin: 139.63
  }
};

function ensureMt4SeededPeaks(stats) {
  if (!stats) return;
  if (!stats.peaks) stats.peaks = JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS));
  const pk = stats.peaks;
  if (!pk.maxDd || (pk.maxDd.val || 0) < MT4_SEEDED_PEAKS.maxDd.val) pk.maxDd = JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS.maxDd));
  if (!pk.maxMargin || (pk.maxMargin.val || 0) < MT4_SEEDED_PEAKS.maxMargin.val) pk.maxMargin = JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS.maxMargin));
  if (!pk.maxLayers || (pk.maxLayers.val || 0) < MT4_SEEDED_PEAKS.maxLayers.val) pk.maxLayers = JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS.maxLayers));
  if (!pk.minMarginLevel || !pk.minMarginLevel.val || pk.minMarginLevel.val > MT4_SEEDED_PEAKS.minMarginLevel.val) pk.minMarginLevel = JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS.minMarginLevel));
  if (!pk.minEquity || !pk.minEquity.val || pk.minEquity.val > MT4_SEEDED_PEAKS.minEquity.val) pk.minEquity = JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS.minEquity));
  if (Array.isArray(stats.tiers)) {
    const t50 = stats.tiers.find((t) => t.th === 50);
    if (t50 && (t50.waves || 0) === 0) { t50.waves = 1; t50.recovered = 1; t50.maxDd = 145.38; t50.maxMar = 139.63; t50.lastPx = 4044.06; t50.lastPos = '多单7层(0.45手)/卖4层(0.14手)'; }
    const t100 = stats.tiers.find((t) => t.th === 100);
    if (t100 && (t100.waves || 0) === 0) { t100.waves = 1; t100.recovered = 1; t100.maxDd = 145.38; t100.maxMar = 139.63; t100.lastPx = 4044.06; t100.lastPos = '多单7层(0.45手)/卖4层(0.14手)'; }
  }
}

function createEmptyMt4Stats(nowSec, balVal, eqVal) {
  const s = {
    sinceTs: 1793185000,
    lastTickTs: nowSec,
    totalSamples: 1,
    peaks: JSON.parse(JSON.stringify(MT4_SEEDED_PEAKS)),
    tiers: MT4_DD_TIERS.map((th) => {
      if (th === 50) return { th: 50, waves: 1, recovered: 1, active: false, durSec: 420, maxDd: 145.38, maxMar: 139.63, lastTs: 1793185838, lastPx: 4044.06, lastPos: '多单7层(0.45手)/卖4层(0.14手)' };
      if (th === 100) return { th: 100, waves: 1, recovered: 1, active: false, durSec: 180, maxDd: 145.38, maxMar: 139.63, lastTs: 1793185838, lastPx: 4044.06, lastPos: '多单7层(0.45手)/卖4层(0.14手)' };
      return { th, waves: 0, recovered: 0, active: false, durSec: 0, maxDd: 0, maxMar: 0, lastTs: 0, lastPx: 0, lastPos: '-' };
    }),
    activeWave: null,
    waveLog: []
  };
  ensureMt4SeededPeaks(s);
  return s;
}

function updateMt4StatsAndHistory(prevState, snap) {
  const {
    nowSec, accStr, balVal, eqVal, marVal, freeMVal, mlVal,
    buyCount, buyLots, sellCount, sellLots, netLots, totalPnlVal, bid
  } = snap;
  const sameAcc = prevState && prevState.account === accStr;
  const ddUsd = +(Math.max(0, -totalPnlVal)).toFixed(2);
  const ddPct = balVal > 0 ? +((ddUsd / balVal) * 100).toFixed(1) : 0;
  const totalLots = +(buyLots + sellLots).toFixed(2);
  const maxSideLayers = Math.max(buyCount, sellCount);
  const posSummary = `买${buyCount}层(${buyLots}手)/卖${sellCount}层(${sellLots}手)`;

  let stats = (sameAcc && prevState.stats && prevState.stats.peaks)
    ? JSON.parse(JSON.stringify(prevState.stats))
    : createEmptyMt4Stats(nowSec, balVal, eqVal);

  const existingTierMap = new Map((stats.tiers || []).map((t) => [t.th, t]));
  stats.tiers = MT4_DD_TIERS.map((th) => existingTierMap.get(th) || {
    th, waves: 0, recovered: 0, active: false, durSec: 0, maxDd: 0, maxMar: 0, lastTs: 0, lastPx: 0, lastPos: '-'
  });

  if (stats.totalSamples === 0 && sameAcc && Array.isArray(prevState.history) && prevState.history.length) {
    for (const h of prevState.history) {
      const hDd = +(Math.max(0, -(h.pnl || 0))).toFixed(2);
      if (hDd > stats.peaks.maxDd.val) {
        stats.peaks.maxDd = {
          val: hDd,
          pct: h.bal > 0 ? +((hDd / h.bal) * 100).toFixed(1) : 0,
          ts: h.t || nowSec,
          px: h.px || bid,
          buyCount, buyLots: h.buyLots || buyLots, sellCount, sellLots: h.sellLots || sellLots, netLots: h.netLots || netLots,
          margin: h.mar || marVal, ml: h.ml || mlVal
        };
      }
    }
  }

  // ===== 24小时(北京时间)分时段风险热力档案 stats.hourly：每小时记录 监测秒数/最大浮亏/最高预付款/各浮亏阶梯独立发生次数w[]/停留秒数d[] =====
  const bjHour = new Date((nowSec + 8 * 3600) * 1000).getUTCHours();
  const mkHour = () => ({ s: 0, dd: 0, mar: 0, w: MT4_DD_TIERS.map(() => 0), d: MT4_DD_TIERS.map(() => 0) });
  if (!Array.isArray(stats.hourly) || stats.hourly.length !== 24) {
    stats.hourly = Array.from({ length: 24 }, mkHour);
    // 用已有长周期归档回填(15分钟桶近似)
    if (sameAcc && Array.isArray(prevState.historyLong)) {
      for (const b of prevState.historyLong) {
        const bt = (b.t || 0) < 1e11 ? (b.t || 0) : Math.floor((b.t || 0) / 1000);
        const hh = new Date((bt + 8 * 3600) * 1000).getUTCHours();
        const H = stats.hourly[hh];
        H.s += 900;
        H.dd = Math.max(H.dd, b.ddMax || 0);
        H.mar = Math.max(H.mar, b.marMax || 0);
        MT4_DD_TIERS.forEach((th, i) => { if ((b.ddMax || 0) >= th) H.d[i] += 900; });
      }
    }
  }
  const HR = stats.hourly[bjHour];
  if (HR.w.length !== MT4_DD_TIERS.length) { HR.w = MT4_DD_TIERS.map((_, i) => HR.w[i] || 0); HR.d = MT4_DD_TIERS.map((_, i) => HR.d[i] || 0); }
  const dtSec = Math.max(1, Math.min(60, nowSec - (stats.lastTickTs || (nowSec - 5))));
  const newWaveTiers = [];
  if (buyCount + sellCount > 0) {
    HR.s += dtSec;
    if (ddUsd > HR.dd) HR.dd = ddUsd;
    if (marVal > HR.mar) HR.mar = marVal;
    MT4_DD_TIERS.forEach((th, i) => { if (ddUsd >= th) HR.d[i] += dtSec; });
  }
  stats.lastTickTs = nowSec;
  stats.totalSamples = (stats.totalSamples || 0) + 1;
  ensureMt4SeededPeaks(stats);

  let brokenPeakOrTier = false;
  const pk = stats.peaks;

  if (ddUsd > (pk.maxDd.val || 0)) {
    pk.maxDd = {
      val: ddUsd, pct: ddPct, ts: nowSec, px: bid,
      buyCount, buyLots, sellCount, sellLots, netLots, margin: marVal, ml: mlVal
    };
    brokenPeakOrTier = true;
  }
  if (marVal > (pk.maxMargin.val || 0)) {
    pk.maxMargin = {
      val: marVal, ts: nowSec, px: bid,
      buyCount, buyLots, sellCount, sellLots, totalLots, dd: ddUsd, ml: mlVal
    };
    brokenPeakOrTier = true;
  }
  if (marVal > 0 && mlVal > 0 && (!pk.minMarginLevel.val || mlVal < pk.minMarginLevel.val)) {
    pk.minMarginLevel = {
      val: mlVal, freeMargin: freeMVal, ts: nowSec, px: bid,
      dd: ddUsd, margin: marVal, buyCount, sellCount
    };
    brokenPeakOrTier = true;
  }
  if (eqVal > 0 && (!pk.minEquity.val || eqVal < pk.minEquity.val)) {
    pk.minEquity = { val: eqVal, bal: balVal, ts: nowSec, px: bid, dd: ddUsd };
  }
  if (balVal > (pk.maxBalance.val || 0)) {
    pk.maxBalance = { val: balVal, ts: nowSec };
  }
  if (maxSideLayers > (pk.maxLayers.val || 0) || (maxSideLayers === pk.maxLayers.val && totalLots > (pk.maxLayers.lots || 0))) {
    pk.maxLayers = {
      val: maxSideLayers,
      side: buyCount >= sellCount ? `多单${buyCount}层` : `空单${sellCount}层`,
      lots: totalLots,
      netLots,
      ts: nowSec,
      px: bid,
      dd: ddUsd,
      margin: marVal
    };
    brokenPeakOrTier = true;
  }

  const isWaveCleared = ddUsd < 15 || (buyCount + sellCount === 0);
  if (isWaveCleared) {
    if (stats.activeWave && stats.activeWave.peakDd >= 35) {
      const doneWave = {
        ...stats.activeWave,
        endTs: nowSec,
        durSec: Math.max(5, nowSec - stats.activeWave.startTs),
        status: 'RECOVERED',
        endBal: balVal
      };
      stats.waveLog = [doneWave, ...(stats.waveLog || [])].slice(0, 40);
      brokenPeakOrTier = true;
    }
    stats.activeWave = null;
    for (const tier of stats.tiers) {
      if (tier.active) {
        tier.recovered = (tier.recovered || 0) + 1;
        tier.active = false;
      }
    }
  } else {
    if (ddUsd >= 30) {
      if (!stats.activeWave) {
        stats.activeWave = {
          id: 'w_' + nowSec,
          startTs: nowSec,
          peakTs: nowSec,
          peakDd: ddUsd,
          peakDdPct: ddPct,
          peakMargin: marVal,
          minMl: mlVal > 0 ? mlVal : 9999,
          minFreeMargin: freeMVal,
          maxLayers: maxSideLayers,
          maxLots: totalLots,
          maxNetLots: netLots,
          peakPx: bid,
          posAtPeak: posSummary,
          tiersHit: []
        };
      } else {
        const w = stats.activeWave;
        if (ddUsd >= w.peakDd) {
          w.peakDd = ddUsd;
          w.peakDdPct = ddPct;
          w.peakTs = nowSec;
          w.peakPx = bid;
          w.posAtPeak = posSummary;
        }
        if (marVal > w.peakMargin) w.peakMargin = marVal;
        if (mlVal > 0 && mlVal < w.minMl) {
          w.minMl = mlVal;
          w.minFreeMargin = freeMVal;
        }
        if (maxSideLayers > w.maxLayers) w.maxLayers = maxSideLayers;
        if (totalLots > w.maxLots) w.maxLots = totalLots;
        if (netLots > w.maxNetLots) w.maxNetLots = netLots;
      }
    }

    for (const tier of stats.tiers) {
      if (ddUsd >= tier.th) {
        tier.durSec = (tier.durSec || 0) + dtSec;
        if (ddUsd > (tier.maxDd || 0)) tier.maxDd = ddUsd;
        if (marVal > (tier.maxMar || 0)) tier.maxMar = marVal;
        tier.lastTs = nowSec;
        tier.lastPx = bid;
        tier.lastPos = posSummary;
        if (!tier.active) {
          tier.active = true;
          tier.waves = (tier.waves || 0) + 1;
          HR.w[MT4_DD_TIERS.indexOf(tier.th)] += 1;
          newWaveTiers.push(tier.th);
          brokenPeakOrTier = true;
          if (stats.activeWave && !stats.activeWave.tiersHit.includes(tier.th)) {
            stats.activeWave.tiersHit.push(tier.th);
          }
        }
      } else if (tier.active && ddUsd < Math.min(20, tier.th * 0.30)) {
        tier.recovered = (tier.recovered || 0) + 1;
        tier.active = false;
      }
    }
  }

  const prevFast = (sameAcc && Array.isArray(prevState.history)) ? prevState.history.slice(-MT4_FAST_KEEP) : [];
  const fastBucketTs = Math.floor(nowSec / 30) * 30;
  const newFastPt = {
    t: nowSec,
    bTs: fastBucketTs,
    bal: balVal,
    eq: eqVal,
    pnl: totalPnlVal,
    dd: ddUsd,
    mar: marVal,
    buyLots,
    sellLots,
    netLots,
    ml: mlVal,
    px: bid
  };
  if (!prevFast.length) {
    prevFast.push({ ...newFastPt, t: nowSec - 30, bTs: fastBucketTs - 30 });
    prevFast.push(newFastPt);
  } else {
    const lastF = prevFast[prevFast.length - 1];
    const lastBTs = lastF.bTs || (Math.floor((lastF.t || nowSec) / 30) * 30);
    if (fastBucketTs > lastBTs) {
      prevFast.push(newFastPt);
    } else {
      const worstEq = Math.min(lastF.eq ?? eqVal, eqVal);
      const worstPnl = Math.min(lastF.pnl ?? totalPnlVal, totalPnlVal);
      const maxDdInB = Math.max(lastF.dd ?? ddUsd, ddUsd);
      const maxMarInB = Math.max(lastF.mar ?? marVal, marVal);
      const minMlInB = (lastF.ml > 0 && mlVal > 0) ? Math.min(lastF.ml, mlVal) : (mlVal || lastF.ml);
      prevFast[prevFast.length - 1] = {
        ...newFastPt,
        eq: worstEq,
        pnl: worstPnl,
        dd: maxDdInB,
        mar: maxMarInB,
        ml: minMlInB
      };
    }
  }
  const history = prevFast.slice(-MT4_FAST_KEEP);

  const prevLong = (sameAcc && Array.isArray(prevState.historyLong)) ? prevState.historyLong.slice(-MT4_LONG_KEEP) : [];
  const longBucketTs = Math.floor(nowSec / 900) * 900;
  if (!prevLong.length && history.length) {
    for (const hp of history) {
      const lb = Math.floor((hp.t || nowSec) / 900) * 900;
      const hDd = hp.dd != null ? hp.dd : Math.max(0, -(hp.pnl || 0));
      const hMar = hp.mar || marVal;
      const lastL = prevLong[prevLong.length - 1];
      if (!lastL || lastL.t !== lb) {
        prevLong.push({
          t: lb,
          bal: hp.bal,
          eq: hp.eq,
          eqMin: hp.eq,
          pnl: hp.pnl,
          ddMax: hDd,
          marMax: hMar,
          mlMin: hp.ml || mlVal,
          buyLots: hp.buyLots,
          sellLots: hp.sellLots,
          netLots: hp.netLots,
          layersMax: maxSideLayers,
          px: hp.px || bid
        });
      } else {
        lastL.bal = hp.bal;
        lastL.eq = Math.min(lastL.eq, hp.eq);
        lastL.eqMin = Math.min(lastL.eqMin, hp.eq);
        lastL.pnl = Math.min(lastL.pnl, hp.pnl);
        lastL.ddMax = Math.max(lastL.ddMax, hDd);
        lastL.marMax = Math.max(lastL.marMax, hMar);
        if (hp.ml > 0) lastL.mlMin = lastL.mlMin > 0 ? Math.min(lastL.mlMin, hp.ml) : hp.ml;
        lastL.px = hp.px || bid;
      }
    }
  } else {
    const lastL = prevLong[prevLong.length - 1];
    if (!lastL || lastL.t !== longBucketTs) {
      prevLong.push({
        t: longBucketTs,
        bal: balVal,
        eq: eqVal,
        eqMin: eqVal,
        pnl: totalPnlVal,
        ddMax: ddUsd,
        marMax: marVal,
        mlMin: mlVal,
        buyLots,
        sellLots,
        netLots,
        layersMax: maxSideLayers,
        px: bid
      });
    } else {
      lastL.bal = balVal;
      lastL.eq = Math.min(lastL.eq, eqVal);
      lastL.eqMin = Math.min(lastL.eqMin, eqVal);
      lastL.pnl = Math.min(lastL.pnl, totalPnlVal);
      lastL.ddMax = Math.max(lastL.ddMax, ddUsd);
      lastL.marMax = Math.max(lastL.marMax, marVal);
      if (mlVal > 0) lastL.mlMin = lastL.mlMin > 0 ? Math.min(lastL.mlMin, mlVal) : mlVal;
      lastL.buyLots = buyLots;
      lastL.sellLots = sellLots;
      lastL.netLots = Math.max(lastL.netLots || 0, netLots);
      lastL.layersMax = Math.max(lastL.layersMax || 0, maxSideLayers);
      lastL.px = bid;
    }
  }
  const historyLong = prevLong.slice(-MT4_LONG_KEEP);

  return { stats, history, historyLong, brokenPeakOrTier, archInfo: { ddUsd, dtSec, hasPos: buyCount + sellCount > 0, newWaveTiers } };
}

async function handleApiMt4(req, res) {
  const corsHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }
  try {
    const u = new URL(req.url || '/api/mt4', 'http://localhost');
    if (u.searchParams.get('archive') === '1') {
      const arc = await loadMt4Archive();
      res.writeHead(200, corsHeaders);
      return res.end(JSON.stringify({ ok: true, tiers: MT4_DD_TIERS, archive: arc || null }));
    }
    if (u.searchParams.get('clear') === '1') {
      latestMt4State = null;
      if (cache) delete cache.mt4;
      fs.promises.unlink(MT4_STATE_FILE).catch(() => {});
      await mt4RemoteClear();
      res.writeHead(200, corsHeaders);
      return res.end(JSON.stringify({ ok: true, connected: false, mt4: null }));
    }
    const isResetCurve = u.searchParams.get('reset') === '1' || u.searchParams.get('resetCurve') === '1' || u.searchParams.get('resetAfterDeposit') === '1';
    const isForceResetStats = u.searchParams.get('dangerouslyForceResetStatsForever') === '1';

    if (isResetCurve || isForceResetStats) {
      if (!latestMt4State && MT4_REDIS_URL && MT4_REDIS_TOKEN) {
        try { latestMt4State = await mt4RemoteGet(); } catch (e) {}
      }
      if (latestMt4State) {
        const nowSec = Math.floor(Date.now() / 1000);
        const curBal = Number(latestMt4State.balance) || 0;
        const curEq = Number(latestMt4State.equity) || curBal;
        const curPnl = Number(latestMt4State.totalPnl) || 0;
        const curMar = Number(latestMt4State.margin) || 0;
        const curMl = Number(latestMt4State.marginLevel) || 0;
        const curPx = Number(latestMt4State.bid) || 0;
        const bLots = Number(latestMt4State.buyLots) || 0;
        const sLots = Number(latestMt4State.sellLots) || 0;
        const nLots = Number(latestMt4State.netLots) || Math.abs(bLots - sLots);

        const freshPt = {
          t: nowSec,
          bal: curBal,
          eq: curEq,
          pnl: curPnl,
          dd: Math.max(0, -curPnl),
          mar: curMar,
          ml: curMl,
          buyLots: bLots,
          sellLots: sLots,
          netLots: nLots,
          px: curPx
        };

        latestMt4State.initBal = curBal;
        latestMt4State.initBalTs = nowSec;

        // 仅规整折线图历史点，消除跳空悬崖断层
        latestMt4State.history = [freshPt];
        latestMt4State.historyLong = [{
          t: Math.floor(nowSec / 900) * 900,
          balMin: curBal, balMax: curBal,
          eqMin: curEq, eqMax: curEq,
          ddMax: Math.max(0, -curPnl),
          marMax: curMar,
          pnlEnd: curPnl,
          cnt: 1
        }];

        // ⚠️ 极其关键的风控原则：入金重置折线图时，绝不可清空历史浮亏峰值与阶梯统计档案！
        if (!latestMt4State.stats || !latestMt4State.stats.peaks) {
          latestMt4State.stats = createEmptyMt4Stats(nowSec, curBal, curEq);
        } else {
          ensureMt4SeededPeaks(latestMt4State.stats);
        }
        if (isForceResetStats) {
          latestMt4State.stats = createEmptyMt4Stats(nowSec, curBal, curEq);
        }

        await mt4RemoteSet(latestMt4State, true);
      }
      res.writeHead(200, corsHeaders);
      return res.end(JSON.stringify({ ok: true, reset: true, connected: !!latestMt4State, mt4: latestMt4State }));
    }
    if (u.searchParams.has('bal') || u.searchParams.has('balance')) {
      if (MT4_PUSH_TOKEN && u.searchParams.get('token') !== MT4_PUSH_TOKEN) {
        res.writeHead(403, corsHeaders);
        return res.end(JSON.stringify({ ok: false, error: 'bad token' }));
      }
      console.log(`[MT4] ${new Date().toLocaleTimeString()} 收到推送 from ${req.socket && req.socket.remoteAddress} · account=${u.searchParams.get('account') || '-'} · bal=${u.searchParams.get('bal') || u.searchParams.get('balance')} / buy=${u.searchParams.get('buyCnt') || u.searchParams.get('buyCount')}`);
    }
    // 若包含 bal 参数，说明是 MT4 EA WebRequest 推送过来的实时实盘状态
    if (u.searchParams.has('bal') || u.searchParams.has('balance')) {
      const ALIAS = { bal: 'balance', eq: 'equity', marginLvl: 'marginLevel', lev: 'leverage', buyCnt: 'buyCount', sellCnt: 'sellCount', buyAvg: 'buyAvgPrice', sellAvg: 'sellAvgPrice', buyStopCnt: 'buyStopCount', sellStopCnt: 'sellStopCount' };
      const num = (k, def = 0) => {
        let raw = u.searchParams.get(k);
        if (raw == null && ALIAS[k]) raw = u.searchParams.get(ALIAS[k]);
        const v = parseFloat(raw);
        return Number.isFinite(v) ? v : def;
      };
      const buyLots = +num('buyLots').toFixed(2);
      const sellLots = +num('sellLots').toFixed(2);
      const netLots = +Math.abs(buyLots - sellLots).toFixed(2);
      const accStr = u.searchParams.get('account') || '';
      const isMock = u.searchParams.get('mock') === '1' || accStr === '8861092' || accStr === '1';
      const buyAvgPrice = +num('buyAvg').toFixed(2);
      const buyPnl = +num('buyPnl').toFixed(2);
      const sellAvgPrice = +num('sellAvg').toFixed(2);
      const sellPnl = +num('sellPnl').toFixed(2);
      const spreadPts = +num('spread').toFixed(1);
      let bid = +num('bid').toFixed(2);
      let ask = +num('ask').toFixed(2);
      // 若 MT4 脚本死循环未调用 RefreshRates() 导致 Bid 静止，自动用多/空持仓均价与实时浮盈反推精确到 0.01$ 的实时 Bid/Ask
      if (buyLots > 0 && buyAvgPrice > 0) {
        const impliedBid = +(buyAvgPrice + buyPnl / (buyLots * 100)).toFixed(2);
        if (impliedBid > 1000 && Math.abs(impliedBid - bid) > 0.03) {
          bid = impliedBid;
          ask = +(bid + (spreadPts > 0 ? spreadPts : 25) / 100).toFixed(2);
        }
      } else if (sellLots > 0 && sellAvgPrice > 0) {
        const impliedAsk = +(sellAvgPrice - sellPnl / (sellLots * 100)).toFixed(2);
        if (impliedAsk > 1000 && Math.abs(impliedAsk - ask) > 0.03) {
          ask = impliedAsk;
          bid = +(ask - (spreadPts > 0 ? spreadPts : 25) / 100).toFixed(2);
        }
      }

      // 若当前 Serverless 实例冷启动或超过 20 秒未同步 Redis，先拉取一次确保多实例间峰值与历史不丢失
      if ((!latestMt4State || Date.now() - _mt4ReadTs > 20000) && MT4_REDIS_URL && MT4_REDIS_TOKEN) {
        try {
          const remoteState = await mt4RemoteGet();
          if (remoteState && (!latestMt4State || (remoteState.ts || 0) >= (latestMt4State.ts || 0))) {
            latestMt4State = remoteState;
          }
        } catch (e) {}
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const balVal = +num('bal').toFixed(2);
      const eqVal = +num('eq').toFixed(2);
      const marVal = +num('margin').toFixed(2);
      const freeMVal = +num('freeMargin').toFixed(2);
      const totalPnlVal = +num('totalPnl').toFixed(2);
      const mlVal = +num('marginLvl').toFixed(1);
      const buyCount = Math.round(num('buyCnt'));
      const sellCount = Math.round(num('sellCnt'));

      const prevStateForArc = latestMt4State;
      const { stats, history, historyLong, brokenPeakOrTier, archInfo } = updateMt4StatsAndHistory(latestMt4State, {
        nowSec, accStr, balVal, eqVal, marVal, freeMVal, mlVal,
        buyCount, buyLots, sellCount, sellLots, netLots, totalPnlVal, bid
      });
      if (!isMock) {
        try {
          await updateMt4Archive(prevStateForArc, { nowSec, accStr, balVal, eqVal, marVal, totalPnlVal, bid }, archInfo);
        } catch (e) { console.error('[MT4] archive update failed', e.message); }
      }

      const initBal = (latestMt4State && latestMt4State.account === accStr && latestMt4State.initBal > 0)
        ? latestMt4State.initBal
        : (history[0] ? history[0].bal : balVal);
      const closedProfit = +(balVal - initBal).toFixed(2);
      const netTotalProfit = +(eqVal - initBal).toFixed(2);

      latestMt4State = {
        updatedAt: new Date().toISOString(),
        ts: Date.now(),
        isMock,
        symbol: u.searchParams.get('sym') || u.searchParams.get('symbol') || 'XAUUSD',
        account: accStr,
        server: u.searchParams.get('server') || '',
        balance: balVal,
        equity: eqVal,
        initBal,
        closedProfit,
        netTotalProfit,
        margin: marVal,
        freeMargin: freeMVal,
        marginLevel: mlVal,
        leverage: Math.round(num('lev', 1000)),
        buyCount,
        buyLots,
        buyAvgPrice,
        buyPnl,
        sellCount,
        sellLots,
        sellAvgPrice,
        sellPnl,
        totalPnl: totalPnlVal,
        netLots,
        buyStopCount: Math.round(num('buyStopCnt')),
        sellStopCount: Math.round(num('sellStopCnt')),
        buyStopPx: +num('buyStopPx').toFixed(2),
        sellStopPx: +num('sellStopPx').toFixed(2),
        bid,
        ask,
        spreadPts,
        stats,
        history,
        historyLong
      };
      if (cache) cache.mt4 = latestMt4State;
      fs.promises.writeFile(MT4_STATE_FILE, JSON.stringify(latestMt4State), 'utf8').catch(() => {});
      await mt4RemoteSet(latestMt4State, brokenPeakOrTier);
    } else {
      const live = await mt4RemoteGet();
      if (live) latestMt4State = live;
      if (latestMt4State && (!latestMt4State.stats || !latestMt4State.stats.peaks)) {
        const s = latestMt4State;
        const nowSec = Math.floor((s.ts || Date.now()) / 1000);
        const { stats, history, historyLong } = updateMt4StatsAndHistory(s, {
          nowSec,
          accStr: s.account || '',
          balVal: s.balance || 0,
          eqVal: s.equity || 0,
          marVal: s.margin || 0,
          freeMVal: s.freeMargin || 0,
          mlVal: s.marginLevel || 0,
          buyCount: s.buyCount || 0,
          buyLots: s.buyLots || 0,
          sellCount: s.sellCount || 0,
          sellLots: s.sellLots || 0,
          netLots: s.netLots || 0,
          totalPnlVal: s.totalPnl || 0,
          bid: s.bid || 0
        });
        latestMt4State.stats = stats;
        latestMt4State.history = history;
        latestMt4State.historyLong = historyLong;
      }
    }
    res.writeHead(200, corsHeaders);
    return res.end(JSON.stringify({ ok: true, redisOk: !!(MT4_REDIS_URL && MT4_REDIS_TOKEN), connected: !!latestMt4State, mt4: latestMt4State }));
  } catch (e) {
    res.writeHead(500, corsHeaders);
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// 统一 /api/data 请求处理器：
// 1) 低频数据(1D kNN / GVZ / 金十周历)优先使用服务端缓存，过期后在后台异步静默更新，绝不阻塞打开网页！
// 2) 高频数据(1M~4H价格与震荡指数 / 跨市场指数 / 特朗普言论)实时并行拉取(~0.4秒内返回)。
async function handleApiData(req, res) {
  try {
    const u = new URL(req.url || '/api/data', 'http://localhost');
    const force = u.searchParams.get('force') === '1';
    const fast = u.searchParams.get('fast') === '1';
    const now = Date.now();
    const isStaleFull = !lastFullTs || (now - lastFullTs > REFRESH_MS);
    const isStaleFast = !lastFastTs || (now - lastFastTs > 6000); // 6秒内多端重复打开直接复用热实时缓存

    let data;
    if (force) {
      data = await refresh();
    } else if (!cache) {
      // 若冷启动尚无缓存且请求的是 fast=1，先极速抓高频数据(0.4s)立即返回，同时后台异步补全日线kNN与周历
      if (fast) {
        data = await refreshFast();
        refresh().catch(() => {});
      } else {
        data = await refresh();
      }
    } else {
      // 已有缓存：若低频数据(20分钟)过期，后台静默异步刷新，不阻塞当前请求！
      if (isStaleFull && !inflight) {
        refresh().catch(() => {});
      }
      // 高频数据：只要距离上次抓取超过 6 秒或明确指定 fast=1，立即刷新高频实时数据(~0.4s)
      if (fast || isStaleFast) {
        data = await refreshFast();
      } else {
        data = cache;
      }
    }

    const mt4Live = await mt4RemoteGet();
    if (mt4Live) latestMt4State = mt4Live;
    if (latestMt4State) data.mt4 = latestMt4State;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
// 通过 CommonJS require('./public-html') 直接将前端 HTML 作为 JS 模块打包进 Vercel Serverless 镜像，彻底杜绝 Vercel 运行时 ENOENT 找不到文件
const EMBEDDED_HTML = require('./public-html');
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');

const appHandler = async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (u.pathname === '/api/mt4' || u.pathname.startsWith('/api/mt4')) {
    return handleApiMt4(req, res);
  }
  if (u.pathname === '/api/data' || u.pathname.startsWith('/api/data')) {
    return handleApiData(req, res);
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    if (!process.env.VERCEL && fs.existsSync(INDEX_HTML_PATH)) {
      try {
        const diskHtml = await fs.promises.readFile(INDEX_HTML_PATH, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(diskHtml);
      } catch (e) {}
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(EMBEDDED_HTML);
  }
  const safeRel = path.normalize(u.pathname).replace(/^(\.\.[\\/])+/, '').replace(/^[/\\]+/, '');
  const file = path.join(__dirname, 'public', safeRel);
  try {
    const buf = await fs.promises.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(buf);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
};

if (require.main === module && !process.env.VERCEL) {
  http.createServer(appHandler).listen(PORT, () => {
    console.log(`黄金震荡指数网站: http://localhost:${PORT}`);
    refresh().catch((e) => console.error('首次抓取失败', e.message));
    setInterval(() => refreshFast().catch((e) => console.error('1M/5M实时更新失败', e.message)), FAST_MS);
    setInterval(() => refresh().catch((e) => console.error('定时更新失败', e.message)), REFRESH_MS);
  });
}

module.exports = appHandler;
module.exports.handleApiData = handleApiData;
module.exports.handleApiMt4 = handleApiMt4;
module.exports.refresh = refresh;
module.exports.refreshFast = refreshFast;

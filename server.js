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
module.exports.refresh = refresh;
module.exports.refreshFast = refreshFast;

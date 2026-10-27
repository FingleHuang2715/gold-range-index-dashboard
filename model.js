// 黄金震荡指数 - 量化模型
// 1) 指标连续打分 -> 单周期震荡指数(0-100)
// 2) 多周期加权 -> 当前震荡指数; 叠加时段/临近事件 -> 当前运行指数
// 3) 日线 kNN 历史相似行情 + 挤压风险 + GVZ + 金十日历 -> 未来 5 个交易日震荡指数

// ---------- 基础 ----------
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
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
// 分段线性插值: pts = [[x0,y0],[x1,y1],...] (x 递增)
function lerp(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}
const r1 = (x) => x == null || isNaN(x) ? null : Math.round(x * 10) / 10;

// ---------- 单周期打分 (分数越高越震荡) ----------
const SCORE_RULES = [
  { key: 'adx', name: 'ADX', w: 20, f: (v) => lerp(v, [[15, 100], [20, 70], [25, 35], [40, 0]]) },
  { key: 'chop', name: 'CHOP', w: 20, f: (v) => lerp(v, [[30, 0], [38.2, 15], [50, 50], [61.8, 85], [65, 100]]) },
  { key: 'er', name: '效率比ER', w: 20, f: (v) => lerp(v, [[0.1, 100], [0.25, 70], [0.5, 25], [0.7, 0]]) },
  { key: 'emaDist', name: 'EMA50偏离', w: 10, f: (v) => lerp(Math.abs(v), [[0.5, 100], [1, 80], [2, 35], [3, 0]]) },
  { key: 'rsi', name: 'RSI', w: 10, f: (v) => lerp(Math.abs(v - 50), [[5, 100], [10, 75], [20, 20], [25, 0]]) },
  { key: 'bbwPct', name: '布林带宽分位', w: 10, f: (v) => lerp(v, [[0, 90], [50, 55], [100, 10]]) },
  { key: 'atrRatio', name: 'ATR比率', w: 10, f: (v) => lerp(v, [[0.7, 90], [1.0, 65], [1.25, 30], [1.6, 0]]) },
];

function scoreTF(t) {
  let sw = 0, s = 0;
  const parts = [];
  for (const r of SCORE_RULES) {
    const v = t[r.key];
    if (v == null || isNaN(v)) continue;
    const sc = r.f(v);
    sw += r.w; s += sc * r.w;
    parts.push({ name: r.name, value: v, score: r1(sc), weight: r.w });
  }
  return { index: sw ? r1(s / sw) : null, parts };
}

// ---------- 全序列指标 (用于 kNN 与走势图) ----------
function featureSeries(bars, W = 250) {
  const n = bars.length, c = bars.map((b) => b.c);
  const tr = trueRanges(bars);
  const atr14 = wilderATR(tr, 14), atr100 = wilderATR(tr, 100);
  const adx = new Array(n).fill(null), chop = new Array(n).fill(null), er = new Array(n).fill(null);
  const bbw = new Array(n).fill(null), bbwPct = new Array(n).fill(null), atrPct = new Array(n).fill(null);
  const bbUp = new Array(n).fill(null), bbMid = new Array(n).fill(null), bbLo = new Array(n).fill(null);
  const emaDist = new Array(n).fill(null), rsi = new Array(n).fill(null), atrRatio = new Array(n).fill(null);
  const pct = (arr, i) => {
    const v = arr[i]; let cnt = 0, tot = 0;
    for (let k = Math.max(0, i - W + 1); k <= i; k++) if (arr[k] != null) { tot++; if (arr[k] <= v) cnt++; }
    return tot ? cnt / tot * 100 : null;
  };
  // ADX(14)
  { const N = 14; let sTR = 0, sP = 0, sM = 0, a = null; const dx = [];
    for (let i = 1; i < n; i++) {
      const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
      const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
      if (i <= N) { sTR += tr[i]; sP += p; sM += m; if (i < N) continue; }
      else { sTR = sTR - sTR / N + tr[i]; sP = sP - sP / N + p; sM = sM - sM / N + m; }
      const pdi = sTR ? 100 * sP / sTR : 0, mdi = sTR ? 100 * sM / sTR : 0;
      const d = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
      dx.push(d);
      if (dx.length === N) a = dx.reduce((x, y) => x + y, 0) / N; else if (dx.length > N) a = (a * (N - 1) + d) / N;
      if (a != null) adx[i] = a;
    } }
  // RSI(14)
  { const N = 14; let g = 0, l = 0;
    for (let i = 1; i < n; i++) {
      const d = c[i] - c[i - 1];
      if (i <= N) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === N) { g /= N; l /= N; } else continue; }
      else { g = (g * (N - 1) + Math.max(d, 0)) / N; l = (l * (N - 1) + Math.max(-d, 0)) / N; }
      rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    } }
  let ema = c[0]; const k = 2 / 51;
  for (let i = 0; i < n; i++) {
    if (i > 0) ema = c[i] * k + ema * (1 - k);
    if (i >= 50 && atr14[i]) emaDist[i] = (c[i] - ema) / atr14[i];
    if (atr14[i] && atr100[i]) atrRatio[i] = atr14[i] / atr100[i];
    if (i >= 14) {
      let s = 0, hh = -Infinity, ll = Infinity;
      for (let j = i - 13; j <= i; j++) { s += tr[j]; hh = Math.max(hh, bars[j].h); ll = Math.min(ll, bars[j].l); }
      chop[i] = hh === ll ? 100 : 100 * Math.log10(s / (hh - ll)) / Math.log10(14);
    }
    if (i >= 20) {
      let p = 0; for (let j = i - 19; j <= i; j++) p += Math.abs(c[j] - c[j - 1]);
      er[i] = p ? Math.abs(c[i] - c[i - 20]) / p : 0;
    }
    if (i >= 19) {
      let m = 0; for (let j = i - 19; j <= i; j++) m += c[j]; m /= 20;
      let v = 0; for (let j = i - 19; j <= i; j++) v += (c[j] - m) ** 2;
      const sd = Math.sqrt(v / 20);
      bbMid[i] = m; bbUp[i] = m + 2 * sd; bbLo[i] = m - 2 * sd;
      bbw[i] = 4 * sd / m * 100;
      bbwPct[i] = pct(bbw, i);
    }
    if (atr14[i] != null) atrPct[i] = pct(atr14, i);
  }
  return { n, c, atr14, adx, chop, er, bbw, bbwPct, bbUp, bbMid, bbLo, atrPct, emaDist, rsi, atrRatio };
}

function featAt(F, i) {
  return { adx: F.adx[i], chop: F.chop[i], er: F.er[i], emaDist: F.emaDist[i], rsi: F.rsi[i], bbwPct: F.bbwPct[i], atrRatio: F.atrRatio[i] };
}

// 近 N 根 K 线的震荡指数走势 (含震荡指数单次变化 chg1、单次跌幅 drop1、3根累计跌幅 drop3、单根K线振幅 barSpan)
function indexSeries(bars, last = 120, W = 500) {
  const F = featureSeries(bars, W), tmp = [];
  for (let i = Math.max(0, F.n - last - 4); i < F.n; i++) {
    const s = scoreTF(featAt(F, i));
    if (s.index == null) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, i - 13); j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    const net = i >= 13 ? bars[i].c - bars[i - 13].o : 0;
    const dir = (F.emaDist[i] != null ? (F.emaDist[i] >= 0 ? 1 : -1) : 0) + (net >= 0 ? 1 : -1) >= 0 ? 'UP' : 'DOWN';
    tmp.push({
      t: bars[i].t, v: s.index,
      o: +bars[i].o.toFixed(2), h: +bars[i].h.toFixed(2), l: +bars[i].l.toFixed(2), c: +bars[i].c.toFixed(2),
      barSpan: +(bars[i].h - bars[i].l).toFixed(2),
      bbU: F.bbUp[i] != null ? +F.bbUp[i].toFixed(2) : null,
      bbM: F.bbMid[i] != null ? +F.bbMid[i].toFixed(2) : null,
      bbL: F.bbLo[i] != null ? +F.bbLo[i].toFixed(2) : null,
      span: +(hi - lo).toFixed(2), dir
    });
  }
  for (let k = 0; k < tmp.length; k++) {
    const prev = k > 0 ? tmp[k - 1].v : tmp[k].v;
    const p3 = k > 0 ? Math.max(...tmp.slice(Math.max(0, k - 3), k).map((x) => x.v)) : tmp[k].v;
    tmp[k].chg1 = r1(tmp[k].v - prev);
    tmp[k].drop1 = r1(Math.max(0, prev - tmp[k].v));
    tmp[k].drop3 = r1(Math.max(0, p3 - tmp[k].v));
  }
  return tmp.slice(-last);
}

// ---------- 日线 kNN 历史相似行情 ----------
// "震荡日"定义: |当日收盘-前收| ≤ 0.6×ATR 且 当日振幅 ≤ 1.25×ATR (ATR取前一日)
function isRangeDay(bars, F, j) {
  const a = F.atr14[j - 1];
  if (!a) return null;
  return Math.abs(bars[j].c - bars[j - 1].c) <= 0.6 * a && (bars[j].h - bars[j].l) <= 1.25 * a ? 1 : 0;
}

function knnModel(dailyAll, gmtoffset = -14400, H = 5, K = 150) {
  // 去掉进行中的当日K线
  const tradeDate = (ms) => new Date(ms + gmtoffset * 1000 + 6 * 3600e3).toISOString().slice(0, 10);
  const barDate = (t) => new Date((t + gmtoffset) * 1000).toISOString().slice(0, 10);
  const nowTD = tradeDate(Date.now());
  const bars = barDate(dailyAll[dailyAll.length - 1].t) >= nowTD ? dailyAll.slice(0, -1) : dailyAll.slice();
  const F = featureSeries(bars, 250);
  const n = bars.length;
  const vec = (i) => {
    const f = featAt(F, i);
    if (Object.values(f).some((v) => v == null || isNaN(v))) return null;
    return [f.adx, f.chop, f.er * 100, f.bbwPct, f.atrRatio * 100, Math.min(Math.abs(f.emaDist), 4) * 25, Math.abs(f.rsi - 50) * 2];
  };
  const rows = [];
  for (let i = 120; i < n; i++) { const v = vec(i); if (v) rows.push({ i, v }); }
  const q = vec(n - 1);
  if (!q || rows.length < 300) return null;
  const D = q.length, mu = new Array(D).fill(0), sd = new Array(D).fill(0);
  rows.forEach((r) => r.v.forEach((x, d) => mu[d] += x / rows.length));
  rows.forEach((r) => r.v.forEach((x, d) => sd[d] += (x - mu[d]) ** 2 / rows.length));
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) || 1;
  const dist = (a, b) => { let s = 0; for (let d = 0; d < D; d++) s += ((a[d] - b[d]) / sd[d]) ** 2; return Math.sqrt(s); };
  const label = new Array(n).fill(null);
  for (let j = 1; j < n; j++) label[j] = isRangeDay(bars, F, j);
  rows.forEach((r) => r.d = dist(r.v, q));

  const horizons = [];
  for (let h = 1; h <= H; h++) {
    const train = rows.filter((r) => r.i + h < n && label[r.i + h] != null);
    const base = train.reduce((s, r) => s + label[r.i + h], 0) / train.length;
    const nn = [...train].sort((a, b) => a.d - b.d).slice(0, K);
    const p = nn.reduce((s, r) => s + label[r.i + h], 0) / nn.length;
    horizons.push({ h, p: +(p * 100).toFixed(1), base: +(base * 100).toFixed(1) });
  }
  const similar = [...rows].filter((r) => r.i < n - 5).sort((a, b) => a.d - b.d).slice(0, 5).map((r) => ({
    date: barDate(bars[r.i].t), next3: [1, 2, 3].map((h) => label[r.i + h] ? '震' : '单').join(''),
  }));

  // 历史验证 (只用当时之前的数据, 最近 500 天, h=1)
  const val = [];
  const recent = rows.filter((r) => r.i >= n - 501 && r.i + 1 < n);
  for (const r of recent) {
    const past = rows.filter((x) => x.i + 1 < r.i);
    if (past.length < 300) continue;
    const ds = past.map((x) => ({ d: dist(x.v, r.v), y: label[x.i + 1] })).sort((a, b) => a.d - b.d).slice(0, K);
    val.push({ p: ds.reduce((s, x) => s + x.y, 0) / ds.length, y: label[r.i + 1] });
  }
  let validation = null;
  if (val.length > 60) {
    val.sort((a, b) => a.p - b.p);
    const t = Math.floor(val.length / 3);
    const rate = (arr) => +(arr.reduce((s, x) => s + x.y, 0) / arr.length * 100).toFixed(1);
    validation = { samples: val.length, lowGroup: rate(val.slice(0, t)), midGroup: rate(val.slice(t, 2 * t)), highGroup: rate(val.slice(2 * t)), all: rate(val) };
  }
  const daily = featAt(F, n - 1);
  daily.price = bars[n - 1].c;
  return { horizons, similar, validation, daily, dailyIndex: scoreTF(daily).index, lastDate: barDate(bars[n - 1].t), samples: rows.length };
}

// ---------- 金十事件 -> 每日风险扣分 ----------
const TOP = /非农|CPI|利率决|FOMC|鲍威尔|PCE|联储主席/;
const KEY = /GDP|失业率|初请|零售销售|ISM|PPI|JOLTS|ADP|职位空缺|就业/;
function eventPenalty(e) {
  const us = /美国|美联储/.test(e.country) || /美联储|鲍威尔|FOMC/.test(e.title);
  let p = e.star >= 5 ? 12 : e.star === 4 ? 7 : e.star === 3 ? 2 : 0;
  if (!us) p *= /欧元区|欧洲|中国|英国|日本/.test(e.country) ? 0.4 : 0.2;
  if (us && TOP.test(e.title)) p += 8; else if (us && KEY.test(e.title)) p += 3;
  return p;
}
function topicOf(e) { const m = e.title.match(TOP) || e.title.match(KEY); return m ? e.country + m[0] : null; }
// 北京时间 -> 黄金交易日 (06:00 前算前一交易日)
function tradingDayOf(e) {
  const [d, hm] = e.time.split(' ');
  if (!d) return null;
  if (e.pending || !hm || parseInt(hm, 10) >= 6) return d;
  return new Date(Date.parse(d + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
}

function dayRisk(events, day, mondayExtra = []) {
  const seen = {}; let total = 0; const list = [];
  const add = (e, w) => {
    const p = eventPenalty(e) * w;
    if (p < 1) return;
    const tp = topicOf(e);
    if (tp) { if ((seen[tp] || 0) >= p) return; total -= seen[tp] || 0; seen[tp] = p; }
    total += p; list.push({ time: e.time, title: e.title, star: e.star, country: e.country, p: r1(p) });
  };
  events.filter((e) => tradingDayOf(e) === day).forEach((e) => add(e, 1));
  mondayExtra.forEach(([e, w]) => add(e, w));
  list.sort((a, b) => b.p - a.p);
  return { penalty: r1(Math.min(30, total)), events: list.slice(0, 6) };
}

// ---------- 等级 (当处于偏单边/强单边时, 若提供 dir 则显示上涨/下跌趋势) ----------
function level(x, dir) {
  if (x == null) return { name: '-', cls: 'MIXED', advice: '' };
  if (x >= 70) return { name: '强震荡', cls: 'RANGE', advice: '适合正常运行网格/马丁' };
  if (x >= 55) return { name: '偏震荡', cls: 'RANGE', advice: '可运行,常规参数,注意风控' };
  if (x >= 45) return { name: '过渡', cls: 'MIXED', advice: '减仓、放大网格间距、降低马丁倍数' };
  const dTxt = dir === 'UP' ? '·📈上涨趋势' : dir === 'DOWN' ? '·📉下跌趋势' : '';
  const dAdv = dir === 'UP' ? '(上涨趋势,严禁逆势空单加仓)' : dir === 'DOWN' ? '(下跌趋势,严禁逆势多单加仓)' : '';
  if (x >= 30) return { name: '偏单边' + dTxt, cls: 'TREND', advice: '暂停新开网格,仅保护已有持仓' + dAdv };
  return { name: '强单边' + dTxt, cls: 'TREND', advice: '停止网格/马丁,严禁逆势加仓' + dAdv };
}

// ---------- 综合 ----------
function composite({ timeframes, session, gvz, events, knn }) {
  // 1) 当前震荡指数 (多周期加权: 1M/5M/15M/1H/4H)
  const W = { '1M': 0.05, '5M': 0.1, '15M': 0.2, '1H': 0.4, '4H': 0.25 };
  let s = 0, w = 0, dirScore = 0; const tfIdx = {}, tfLevel = {};
  for (const k of Object.keys(timeframes)) {
    const sc = scoreTF(timeframes[k]);
    const td = timeframes[k].trendDir;
    timeframes[k].rangeIndex = sc.index;
    timeframes[k].rangeParts = sc.parts;
    timeframes[k].rangeLevel = level(sc.index, td);
    tfIdx[k] = sc.index;
    tfLevel[k] = timeframes[k].rangeLevel;
    if (W[k] && sc.index != null) {
      s += sc.index * W[k]; w += W[k];
      dirScore += (td === 'UP' ? 1 : -1) * W[k];
    }
  }
  const overallDir = dirScore >= 0 ? 'UP' : 'DOWN';
  const current = w ? r1(s / w) : null;

  // 2) 当前运行指数 = 当前震荡指数 + 时段修正 + 未来4小时事件
  const adj = [];
  const h = session.bjHour;
  let sessAdj = 0;
  if (h >= 7 && h < 15) sessAdj = 5; else if (h >= 20 || h < 2) sessAdj = -8; else if (h >= 15) sessAdj = -2; else sessAdj = 0;
  adj.push({ name: `时段(${session.active.join('+')})`, v: sessAdj });
  const now = Date.now();
  const soon = events.filter((e) => {
    if (e.pending) return false;
    const t = Date.parse(e.time.replace(' ', 'T') + ':00+08:00');
    return t >= now - 30 * 60e3 && t <= now + 4 * 3600e3;
  });
  let evAdj = 0; const seen = {};
  soon.forEach((e) => { const p = eventPenalty(e); const tp = topicOf(e) || e.title; if (!seen[tp] || seen[tp] < p) { evAdj += p - (seen[tp] || 0); seen[tp] = p; } });
  evAdj = -Math.min(30, evAdj * 1.2);
  if (soon.length) adj.push({ name: `未来4小时事件 ${soon.length} 条`, v: r1(evAdj) });
  const run = current == null ? null : r1(clamp(current + sessAdj + evAdj));

  // 3) 未来 5 个交易日
  const tf4 = timeframes['4H'] || {};
  let sq = 0; const sqWhy = [];
  if (tf4.bbwPct != null && tf4.bbwPct < 25) { sq = Math.max(sq, (25 - tf4.bbwPct) / 25); sqWhy.push(`4H布林带宽分位 ${tf4.bbwPct}%`); }
  if (tf4.atrRatio != null && tf4.atrRatio < 0.85) { sq = Math.max(sq, clamp((0.85 - tf4.atrRatio) / 0.25, 0, 1)); sqWhy.push(`4H ATR比率 ${tf4.atrRatio}`); }
  if (knn && knn.daily.bbwPct != null && knn.daily.bbwPct < 20) { sq = Math.max(sq, (20 - knn.daily.bbwPct) / 20); sqWhy.push(`日线布林带宽分位 ${r1(knn.daily.bbwPct)}%`); }
  let gvzAdj = 0, gvzRise = 0;
  if (gvz) { gvzAdj = clamp(-(gvz.pct1y - 50) / 50 * 6, -6, 6); if (gvz.change5d > 2) gvzRise = -4; else if (gvz.change5d < -2) gvzRise = 2; }

  const days = [];
  const bjNow = new Date(now + 8 * 3600e3);
  let cur = new Date(Date.parse(bjNow.toISOString().slice(0, 10) + 'T00:00:00Z') - (bjNow.getUTCHours() < 6 ? 86400e3 : 0));
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const fmt = (d) => d.toISOString().slice(0, 10);
  const persist = [0.6, 0.4, 0.3, 0.2, 0.15];
  const sqRamp = [4, 8, 12, 12, 12];
  while (days.length < 5) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const d = days.length, day = fmt(cur);
      const extra = [];
      if (dow === 1) { // 周末事件计入周一
        const sat = fmt(new Date(cur - 2 * 86400e3)), sun = fmt(new Date(cur - 86400e3));
        events.forEach((e) => { const td = tradingDayOf(e); if (td === sat) extra.push([e, 0.5]); if (td === sun) extra.push([e, 0.7]); });
      }
      const risk = dayRisk(events, day, extra);
      const hz = knn && knn.horizons[Math.min(d, knn.horizons.length - 1)];
      const knnScore = hz ? clamp(50 + (hz.p - hz.base) * 2) : null;
      const daily = knn ? knn.dailyIndex : current;
      const tech = current == null ? daily : persist[d] * current + (1 - persist[d]) * (daily ?? current);
      const base = knnScore == null ? tech : 0.55 * tech + 0.45 * knnScore;
      const sqAdj = -sq * sqRamp[d];
      const gAdj = gvzAdj + (d >= 1 ? gvzRise : 0);
      const v = r1(clamp(base - risk.penalty + sqAdj + gAdj));
      days.push({
        date: day, weekday: wk[dow], label: d === 0 ? '今天' : wk[dow], index: v, level: level(v),
        parts: { tech: r1(tech), knn: knnScore == null ? null : r1(knnScore), knnP: hz && hz.p, knnBase: hz && hz.base, squeeze: r1(sqAdj), gvz: r1(gAdj), events: -risk.penalty },
        events: risk.events,
      });
    }
    cur = new Date(cur.getTime() + 86400e3);
  }
  return {
    current, currentLevel: level(current, overallDir), run, runLevel: level(run, overallDir), overallDir,
    overallDirText: overallDir === 'UP' ? '📈 多头/上涨主导' : '📉 空头/下跌主导',
    runAdj: adj, tfIdx, tfLevel,
    squeeze: { strength: r1(sq * 100), why: sqWhy }, gvzAdj: r1(gvzAdj), gvzRise,
    forecast: days, weights: W,
  };
}

module.exports = { scoreTF, indexSeries, knnModel, composite, level, featureSeries };

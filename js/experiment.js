/*
 * GeoPath — вычислительный эксперимент: сравнение Дейкстры, A* и двунаправленной Дейкстры
 * на случайных парах вершин графа Минска (фиксированный seed → воспроизводимость).
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});
  const isNode = typeof module !== 'undefined' && module.exports;
  const geo = GP.geo || (isNode ? require('./geo.js') : null);
  const A = GP.algorithms || (isNode ? require('./algorithms.js') : null);
  const config = GP.config || (isNode ? require('./config.js') : null);

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Замер времени вычисления. performance.now() огрублён в браузерах (0,1–1 мс), поэтому
   * алгоритм запускается сериями, пока серия не займёт ≥ 30 мс; время одного запуска =
   * время серии / число запусков. Перед замером — холостой запуск (прогрев JIT).
   * mode = 'median' (интерфейс, 5 серий) или 'min' (эксперимент, 3 серии).
   */
  function timeIt(fn, series, mode) {
    fn(); // прогрев
    let k = 1, dt = 0;
    for (;;) {
      const t0 = now();
      for (let i = 0; i < k; i++) fn();
      dt = now() - t0;
      if (dt >= 30) break;
      k = dt < 1 ? k * 10 : Math.ceil((k * 33) / dt);
    }
    const times = [dt / k];
    for (let s = 1; s < series; s++) {
      const t0 = now();
      for (let i = 0; i < k; i++) fn();
      times.push((now() - t0) / k);
    }
    times.sort((a, b) => a - b);
    return mode === 'min' ? times[0] : times[times.length >> 1];
  }

  /** Пары вершин с фиксированным seed; пары ближе minStraight м по прямой пропускаются. */
  function makePairs(g, count, seed, minStraight) {
    const r = geo.rng(seed);
    const pairs = [];
    let guard = 0;
    while (pairs.length < count && guard++ < count * 1000) {
      const s = geo.randInt(r, g.n), t = geo.randInt(r, g.n);
      if (s === t) continue;
      const d = geo.haversine(g.lat[s], g.lon[s], g.lat[t], g.lon[t]);
      if (d < minStraight) continue;
      pairs.push({ s, t, straight: d });
    }
    return pairs;
  }

  const GROUPS = [
    { name: 'до 3 км', lo: 0, hi: 3 },
    { name: '3–7 км', lo: 3, hi: 7 },
    { name: '7–12 км', lo: 7, hi: 12 },
    { name: 'более 12 км', lo: 12, hi: Infinity },
    { name: 'все', lo: -Infinity, hi: Infinity },
  ];

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

  /**
   * opts: { pairs, weight, seed, timing (true), onProgress(i, n) }
   * Возвращает { header, rows, summary }.
   */
  async function run(g, opts) {
    opts = Object.assign({ pairs: 100, weight: 'dist', seed: config.EXPERIMENT_SEED, timing: true }, opts || {});
    const w = opts.weight;
    const pairs = makePairs(g, opts.pairs, opts.seed, config.EXPERIMENT_MIN_STRAIGHT_M);
    const rows = [];
    for (let i = 0; i < pairs.length; i++) {
      const { s, t, straight } = pairs[i];
      const d = A.dijkstra(g, s, t, { weight: w });
      const a = A.astar(g, s, t, { weight: w });
      const b = A.bidirectional(g, s, t, { weight: w });
      const lengthM = A.pathCost(g, d.path.edges, 'dist');
      const timeS = A.pathCost(g, d.path.edges, 'time');
      const row = {
        i: i + 1, s, t,
        straightKm: straight / 1000,
        routeKm: lengthM / 1000,
        routeMin: timeS / 60,
        cost: d.cost,
        tortuosity: lengthM / straight,
        D: { settled: d.settled, relax: d.relaxations, heap: d.heapOps, ms: NaN },
        A: { settled: a.settled, relax: a.relaxations, heap: a.heapOps, ms: NaN },
        B: { settled: b.settled, relax: b.relaxations, heap: b.heapOps, ms: NaN },
        match: same(d.cost, a.cost) && same(d.cost, b.cost),
      };
      if (opts.timing) {
        row.D.ms = timeIt(() => A.dijkstra(g, s, t, { weight: w }), 3, 'min');
        row.A.ms = timeIt(() => A.astar(g, s, t, { weight: w }), 3, 'min');
        row.B.ms = timeIt(() => A.bidirectional(g, s, t, { weight: w }), 3, 'min');
      }
      rows.push(row);
      if (opts.onProgress) opts.onProgress(i + 1, pairs.length);
      await tick();
    }
    return { header: header(g, opts), rows, summary: summarize(rows) };
  }

  function same(a, b) {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }

  function summarize(rows) {
    return GROUPS.map((gr) => {
      const r = rows.filter((x) => x.routeKm >= gr.lo && x.routeKm < gr.hi);
      const sD = mean(r.map((x) => x.D.settled)), sA = mean(r.map((x) => x.A.settled)), sB = mean(r.map((x) => x.B.settled));
      return {
        group: gr.name,
        count: r.length,
        avgKm: mean(r.map((x) => x.routeKm)),
        avgMin: mean(r.map((x) => x.routeMin)),
        settledD: sD, settledA: sA, settledB: sB,
        ratioDA: sD / sA, // во сколько раз A* обрабатывает меньше вершин (отношение средних)
        ratioDB: sD / sB,
        msD: mean(r.map((x) => x.D.ms)), msA: mean(r.map((x) => x.A.ms)), msB: mean(r.map((x) => x.B.ms)),
        tortuosity: mean(r.map((x) => x.tortuosity)),
        matchPct: r.length ? (100 * r.filter((x) => x.match).length) / r.length : NaN,
      };
    });
  }

  function header(g, opts) {
    const inNode = typeof process !== 'undefined' && process.versions && process.versions.node && typeof window === 'undefined';
    const ua = inNode ? 'Node.js ' + process.version : shortUA(navigator.userAgent);
    return {
      osmDate: g.meta && g.meta.date,
      v: g.n, e: g.m,
      browser: ua,
      seed: opts.seed,
      pairs: opts.pairs,
      weight: opts.weight,
      runAt: new Date().toISOString(),
    };
  }

  function shortUA(ua) {
    const m =
      /(Edg|OPR|YaBrowser|Firefox|Chrome|Version)\/([\d.]+)/.exec(ua) || [];
    let name = m[1] || 'Браузер';
    if (name === 'Edg') name = 'Edge';
    if (name === 'OPR') name = 'Opera';
    if (name === 'Version') name = 'Safari';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return name + ' ' + (m[2] || '').split('.')[0] + (os ? ', ' + os : '');
  }

  /* ---------- Экспорт ---------- */
  const num = (x, d) => (isFinite(x) ? x.toFixed(d) : '');
  const comma = (s) => String(s).replace('.', ',');

  /** CSV по всем парам: разделитель «;», десятичная запятая, BOM для Excel. */
  function toCSV(res) {
    const h = res.header;
    const lines = [
      '# GeoPath: вычислительный эксперимент; снимок OSM ' + h.osmDate + '; |V|=' + h.v + '; |E|=' + h.e +
        '; seed=' + h.seed + '; критерий=' + (h.weight === 'time' ? 'время' : 'расстояние') + '; ' + h.browser,
      [
        'pair', 's', 't', 'straight_km', 'route_km', 'route_min', 'cost', 'tortuosity',
        'dijkstra_settled', 'dijkstra_relax', 'dijkstra_heap', 'dijkstra_ms',
        'astar_settled', 'astar_relax', 'astar_heap', 'astar_ms',
        'bidir_settled', 'bidir_relax', 'bidir_heap', 'bidir_ms', 'match',
      ].join(';'),
    ];
    for (const r of res.rows) {
      lines.push([
        r.i, r.s, r.t, num(r.straightKm, 3), num(r.routeKm, 3), num(r.routeMin, 2), num(r.cost, 3), num(r.tortuosity, 3),
        r.D.settled, r.D.relax, r.D.heap, num(r.D.ms, 4),
        r.A.settled, r.A.relax, r.A.heap, num(r.A.ms, 4),
        r.B.settled, r.B.relax, r.B.heap, num(r.B.ms, 4),
        r.match ? 1 : 0,
      ].map(comma).join(';'));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /** Сводная таблица для статьи: TSV, числа с запятой (вставляется в Word как таблица). */
  function toTSV(res) {
    const cols = [
      'Длина маршрута', 'Число пар', 'Средняя длина, км', 'Коэф. извилистости',
      'Обработано вершин: Дейкстра', 'Обработано вершин: A*', 'Обработано вершин: двунапр.',
      'A* меньше в, раз', 'Время Дейкстры, мс', 'Время A*, мс', 'Время двунапр., мс', 'Совпадение, %',
    ];
    const out = [cols.join('\t')];
    for (const s of res.summary) {
      out.push([
        s.group, s.count, num(s.avgKm, 2), num(s.tortuosity, 2),
        num(s.settledD, 0), num(s.settledA, 0), num(s.settledB, 0),
        num(s.ratioDA, 2), num(s.msD, 3), num(s.msA, 3), num(s.msB, 3), num(s.matchPct, 0),
      ].map(comma).join('\t'));
    }
    return out.join('\r\n');
  }

  const experiment = { run, timeIt, makePairs, summarize, toCSV, toTSV, GROUPS, shortUA };
  GP.experiment = experiment;
  if (isNode) module.exports = experiment;
})(typeof window !== 'undefined' ? window : globalThis);

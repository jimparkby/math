/*
 * GeoPath — встроенная проверка корректности (п. 4 ТЗ).
 * Используется кнопкой «Самопроверка» в браузере и тестом node tests/algorithms.test.js.
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});
  const isNode = typeof module !== 'undefined' && module.exports;
  const geo = GP.geo || (isNode ? require('./geo.js') : null);
  const G = GP.graph || (isNode ? require('./graph.js') : null);
  const A = GP.algorithms || (isNode ? require('./algorithms.js') : null);

  const REL_TOL = 1e-9;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Равенство стоимостей с относительной точностью 1e-9 (∞ = ∞). */
  function same(a, b) {
    if (a === b) return true;
    if (!isFinite(a) || !isFinite(b)) return false;
    return Math.abs(a - b) <= REL_TOL * Math.max(1, Math.abs(a), Math.abs(b));
  }

  /* ---------- Граф из статьи (рисунок 1, таблица 2) ---------- */
  const PAPER_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];
  const PAPER_EDGES = [
    [0, 1, 7], [0, 2, 9], [0, 5, 14], [1, 3, 15], [2, 3, 11], [2, 5, 2], [3, 4, 6], [4, 5, 9],
  ];
  function paperGraph() {
    return G.Graph.fromEdgeList(6, PAPER_EDGES, { undirected: true, names: PAPER_NAMES });
  }

  function checkPaper() {
    const g = paperGraph();
    const nm = (p) => p.map((v) => PAPER_NAMES[v]).join('–');
    const out = [];
    const d = A.dijkstra(g, 0, -1, { record: true });
    const order = d.order.map((v) => PAPER_NAMES[v] + '(' + d.dist[v] + ')');
    const orderOk =
      order.slice(0, 4).join(' ') === 'A(0) B(7) C(9) F(11)' &&
      new Set(order.slice(4)).size === 2 && order.slice(4).every((x) => x === 'D(20)' || x === 'E(20)');
    const dt = A.dijkstra(g, 0, 4);
    out.push({
      name: 'Граф статьи: Дейкстра',
      ok: orderOk && dt.cost === 20 && nm(dt.path.vertices) === 'A–C–F–E',
      details: 'путь ' + nm(dt.path.vertices) + ', L = ' + dt.cost + '; порядок обработки: ' + order.join(' '),
    });
    const as = A.astar(g, 0, 4); // без координат h ≡ 0
    out.push({
      name: 'Граф статьи: A* (h ≡ 0)',
      ok: as.cost === 20 && nm(as.path.vertices) === 'A–C–F–E',
      details: 'путь ' + nm(as.path.vertices) + ', L = ' + as.cost,
    });
    const bi = A.bidirectional(g, 0, 4);
    out.push({
      name: 'Граф статьи: двунаправленная Дейкстра',
      ok: bi.cost === 20 && nm(bi.path.vertices) === 'A–C–F–E',
      details: 'путь ' + nm(bi.path.vertices) + ', L = ' + bi.cost,
    });
    const bf = A.bellmanFord(g, 0, 4);
    const bfAll = Array.from(bf.dist).join(',');
    out.push({
      name: 'Граф статьи: Беллман — Форд',
      ok: bf.cost === 20 && nm(bf.path.vertices) === 'A–C–F–E' && bfAll === '0,7,9,20,20,11' && !bf.negativeCycle,
      details: 'путь ' + nm(bf.path.vertices) + ', L = ' + bf.cost + ', d = [' + bfAll + '], проходов: ' + bf.passes,
    });
    const fw = A.floydWarshall(g);
    out.push({
      name: 'Граф статьи: Флойд — Уоршелл',
      ok: fw.D[0 * 6 + 4] === 20 && nm(fw.pathTo(0, 4)) === 'A–C–F–E',
      details: 'путь ' + nm(fw.pathTo(0, 4)) + ', D[A][E] = ' + fw.D[4],
    });
    return out;
  }

  /* ---------- Отрицательный вес → исключение ---------- */
  function checkNegative() {
    let msg = null;
    try {
      G.Graph.fromEdgeList(3, [[0, 1, 5], [1, 2, -1]]);
    } catch (e) {
      msg = e.message;
    }
    return {
      name: 'Отрицательный вес при построении → исключение',
      ok: !!msg && /w\(e\) ≥ 0/.test(msg),
      details: msg ? 'исключение: «' + msg + '»' : 'исключение НЕ возникло',
    };
  }

  /* ---------- Синтетический «OSM» для проверки упрощения ---------- */
  function syntheticOsm(seed) {
    const r = geo.rng(seed);
    const K = 9;
    const elements = [];
    let nid = 1, wid = 1;
    const node = (lat, lon) => {
      elements.push({ type: 'node', id: nid, lat, lon });
      return nid++;
    };
    const grid = [];
    for (let i = 0; i < K; i++) {
      grid.push([]);
      for (let j = 0; j < K; j++) grid[i].push(node(53.9 + i * 0.003 + (r() - 0.5) * 4e-4, 27.5 + j * 0.005 + (r() - 0.5) * 4e-4));
    }
    const classes = ['primary', 'secondary', 'tertiary', 'residential', 'living_street'];
    const street = (p, q) => {
      if (r() < 0.12) return; // часть улиц отсутствует
      const a = elements[p - 1], b = elements[q - 1];
      const mid = 1 + Math.floor(r() * 4);
      const ids = [p];
      for (let k = 1; k <= mid; k++) {
        const f = k / (mid + 1);
        ids.push(node(a.lat + (b.lat - a.lat) * f + (r() - 0.5) * 2e-4, a.lon + (b.lon - a.lon) * f + (r() - 0.5) * 2e-4));
      }
      ids.push(q);
      const tags = { highway: classes[Math.floor(r() * classes.length)] };
      const x = r();
      if (x < 0.2) tags.oneway = 'yes';
      else if (x < 0.27) tags.oneway = '-1';
      if (r() < 0.3) tags.maxspeed = String(20 + 10 * Math.floor(r() * 6));
      if (r() < 0.05) tags.access = 'private';
      // иногда улица разрезана на две линии OSM с одинаковыми свойствами
      if (ids.length > 3 && r() < 0.4) {
        const c = 1 + Math.floor(r() * (ids.length - 2));
        elements.push({ type: 'way', id: wid++, nodes: ids.slice(0, c + 1), tags });
        elements.push({ type: 'way', id: wid++, nodes: ids.slice(c), tags: Object.assign({}, tags) });
      } else {
        elements.push({ type: 'way', id: wid++, nodes: ids, tags });
      }
    };
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
      if (j + 1 < K) street(grid[i][j], grid[i][j + 1]);
      if (i + 1 < K) street(grid[i][j], grid[i + 1][j]);
    }
    return { elements };
  }

  /**
   * Упрощение не меняет длин кратчайших путей: сравниваем d(s,t) на графе до и после
   * сжатия цепочек для одних и тех же вершин (по OSM id), по обоим критериям.
   */
  function checkSimplification(osm, pairs, seed, label) {
    const o = { scc: false, roundWeights: false };
    const raw = G.Graph.fromCompact(G.buildFromOverpass(osm, Object.assign({ simplify: false }, o)));
    const simp = G.Graph.fromCompact(G.buildFromOverpass(osm, Object.assign({ simplify: true }, o)));
    const rawIdx = new Map();
    raw.osmId.forEach((id, i) => rawIdx.set(id, i));
    const r = geo.rng(seed);
    let ok = 0, total = 0, reach = 0;
    for (let k = 0; k < pairs; k++) {
      const s = geo.randInt(r, simp.n), t = geo.randInt(r, simp.n);
      const rs = rawIdx.get(simp.osmId[s]), rt = rawIdx.get(simp.osmId[t]);
      for (const w of ['dist', 'time']) {
        const a = A.dijkstra(simp, s, t, { weight: w }).cost;
        const b = A.dijkstra(raw, rs, rt, { weight: w }).cost;
        total++;
        if (isFinite(a)) reach++;
        if (same(a, b)) ok++;
      }
    }
    return {
      name: 'Упрощение не меняет расстояний' + (label ? ' (' + label + ')' : ''),
      ok: ok === total && rawIdx.size > 0,
      details:
        '|V| до = ' + raw.n + ', после = ' + simp.n + ' (|E| ' + raw.m + ' → ' + simp.m + '); ' +
        pairs + ' пар × 2 критерия: совпало ' + ok + ' из ' + total + ' (достижимых ' + reach + ')',
    };
  }

  /* ---------- Взаимная сверка алгоритмов на случайных парах ---------- */
  async function checkMutual(g, opts) {
    const r = geo.rng(opts.seed || 777);
    const pairs = opts.pairs || 50, bfPairs = opts.bfPairs || 0;
    let ok = 0, total = 0, pathOk = 0, astarOk = 0, bfOk = 0, bfTotal = 0, astarTotal = 0;
    let maxRatio = 0;
    const fails = [];
    for (let k = 0; k < pairs; k++) {
      const s = geo.randInt(r, g.n), t = geo.randInt(r, g.n);
      for (const w of ['dist', 'time']) {
        const d = A.dijkstra(g, s, t, { weight: w });
        const a = A.astar(g, s, t, { weight: w });
        const b = A.bidirectional(g, s, t, { weight: w });
        total++;
        if (same(d.cost, a.cost) && same(d.cost, b.cost)) ok++;
        else fails.push(s + '→' + t + ' (' + w + '): D=' + d.cost + ' A*=' + a.cost + ' Bi=' + b.cost);
        // сумма весов восстановленного пути = d(t)
        const pc = [d, a, b].every((x) => !x.found || same(A.pathCost(g, x.path.edges, w), x.cost));
        const pv = [d, a, b].every((x) => !x.found || (x.path.vertices[0] === s && x.path.vertices[x.path.vertices.length - 1] === t));
        if (pc && pv) pathOk++;
        astarTotal++;
        if (a.settled <= d.settled) astarOk++;
        if (d.settled > 0) maxRatio = Math.max(maxRatio, a.settled / d.settled);
        if (k < bfPairs) {
          bfTotal++;
          const bf = A.bellmanFord(g, s, t, { weight: w });
          if (same(bf.cost, d.cost)) bfOk++;
        }
      }
      if (opts.onProgress) opts.onProgress(k + 1, pairs);
      if (k % 5 === 4) await tick();
    }
    const res = [
      {
        name: 'Взаимная сверка: Дейкстра = A* = двунаправленная',
        ok: ok === total,
        details: pairs + ' пар × 2 критерия: совпало ' + ok + ' из ' + total + (fails.length ? '; расхождения: ' + fails.slice(0, 3).join('; ') : ''),
      },
      {
        name: 'Сумма весов найденного пути = d(t)',
        ok: pathOk === total,
        details: 'верно для ' + pathOk + ' из ' + total + ' запусков (по 3 алгоритма)',
      },
      {
        name: 'Свойство A*: settled(A*) ≤ settled(Дейкстра)',
        ok: astarOk === astarTotal,
        details: 'выполнено для ' + astarOk + ' из ' + astarTotal + '; max отношение = ' + maxRatio.toFixed(3),
      },
    ];
    if (bfTotal) {
      res.push({
        name: 'Взаимная сверка: Беллман — Форд = Дейкстра',
        ok: bfOk === bfTotal,
        details: 'совпало ' + bfOk + ' из ' + bfTotal,
      });
    }
    return res;
  }

  /** Сверка с эталоном NetworkX (data/reference.js). */
  async function checkReference(g, ref, onProgress) {
    let ok = 0, total = 0;
    const fails = [];
    for (let i = 0; i < ref.length; i++) {
      const p = ref[i];
      for (const w of ['dist', 'time']) {
        const c = A.dijkstra(g, p.s, p.t, { weight: w }).cost;
        const c2 = A.astar(g, p.s, p.t, { weight: w }).cost;
        total++;
        if (same(c, p[w]) && same(c2, p[w])) ok++;
        else if (fails.length < 3) fails.push(p.s + '→' + p.t + ' ' + w + ': наш ' + c + ', NetworkX ' + p[w]);
      }
      if (onProgress) onProgress(i + 1, ref.length);
      if (i % 10 === 9) await tick();
    }
    return {
      name: 'Сверка с NetworkX (dijkstra_path_length)',
      ok: ok === total && total > 0,
      details:
        ref.length + ' пар × 2 критерия: совпало ' + ok + ' из ' + total + ' (' +
        ((100 * ok) / Math.max(1, total)).toFixed(1) + ' %), точность 1e-9; Дейкстра и A*' +
        (fails.length ? '; расхождения: ' + fails.join('; ') : ''),
    };
  }

  /** Флойд — Уоршелл на подграфе (≤ maxN вершин в радиусе radius м) = Дейкстра на том же подграфе. */
  function fwSubgraph(g, center, radius, maxN) {
    const near = [];
    for (let v = 0; v < g.n; v++) {
      const d = geo.haversine(g.lat[center], g.lon[center], g.lat[v], g.lon[v]);
      if (d <= radius) near.push([d, v]);
    }
    near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const keep = near.slice(0, maxN).map((x) => x[1]).sort((a, b) => a - b);
    const sub = g.induced(keep).graph;
    return sub;
  }

  function checkFloydSubgraph(g, center, weight) {
    const sub = fwSubgraph(g, center, 500, 400);
    const t0 = now();
    const fw = A.floydWarshall(sub, { weight });
    const ms = now() - t0;
    let ok = 0, total = 0;
    for (let s = 0; s < sub.n; s++) {
      const d = A.dijkstra(sub, s, -1, { weight });
      for (let t = 0; t < sub.n; t++) {
        total++;
        if (same(fw.D[s * sub.n + t], d.dist[t])) ok++;
      }
    }
    return {
      sub, fw, ms, ok, total,
      check: {
        name: 'Флойд — Уоршелл на подграфе = Дейкстра',
        ok: ok === total,
        details: 'подграф: ' + sub.n + ' вершин, ' + sub.m + ' дуг (r = 500 м); ' + sub.n + '² = ' + total +
          ' пар: совпало ' + ok + '; время ФУ ' + ms.toFixed(1) + ' мс, ' + sub.n + '³ = ' + fw.ops.toLocaleString('ru-RU') + ' операций',
      },
    };
  }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Полный прогон.
   * opts: { reference, rawOsm, pairs, bfPairs, onProgress(text), onCheck(check) }
   */
  async function run(g, opts) {
    opts = opts || {};
    const checks = [];
    const add = (c) => { checks.push(c); if (opts.onCheck) opts.onCheck(c); };
    const prog = (t) => opts.onProgress && opts.onProgress(t);

    prog('Граф статьи…');
    checkPaper().forEach(add);
    add(checkNegative());
    await tick();

    prog('Упрощение (синтетическая сеть)…');
    add(checkSimplification(syntheticOsm(42), 150, 1, 'синтетическая сеть'));
    await tick();
    if (opts.rawOsm) {
      prog('Упрощение (реальный ответ Overpass)…');
      add(checkSimplification(opts.rawOsm, opts.simplPairs || 100, 2, 'граф Минска, 100 пар'));
      await tick();
    }

    if (g) {
      if (opts.reference && opts.reference.length && (!g.meta || !g.meta.induced)) {
        prog('Сверка с NetworkX…');
        add(await checkReference(g, opts.reference, (i, n) => prog('Сверка с NetworkX: ' + i + ' / ' + n)));
      } else {
        add({ name: 'Сверка с NetworkX', ok: null, details: 'эталон не загружен или граф отличается от снимка — пропущено' });
      }
      prog('Взаимная сверка алгоритмов…');
      (await checkMutual(g, {
        pairs: opts.pairs || 50, bfPairs: opts.bfPairs || 0, seed: 12345,
        onProgress: (i, n) => prog('Взаимная сверка: ' + i + ' / ' + n),
      })).forEach(add);
      prog('Флойд — Уоршелл на подграфе…');
      await tick();
      add(checkFloydSubgraph(g, geo.randInt(geo.rng(99), g.n), 'dist').check);
    }
    const failed = checks.filter((c) => c.ok === false).length;
    return { checks, allOk: failed === 0, failed };
  }

  const selftest = {
    run, same, paperGraph, PAPER_NAMES, PAPER_EDGES, checkPaper, checkNegative,
    checkSimplification, checkMutual, checkReference, checkFloydSubgraph, fwSubgraph, syntheticOsm,
  };
  GP.selftest = selftest;
  if (isNode) module.exports = selftest;
})(typeof window !== 'undefined' ? window : globalThis);

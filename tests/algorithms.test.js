/*
 * GeoPath — тесты из командной строки:   node tests/algorithms.test.js
 *
 * 1) граф из статьи (A–C–F–E = 20, порядок обработки), отрицательный вес → исключение;
 * 2) случайные графы: Дейкстра = A* = двунаправленная = Беллман—Форд = Флойд—Уоршелл;
 * 3) упрощение не меняет расстояний (синтетическая сеть и реальный ответ Overpass);
 * 4) граф Минска: сверка с NetworkX, взаимная сверка, свойства A*, ФУ на подграфе;
 * 5) Python- и JS-построители дают одинаковые |V|, |E| на одном ответе Overpass.
 * Код завершения ≠ 0 при любой ошибке.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/config.js'));
const geo = require(path.join(ROOT, 'js/geo.js'));
const G = require(path.join(ROOT, 'js/graph.js'));
const A = require(path.join(ROOT, 'js/algorithms.js'));
const T = require(path.join(ROOT, 'js/selftest.js'));

let failed = 0, passed = 0, skipped = 0;
function report(c) {
  const mark = c.ok === null ? 'ПРОПУСК' : c.ok ? '  OK   ' : 'ОШИБКА ';
  if (c.ok === null) skipped++; else if (c.ok) passed++; else failed++;
  console.log('[' + mark + '] ' + c.name + (c.details ? '\n            ' + c.details : ''));
}

/** Загрузка data/*.js (window.X = ...) без браузера. */
function loadDataJs(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}

/** Случайный граф с координатами: веса ≥ расстояния по прямой (эвристика A* допустима). */
function randomGraph(seed, n, m) {
  const r = geo.rng(seed);
  const lat = [], lon = [];
  for (let i = 0; i < n; i++) { lat.push(53.85 + r() * 0.1); lon.push(27.45 + r() * 0.2); }
  const from = [], to = [], dist = [], time = [];
  for (let k = 0; k < m; k++) {
    const u = geo.randInt(r, n), v = geo.randInt(r, n);
    if (u === v) continue;
    const d = geo.haversine(lat[u], lon[u], lat[v], lon[v]) * (1 + r() * 0.5);
    from.push(u); to.push(v); dist.push(d); time.push(d / (5 + r() * 20));
  }
  return new G.Graph({ n, lat, lon, from, to, dist, time });
}

async function main() {
  const t0 = Date.now();
  console.log('=== 1. Граф из статьи (рисунок 1, таблица 2) ===');
  T.checkPaper().forEach(report);
  report(T.checkNegative());

  console.log('\n=== 2. Случайные графы ===');
  {
    let ok = 0, total = 0, astarOk = 0, fwOk = 0, fwTotal = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = randomGraph(seed, 60, 240);
      const fw = { dist: A.floydWarshall(g, { weight: 'dist' }), time: A.floydWarshall(g, { weight: 'time' }) };
      const r = geo.rng(seed * 31);
      for (let k = 0; k < 15; k++) {
        const s = geo.randInt(r, g.n), t = geo.randInt(r, g.n);
        for (const w of ['dist', 'time']) {
          const d = A.dijkstra(g, s, t, { weight: w });
          const a = A.astar(g, s, t, { weight: w });
          const b = A.bidirectional(g, s, t, { weight: w });
          const bf = A.bellmanFord(g, s, t, { weight: w });
          total++;
          if ([a, b, bf].every((x) => T.same(x.cost, d.cost))) ok++;
          if (a.settled <= d.settled) astarOk++;
          fwTotal++;
          if (T.same(fw[w].D[s * g.n + t], d.cost)) fwOk++;
        }
      }
    }
    report({ name: 'Дейкстра = A* = двунаправленная = Беллман—Форд (40 графов × 15 пар × 2 критерия)', ok: ok === total, details: 'совпало ' + ok + ' из ' + total });
    report({ name: 'Флойд — Уоршелл = Дейкстра на случайных графах', ok: fwOk === fwTotal, details: 'совпало ' + fwOk + ' из ' + fwTotal });
    report({ name: 'settled(A*) ≤ settled(Дейкстра) на случайных графах', ok: astarOk === total, details: astarOk + ' из ' + total });
    // недостижимая вершина и одинаковые точки
    const g = G.Graph.fromEdgeList(4, [[0, 1, 1], [1, 2, 1]]);
    const un = [A.dijkstra(g, 0, 3), A.astar(g, 0, 3), A.bidirectional(g, 0, 3), A.bellmanFord(g, 0, 3)];
    report({ name: '«Маршрут не найден» для недостижимой вершины', ok: un.every((x) => !x.found && x.cost === Infinity), details: 'все 4 алгоритма вернули found = false' });
    const eq = [A.dijkstra(g, 1, 1), A.astar(g, 1, 1), A.bidirectional(g, 1, 1), A.bellmanFord(g, 1, 1)];
    report({ name: 'Одинаковые точки s = t → L = 0', ok: eq.every((x) => x.found && x.cost === 0 && x.path.vertices.length === 1), details: 'все 4 алгоритма вернули L = 0' });
    // отрицательный цикл обнаруживается (графом с w<0 конструктор не пропустит — проверяем сам BF на «ручном» графе)
    const ng = G.Graph.fromEdgeList(3, [[0, 1, 1], [1, 2, 1], [2, 0, 1]]);
    ng.wDist[2] = -5; // обходим проверку конструктора только для этого теста
    const nbf = A.bellmanFord(ng, 0, 2);
    report({ name: 'Беллман — Форд обнаруживает отрицательный цикл', ok: nbf.negativeCycle === true, details: 'negativeCycle = ' + nbf.negativeCycle });
  }

  console.log('\n=== 3. Упрощение графа ===');
  report(T.checkSimplification(T.syntheticOsm(42), 150, 1, 'синтетическая сеть'));
  report(T.checkSimplification(T.syntheticOsm(7), 150, 3, 'синтетическая сеть №2'));
  const rawPath = path.join(ROOT, 'data/raw/overpass_minsk.json');
  let rawOsm = null;
  if (fs.existsSync(rawPath)) {
    rawOsm = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    report(T.checkSimplification(rawOsm, 100, 2, 'граф Минска, 100 пар'));
  } else {
    report({ name: 'Упрощение на реальном ответе Overpass', ok: null, details: 'нет data/raw/overpass_minsk.json' });
  }

  console.log('\n=== 4. Граф Минска ===');
  const data = loadDataJs('data/minsk-graph.js');
  const refw = loadDataJs('data/reference.js');
  if (!data || !data.MINSK_GRAPH) {
    report({ name: 'Граф Минска', ok: null, details: 'нет data/minsk-graph.js — запустите tools/build_graph.py' });
  } else {
    const tb = Date.now();
    const g = G.Graph.fromCompact(data.MINSK_GRAPH);
    const meta = g.meta;
    console.log('  Снимок OSM: ' + meta.date + '; |V| сырой = ' + meta.vRaw + ', после упрощения = ' + meta.vSimple +
      ', SCC = ' + meta.v + '; |E| = ' + meta.e + '; CSR построен за ' + (Date.now() - tb) + ' мс; v_max = ' + (g.vMax * 3.6).toFixed(1) + ' км/ч');
    if (refw && refw.REFERENCE) {
      report(await T.checkReference(g, refw.REFERENCE));
    } else {
      report({ name: 'Сверка с NetworkX', ok: null, details: 'нет data/reference.js — запустите tools/make_reference.py' });
    }
    (await T.checkMutual(g, { pairs: 100, bfPairs: 5, seed: 12345 })).forEach(report);
    report(T.checkFloydSubgraph(g, geo.randInt(geo.rng(99), g.n), 'dist').check);
    report(T.checkFloydSubgraph(g, geo.randInt(geo.rng(98), g.n), 'time').check);

    if (rawOsm) {
      const jsBuilt = G.buildFromOverpass(rawOsm).meta;
      const keys = ['vRaw', 'eRaw', 'vSimple', 'eSimple', 'v', 'e'];
      const diff = keys.filter((k) => jsBuilt[k] !== meta[k]);
      report({
        name: 'Python- и JS-построители дают одинаковый граф',
        ok: diff.length === 0,
        details: keys.map((k) => k + ': py ' + meta[k] + ' / js ' + jsBuilt[k]).join(', '),
      });
    }
  }

  console.log('\n----------------------------------------');
  console.log('Пройдено: ' + passed + ', ошибок: ' + failed + ', пропущено: ' + skipped + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' с)');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

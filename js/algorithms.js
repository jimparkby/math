/*
 * GeoPath — алгоритмы поиска кратчайшего пути (собственная реализация, без библиотек).
 *
 * Задача: для пути P = (e₁, …, e_k) из s в t
 *     L(P) = Σ w(eᵢ)  →  min,         P* = argmin L(P).
 *
 * Во всех алгоритмах ведутся счётчики:
 *   settled     — обработанные вершины (извлечены из очереди окончательно);
 *   relaxations — просмотренные дуги (проверки d(u) + w(u,v) < d(v));
 *   heapOps     — операции с кучей (push + pop).
 * Путь восстанавливается по массиву предшественников prev[] (номер дуги в CSR).
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});
  const isNode = typeof module !== 'undefined' && module.exports;
  const geo = GP.geo || (isNode ? require('./geo.js') : null);
  const MinHeap = GP.MinHeap || (isNode ? require('./heap.js').MinHeap : null);

  /** Коэффициент запаса эвристики: компенсирует погрешность округления IEEE-754 (≈1e-16)
   *  и гарантирует строгую допустимость h(v) ≤ h*(v). На оптимальность не влияет. */
  const H_SAFETY = 1 - 1e-9;

  function weights(g, weight) {
    return weight === 'time' ? g.wTime : g.wDist;
  }

  /** Восстановление пути по prevE (позиции дуг в CSR). */
  function buildPath(g, prevE, s, t) {
    const edges = [];
    let v = t;
    while (v !== s) {
      const e = prevE[v];
      if (e < 0) return null;
      edges.push(e);
      v = g.adjFrom[e];
    }
    edges.reverse();
    const vertices = [s];
    for (const e of edges) vertices.push(g.adjTo[e]);
    return { vertices, edges };
  }

  /**
   * Алгоритм Дейкстры и A* — одна функция (Дейкстра = A* при h ≡ 0).
   *
   *   d(s) = 0, d(v) = ∞;  куча ← (h(s), s)
   *   пока куча не пуста:
   *       u ← извлечь минимум f = d + h; если done[u] — пропустить (ленивое удаление)
   *       done[u] ← 1; если u = t — стоп (ранняя остановка для пары s–t)
   *       для каждой дуги (u,v): d(v) ← min(d(v), d(u) + w(u,v))      — релаксация, формула (2) статьи
   *
   * Эвристика A* (географическая):
   *   «расстояние»: h(v) = hav(v, t)                — дорога не короче дуги большого круга;
   *   «время»:      h(v) = hav(v, t) / v_max        — ехать быстрее v_max нельзя.
   * Значит h допустима (h ≤ истинной оставшейся стоимости) → A* находит оптимум.
   * h согласована: h(u) ≤ w(u,v) + h(v) (неравенство треугольника для дуг большого круга),
   * поэтому каждая вершина обрабатывается не более одного раза, и множество обработанных
   * A* вершин — подмножество обработанных алгоритмом Дейкстры.
   * Сложность (двоичная куча): O((|V| + |E|) log |V|).
   *
   * @param {Graph} g
   * @param {number} s источник
   * @param {number} t цель (−1 — дерево кратчайших путей до всех вершин)
   * @param {object} [opt] { weight: 'dist'|'time', astar: bool, record: bool }
   */
  function dijkstra(g, s, t, opt) {
    opt = opt || {};
    const W = weights(g, opt.weight);
    const n = g.n, adjStart = g.adjStart, adjTo = g.adjTo;
    const dist = new Float64Array(n).fill(Infinity);
    const prevE = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const heap = new MinHeap(1024);
    const order = opt.record ? [] : null;

    // Эвристика: вычисляется лениво и кэшируется.
    const useH = !!opt.astar && g.hasCoords && t >= 0;
    let hc = null, tl = 0, to = 0, scale = 1;
    if (useH) {
      hc = new Float64Array(n).fill(-1);
      tl = g.lat[t]; to = g.lon[t];
      scale = opt.weight === 'time' ? H_SAFETY / g.vMax : H_SAFETY;
    }
    const h = (v) => {
      if (!useH) return 0;
      let x = hc[v];
      if (x < 0) x = hc[v] = geo.haversine(g.lat[v], g.lon[v], tl, to) * scale;
      return x;
    };

    let settled = 0, relax = 0;
    dist[s] = 0;
    heap.push(h(s), s);
    while (heap.size > 0) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      settled++;
      if (order) order.push(u);
      if (u === t) break;
      const du = dist[u];
      for (let e = adjStart[u], end = adjStart[u + 1]; e < end; e++) {
        relax++;
        const v = adjTo[e];
        const nd = du + W[e];
        if (nd < dist[v]) {
          dist[v] = nd;
          prevE[v] = e;
          heap.push(useH ? nd + h(v) : nd, v);
        }
      }
    }
    const res = {
      algorithm: useH ? 'astar' : 'dijkstra',
      found: t < 0 ? true : dist[t] < Infinity,
      cost: t < 0 ? NaN : dist[t],
      settled, relaxations: relax, heapOps: heap.ops,
      dist, prevE, order,
    };
    if (t >= 0 && res.found) res.path = buildPath(g, prevE, s, t);
    return res;
  }

  function astar(g, s, t, opt) {
    return dijkstra(g, s, t, Object.assign({}, opt, { astar: true }));
  }

  /**
   * Двунаправленный алгоритм Дейкстры.
   * Прямой поиск из s по дугам и обратный из t по обратным дугам (обратный CSR).
   * μ — длина лучшего найденного пути s → x → t; обновляется при каждой релаксации,
   * если вершина достигнута обоими поисками. Остановка: minF + minB ≥ μ
   * (любой ещё не найденный путь не короче суммы минимальных ключей двух очередей).
   */
  function bidirectional(g, s, t, opt) {
    opt = opt || {};
    const W = weights(g, opt.weight);
    const n = g.n;
    const dF = new Float64Array(n).fill(Infinity), dB = new Float64Array(n).fill(Infinity);
    const pF = new Int32Array(n).fill(-1), pB = new Int32Array(n).fill(-1); // позиции дуг в прямом CSR
    const doneF = new Uint8Array(n), doneB = new Uint8Array(n);
    const hF = new MinHeap(1024), hB = new MinHeap(1024);
    const order = opt.record ? [] : null;
    let settled = 0, relax = 0, mu = Infinity, meet = -1;

    dF[s] = 0; dB[t] = 0;
    hF.push(0, s); hB.push(0, t);
    if (s === t) { mu = 0; meet = s; }

    const { adjStart, adjTo, radjStart, radjFrom, rEdge } = g;
    while (true) {
      while (hF.size > 0 && doneF[hF.peekVal()]) hF.pop();
      while (hB.size > 0 && doneB[hB.peekVal()]) hB.pop();
      if (hF.size === 0 || hB.size === 0) break;
      if (hF.peekKey() + hB.peekKey() >= mu) break;

      if (hF.peekKey() <= hB.peekKey()) {
        const u = hF.pop();
        doneF[u] = 1; settled++;
        if (order) order.push(u);
        const du = dF[u];
        for (let e = adjStart[u], end = adjStart[u + 1]; e < end; e++) {
          relax++;
          const v = adjTo[e];
          const nd = du + W[e];
          if (nd < dF[v]) { dF[v] = nd; pF[v] = e; hF.push(nd, v); }
          if (dB[v] < Infinity && dF[v] + dB[v] < mu) { mu = dF[v] + dB[v]; meet = v; }
        }
      } else {
        const u = hB.pop();
        doneB[u] = 1; settled++;
        if (order) order.push(u);
        const du = dB[u];
        for (let j = radjStart[u], end = radjStart[u + 1]; j < end; j++) {
          relax++;
          const v = radjFrom[j];
          const e = rEdge[j];
          const nd = du + W[e];
          if (nd < dB[v]) { dB[v] = nd; pB[v] = e; hB.push(nd, v); }
          if (dF[v] < Infinity && dF[v] + dB[v] < mu) { mu = dF[v] + dB[v]; meet = v; }
        }
      }
    }

    const res = {
      algorithm: 'bidirectional',
      found: mu < Infinity,
      cost: mu,
      settled, relaxations: relax, heapOps: hF.ops + hB.ops,
      order, meet,
    };
    if (res.found) {
      const edges = [];
      let v = meet;
      while (v !== s) { const e = pF[v]; edges.push(e); v = g.adjFrom[e]; }
      edges.reverse();
      v = meet;
      while (v !== t) { const e = pB[v]; edges.push(e); v = g.adjTo[e]; }
      const vertices = [s];
      for (const e of edges) vertices.push(g.adjTo[e]);
      res.path = { vertices, edges };
    }
    return res;
  }

  /**
   * Алгоритм Беллмана — Форда (по шагам, чтобы не «вешать» вкладку).
   * До |V|−1 проходов релаксации всех дуг; досрочный выход, если за проход ничего не изменилось.
   * Если после |V|−1 проходов изменения продолжаются — проверочный проход выявляет
   * отрицательный цикл (в модели весов < 0 нет, но проверка реализована).
   * Сложность O(|V|·|E|).
   */
  class BellmanFord {
    constructor(g, s, opt) {
      opt = opt || {};
      this.g = g; this.s = s;
      this.W = weights(g, opt.weight);
      this.dist = new Float64Array(g.n).fill(Infinity);
      this.prevE = new Int32Array(g.n).fill(-1);
      this.dist[s] = 0;
      this.pass = 0; // номер текущего прохода (1…)
      this.u = 0; // следующая вершина в проходе
      this.changed = false;
      this.relaxations = 0;
      this.done = false;
      this.negativeCycle = false;
      this.checkPass = false;
      this.passes = 0;
    }

    /** Выполнить не более budget просмотров дуг. Возвращает true, когда алгоритм завершён. */
    step(budget) {
      const { g, W, dist, prevE } = this;
      const n = g.n, adjStart = g.adjStart, adjTo = g.adjTo;
      let work = 0;
      while (!this.done && work < budget) {
        if (this.u === 0 && !this.checkPass) this.pass++;
        for (; this.u < n && work < budget; this.u++) {
          const u = this.u;
          const du = dist[u];
          if (du === Infinity) { work++; continue; }
          for (let e = adjStart[u], end = adjStart[u + 1]; e < end; e++) {
            this.relaxations++; work++;
            const v = adjTo[e];
            const nd = du + W[e];
            if (nd < dist[v]) {
              if (this.checkPass) { this.negativeCycle = true; }
              else { dist[v] = nd; prevE[v] = e; this.changed = true; }
            }
          }
        }
        if (this.u === n) {
          this.u = 0;
          if (this.checkPass) { this.done = true; break; }
          this.passes = this.pass;
          if (!this.changed) { this.done = true; break; } // досрочный выход
          this.changed = false;
          if (this.pass >= n - 1) this.checkPass = true; // проход проверки отрицательных циклов
        }
      }
      return this.done;
    }

    result(t) {
      const found = this.dist[t] < Infinity;
      return {
        algorithm: 'bellmanford',
        found, cost: this.dist[t],
        passes: this.passes, relaxations: this.relaxations,
        negativeCycle: this.negativeCycle,
        settled: NaN, heapOps: 0,
        dist: this.dist,
        path: found ? buildPath(this.g, this.prevE, this.s, t) : null,
      };
    }
  }

  function bellmanFord(g, s, t, opt) {
    const bf = new BellmanFord(g, s, opt);
    while (!bf.step(1e7));
    return bf.result(t);
  }

  /**
   * Алгоритм Флойда — Уоршелла: все пары, O(|V|³) операций и |V|²·8 байт памяти.
   *   D⁽ᵏ⁾[i][j] = min( D⁽ᵏ⁻¹⁾[i][j], D⁽ᵏ⁻¹⁾[i][k] + D⁽ᵏ⁻¹⁾[k][j] )
   * На всём графе Минска не запускается — только на небольшом подграфе.
   */
  function floydWarshall(g, opt) {
    opt = opt || {};
    const W = weights(g, opt.weight);
    const n = g.n;
    const D = new Float64Array(n * n).fill(Infinity);
    const next = new Int32Array(n * n).fill(-1);
    for (let i = 0; i < n; i++) { D[i * n + i] = 0; next[i * n + i] = i; }
    for (let e = 0; e < g.m; e++) {
      const u = g.adjFrom[e], v = g.adjTo[e];
      if (W[e] < D[u * n + v]) { D[u * n + v] = W[e]; next[u * n + v] = v; }
    }
    for (let k = 0; k < n; k++) {
      const kn = k * n;
      for (let i = 0; i < n; i++) {
        const dik = D[i * n + k];
        if (dik === Infinity) continue;
        const in_ = i * n;
        for (let j = 0; j < n; j++) {
          const nd = dik + D[kn + j];
          if (nd < D[in_ + j]) { D[in_ + j] = nd; next[in_ + j] = next[in_ + k]; }
        }
      }
    }
    return {
      n, D, next, ops: n * n * n,
      pathTo(i, j) {
        if (next[i * n + j] < 0) return null;
        const p = [i];
        while (i !== j) { i = next[i * n + j]; p.push(i); }
        return p;
      },
    };
  }

  /**
   * Пошаговая трасса алгоритма Дейкстры для учебного примера (таблица 2 статьи):
   * на каждом шаге — выбранная вершина и метки d(v) всех вершин после релаксаций.
   */
  function dijkstraTrace(g, s) {
    const n = g.n;
    const d = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
    d[s] = 0;
    const steps = [{ u: -1, d: d.slice(), done: done.slice(), updated: [s], prev: prev.slice() }];
    for (let it = 0; it < n; it++) {
      let u = -1;
      for (let v = 0; v < n; v++) if (!done[v] && d[v] < Infinity && (u < 0 || d[v] < d[u])) u = v;
      if (u < 0) break;
      done[u] = true;
      const updated = [];
      for (let e = g.adjStart[u]; e < g.adjStart[u + 1]; e++) {
        const v = g.adjTo[e];
        if (d[u] + g.wDist[e] < d[v]) { d[v] = d[u] + g.wDist[e]; prev[v] = u; updated.push(v); }
      }
      steps.push({ u, d: d.slice(), done: done.slice(), updated, prev: prev.slice() });
    }
    return steps;
  }

  /** Сумма весов дуг пути. */
  function pathCost(g, edges, weight) {
    const W = weights(g, weight);
    let c = 0;
    for (const e of edges) c += W[e];
    return c;
  }

  const algorithms = {
    dijkstra, astar, bidirectional, bellmanFord, BellmanFord, floydWarshall,
    dijkstraTrace, pathCost, H_SAFETY,
  };
  GP.algorithms = algorithms;
  if (isNode) module.exports = algorithms;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * GeoPath — математическая модель дорожной сети G = (V, E, w), w : E → ℝ≥0.
 *
 *  • V — перекрёстки, тупики и точки смены свойств дороги;
 *  • E — дуги (участки дорог между соседними вершинами) с учётом направления движения:
 *        двусторонняя улица → две противоположные дуги (u,v) и (v,u), односторонняя → одна;
 *  • w — вес дуги: расстояние (м) или время проезда (с).
 *
 * Хранение — список смежности в формате CSR (Compressed Sparse Row):
 *   adjStart : Int32Array(|V|+1) — исходящие дуги вершины u лежат в [adjStart[u], adjStart[u+1])
 *   adjTo    : Int32Array(|E|),  wDist, wTime : Float64Array(|E|)
 * Память CSR ≈ (|V|+1)·4 + |E|·(4+8+8) байт против |V|²·8 байт у матрицы весов.
 *
 * Построение из ответа Overpass повторяет tools/build_graph.py шаг в шаг
 * (фильтрация → дуги с весами → упрощение → наибольшая SCC), поэтому на одном и том же
 * ответе Overpass оба построителя дают одинаковые |V| и |E| (проверяется тестом).
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});
  const isNode = typeof module !== 'undefined' && module.exports;
  const geo = GP.geo || (isNode ? require('./geo.js') : null);
  const config = GP.config || (isNode ? require('./config.js') : null);

  /* ------------------------------------------------------------------ */
  /*  Класс Graph: CSR + обратный CSR + координаты + геометрия дуг       */
  /* ------------------------------------------------------------------ */

  class Graph {
    /**
     * @param {object} p
     *   n, lat, lon            — вершины (lat/lon могут быть null для абстрактных графов)
     *   from, to, dist, time   — дуги (массивы одинаковой длины m)
     *   geomOffsets, geomCoords — промежуточные точки геометрии дуг (необязательно)
     *   names                  — подписи вершин (для учебного графа)
     */
    constructor(p) {
      const n = p.n;
      const m = p.from.length;
      this.n = n;
      this.m = m;
      this.meta = p.meta || {};
      this.names = p.names || null;
      this.osmId = p.osmId || null;
      this.hasCoords = !!(p.lat && p.lon);
      this.lat = Float64Array.from(p.lat || new Array(n).fill(0));
      this.lon = Float64Array.from(p.lon || new Array(n).fill(0));

      // Проверка условия применимости алгоритма Дейкстры: все веса неотрицательны.
      for (let i = 0; i < m; i++) {
        const d = p.dist[i], t = p.time[i];
        if (!(d >= 0) || !(t >= 0) || !isFinite(d) || !isFinite(t)) {
          throw new Error(
            'Недопустимый вес дуги ' + p.from[i] + '→' + p.to[i] + ' (расстояние = ' + d +
            ', время = ' + t + '): модель требует w(e) ≥ 0 — условие применимости алгоритма Дейкстры.'
          );
        }
        if (p.from[i] < 0 || p.from[i] >= n || p.to[i] < 0 || p.to[i] >= n) {
          throw new Error('Дуга ' + i + ' ссылается на несуществующую вершину.');
        }
      }
      this.allNonNegative = true;

      // --- прямой CSR (сортировка подсчётом по начальной вершине, устойчивая) ---
      const adjStart = new Int32Array(n + 1);
      for (let i = 0; i < m; i++) adjStart[p.from[i] + 1]++;
      for (let u = 0; u < n; u++) adjStart[u + 1] += adjStart[u];
      const fill = adjStart.slice(0, n);
      const adjTo = new Int32Array(m), wDist = new Float64Array(m), wTime = new Float64Array(m);
      const edgeId = new Int32Array(m), adjFrom = new Int32Array(m);
      for (let i = 0; i < m; i++) {
        const u = p.from[i];
        const k = fill[u]++;
        adjTo[k] = p.to[i];
        adjFrom[k] = u;
        wDist[k] = p.dist[i];
        wTime[k] = p.time[i];
        edgeId[k] = i; // номер дуги в исходных массивах (для геометрии)
      }
      this.adjStart = adjStart;
      this.adjTo = adjTo;
      this.adjFrom = adjFrom;
      this.wDist = wDist;
      this.wTime = wTime;
      this.edgeId = edgeId;

      // --- обратный CSR (входящие дуги) — для двунаправленного поиска ---
      const radjStart = new Int32Array(n + 1);
      for (let k = 0; k < m; k++) radjStart[adjTo[k] + 1]++;
      for (let v = 0; v < n; v++) radjStart[v + 1] += radjStart[v];
      const rfill = radjStart.slice(0, n);
      const radjFrom = new Int32Array(m), rEdge = new Int32Array(m);
      for (let k = 0; k < m; k++) {
        const v = adjTo[k];
        const j = rfill[v]++;
        radjFrom[j] = adjFrom[k];
        rEdge[j] = k; // позиция той же дуги в прямом CSR
      }
      this.radjStart = radjStart;
      this.radjFrom = radjFrom;
      this.rEdge = rEdge;

      // Максимальная скорость среди дуг v_max = max d(e)/t(e) — для эвристики A* по времени.
      let vMax = 0;
      for (let k = 0; k < m; k++) {
        if (wTime[k] > 0) {
          const s = wDist[k] / wTime[k];
          if (s > vMax) vMax = s;
        }
      }
      this.vMax = vMax;

      this.geomOffsets = p.geomOffsets || null;
      this.geomCoords = p.geomCoords || null;
    }

    /** Оценка памяти: CSR против матрицы весов (байты). */
    memory() {
      return {
        csr: (this.n + 1) * 4 + this.m * (4 + 8 + 8),
        matrix: this.n * this.n * 8,
      };
    }

    /** Координаты дуги (позиция в CSR) для отрисовки: [[lon,lat], ...]. */
    edgeCoords(k) {
      const u = this.adjFrom[k], v = this.adjTo[k];
      const out = [[this.lon[u], this.lat[u]]];
      if (this.geomOffsets) {
        const id = this.edgeId[k];
        const a = this.geomOffsets[id], b = this.geomOffsets[id + 1];
        const c = this.geomCoords;
        for (let i = a; i < b; i += 2) out.push([c[i] / 1e6, c[i + 1] / 1e6]);
      }
      out.push([this.lon[v], this.lat[v]]);
      return out;
    }

    /**
     * Ближайшая вершина графа к точке (lat, lon).
     * Используется локальная равнопромежуточная проекция: Δx = Δλ·cos φ, Δy = Δφ.
     * Граф уже содержит только наибольшую компоненту сильной связности.
     */
    nearestVertex(lat, lon) {
      const c = Math.cos((lat * Math.PI) / 180);
      let best = -1, bd = Infinity;
      const LA = this.lat, LO = this.lon;
      for (let i = 0; i < this.n; i++) {
        const dy = LA[i] - lat, dx = (LO[i] - lon) * c;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) return null;
      return { v: best, dist: geo.haversine(lat, lon, LA[best], LO[best]) };
    }

    /**
     * Индуцированный подграф на множестве вершин keep (массив номеров).
     * Возвращает { graph, map } — map[старый] = новый (или −1).
     */
    induced(keep) {
      const map = new Int32Array(this.n).fill(-1);
      keep.forEach((v, i) => (map[v] = i));
      const from = [], to = [], dist = [], time = [], gOff = [0], gC = [];
      for (let k = 0; k < this.m; k++) {
        const a = map[this.adjFrom[k]], b = map[this.adjTo[k]];
        if (a < 0 || b < 0) continue;
        from.push(a); to.push(b); dist.push(this.wDist[k]); time.push(this.wTime[k]);
        if (this.geomOffsets) {
          const id = this.edgeId[k];
          for (let i = this.geomOffsets[id]; i < this.geomOffsets[id + 1]; i++) gC.push(this.geomCoords[i]);
          gOff.push(gC.length);
        }
      }
      const g = new Graph({
        n: keep.length,
        lat: this.hasCoords ? keep.map((v) => this.lat[v]) : null,
        lon: this.hasCoords ? keep.map((v) => this.lon[v]) : null,
        names: this.names ? keep.map((v) => this.names[v]) : null,
        from, to, dist, time,
        geomOffsets: this.geomOffsets ? gOff : null,
        geomCoords: this.geomOffsets ? gC : null,
        meta: { induced: true },
      });
      return { graph: g, map };
    }

    /** Граф из компактного представления (формат data/minsk-graph.js). */
    static fromCompact(data) {
      const e = data.edges;
      return new Graph({
        n: data.lat.length,
        lat: data.lat,
        lon: data.lon,
        osmId: data.osmId || null,
        from: e.from, to: e.to, dist: e.dist, time: e.time,
        geomOffsets: e.geomOffsets ? Int32Array.from(e.geomOffsets) : null,
        geomCoords: e.geomCoords ? Int32Array.from(e.geomCoords) : null,
        meta: data.meta || {},
      });
    }

    /**
     * Граф по списку рёбер [[u, v, w], ...] (для тестов и учебного примера).
     * undirected = true → каждое ребро даёт две противоположные дуги.
     */
    static fromEdgeList(n, list, opts) {
      opts = opts || {};
      const from = [], to = [], w = [];
      for (const [u, v, x] of list) {
        from.push(u); to.push(v); w.push(x);
        if (opts.undirected) { from.push(v); to.push(u); w.push(x); }
      }
      return new Graph({
        n, from, to, dist: w, time: opts.time || w.slice(),
        lat: opts.lat || null, lon: opts.lon || null, names: opts.names || null,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Компоненты сильной связности: алгоритм Тарьяна (итеративный)       */
  /* ------------------------------------------------------------------ */

  /**
   * Тарьян без рекурсии (на графе Минска рекурсия переполнила бы стек вызовов).
   * @returns {{comp: Int32Array, count: number}}
   */
  function tarjanSCC(n, adjStart, adjTo) {
    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const stack = new Int32Array(n);
    const cs = new Int32Array(n); // стек «вызовов»
    const ep = new Int32Array(n); // указатель на следующую дугу вершины в стеке вызовов
    const comp = new Int32Array(n).fill(-1);
    let sp = 0, csp = 0, idx = 0, count = 0;
    for (let s = 0; s < n; s++) {
      if (index[s] !== -1) continue;
      index[s] = low[s] = idx++;
      stack[sp++] = s; onStack[s] = 1;
      cs[csp] = s; ep[csp] = adjStart[s]; csp++;
      while (csp > 0) {
        const v = cs[csp - 1];
        const p = ep[csp - 1];
        if (p < adjStart[v + 1]) {
          ep[csp - 1]++;
          const w = adjTo[p];
          if (index[w] === -1) {
            index[w] = low[w] = idx++;
            stack[sp++] = w; onStack[w] = 1;
            cs[csp] = w; ep[csp] = adjStart[w]; csp++;
          } else if (onStack[w] && index[w] < low[v]) {
            low[v] = index[w];
          }
        } else {
          if (low[v] === index[v]) {
            let w;
            do {
              w = stack[--sp];
              onStack[w] = 0;
              comp[w] = count;
            } while (w !== v);
            count++;
          }
          csp--;
          if (csp > 0) {
            const u = cs[csp - 1];
            if (low[v] < low[u]) low[u] = low[v];
          }
        }
      }
    }
    return { comp, count };
  }

  /** CSR по массивам дуг (для SCC при построении). */
  function csrOf(n, from, to) {
    const start = new Int32Array(n + 1);
    for (let i = 0; i < from.length; i++) start[from[i] + 1]++;
    for (let u = 0; u < n; u++) start[u + 1] += start[u];
    const fill = start.slice(0, n);
    const adj = new Int32Array(from.length);
    for (let i = 0; i < from.length; i++) adj[fill[from[i]]++] = to[i];
    return { start, adj };
  }

  /** Номер наибольшей компоненты и её размер. */
  function largestComponent(comp, count) {
    const size = new Int32Array(count);
    for (let i = 0; i < comp.length; i++) size[comp[i]]++;
    let best = 0;
    for (let c = 1; c < count; c++) if (size[c] > size[best]) best = c;
    return { id: best, size: count ? size[best] : 0 };
  }

  /* ------------------------------------------------------------------ */
  /*  Построение графа из ответа Overpass (повторяет build_graph.py)      */
  /* ------------------------------------------------------------------ */

  const ceil3 = (x) => Math.ceil(x * 1000) / 1000; // округление ВВЕРХ до 1 мм
  const ceil4 = (x) => Math.ceil(x * 10000) / 10000; // округление ВВЕРХ до 0,1 мс

  /** Скорость (км/ч) по тегам линии: maxspeed (≤ 110) или типовая по классу. */
  function waySpeed(tags) {
    const ms = tags.maxspeed;
    if (typeof ms === 'string') {
      const m = /^\s*(\d+(?:\.\d+)?)/.exec(ms);
      if (m) {
        let v = parseFloat(m[1]);
        if (/mph/i.test(ms)) v *= 1.609344;
        if (v > 0) return Math.min(v, config.MAX_SPEED_KMH);
      }
    }
    return config.SPEEDS[tags.highway];
  }

  /** Направление: +1 — только по линии, −1 — только против, 0 — в обе стороны (п. 2.2). */
  function wayDirection(tags) {
    const ow = tags.oneway;
    if (ow === 'yes' || ow === '1' || ow === 'true') return 1;
    if (ow === '-1' || ow === 'reverse') return -1;
    if (ow === 'no') return 0;
    const j = tags.junction;
    if (j === 'roundabout' || j === 'circular' || tags.highway === 'motorway') return 1;
    return 0;
  }

  /** Входит ли линия в граф (п. 2.2). */
  function wayAccepted(tags, hwSet) {
    if (!tags || !hwSet.has(tags.highway)) return false;
    if (tags.access === 'no' || tags.access === 'private') return false;
    if (tags.motor_vehicle === 'no' || tags.motor_vehicle === 'private') return false;
    if (tags.area === 'yes') return false;
    return true;
  }

  /**
   * Ответ Overpass → компактный граф (тот же формат, что data/minsk-graph.js).
   * opts.simplify (true)     — сжатие цепочек (п. 2.4);
   * opts.scc (true)          — оставить наибольшую компоненту сильной связности (п. 2.6);
   * opts.roundWeights (true) — округлять веса ВВЕРХ до 1 мм / 0,1 мс (уменьшает файл и сохраняет
   *                            допустимость эвристики A*: вес дуги ≥ длины по большому кругу).
   */
  function buildFromOverpass(osm, opts) {
    opts = Object.assign({ simplify: true, scc: true, roundWeights: true }, opts || {});
    const hwSet = new Set(config.HIGHWAYS);

    // 1. Узлы (координаты округляются до 6 знаков ДО вычисления длин).
    const nodeLat = new Map(), nodeLon = new Map();
    for (const el of osm.elements) {
      if (el.type === 'node') {
        nodeLat.set(el.id, geo.round6(el.lat));
        nodeLon.set(el.id, geo.round6(el.lon));
      }
    }

    // 2. Отрезки линий: seg = (a, b, dir, speed, dist).
    const segA = [], segB = [], segDir = [], segSpeed = [], segDist = [];
    for (const el of osm.elements) {
      if (el.type !== 'way' || !wayAccepted(el.tags, hwSet)) continue;
      const dir = wayDirection(el.tags);
      const speed = waySpeed(el.tags);
      const nd = el.nodes;
      for (let i = 0; i + 1 < nd.length; i++) {
        const a = nd[i], b = nd[i + 1];
        if (a === b || !nodeLat.has(a) || !nodeLat.has(b)) continue;
        segA.push(a); segB.push(b); segDir.push(dir); segSpeed.push(speed);
        segDist.push(geo.haversine(nodeLat.get(a), nodeLon.get(a), nodeLat.get(b), nodeLon.get(b)));
      }
    }
    const S = segA.length;

    // Инцидентность узлов.
    const inc = new Map();
    for (let s = 0; s < S; s++) {
      for (const x of [segA[s], segB[s]]) {
        let l = inc.get(x);
        if (!l) inc.set(x, (l = []));
        l.push(s);
      }
    }
    const vRaw = inc.size;
    let eRaw = 0;
    for (let s = 0; s < S; s++) eRaw += segDir[s] === 0 ? 2 : 1;

    // 3. Упрощение: сжатие цепочек через «проходные» узлы.
    // Поток отрезка s относительно его конца v: 0 — в обе стороны, +1 — из v, −1 — в v.
    const flowAt = (s, v) => {
      if (segDir[s] === 0) return 0;
      const start = segDir[s] > 0 ? segA[s] : segB[s];
      return start === v ? 1 : -1;
    };
    const other = (s, v) => (segA[s] === v ? segB[s] : segA[s]);
    const nodeIds = Array.from(inc.keys()).sort((x, y) => x - y);
    const removable = new Map();
    for (const v of nodeIds) {
      let r = false;
      if (opts.simplify) {
        const l = inc.get(v);
        if (l.length === 2) {
          const s1 = l[0], s2 = l[1];
          const o1 = other(s1, v), o2 = other(s2, v);
          if (o1 !== o2 && segSpeed[s1] === segSpeed[s2]) {
            const f1 = flowAt(s1, v), f2 = flowAt(s2, v);
            r = (f1 === 0 && f2 === 0) || f1 * f2 === -1;
          }
        }
      }
      removable.set(v, r);
    }

    const used = new Uint8Array(S);
    const chains = []; // {a, b, nodes, dir, speed, dist}
    const walk = (k, s0) => {
      const nodes = [k];
      let cur = k, s = s0, dist = 0, dir = null;
      for (;;) {
        used[s] = 1;
        const o = other(s, cur);
        dist += segDist[s];
        if (dir === null) dir = flowAt(s, cur); // +1: по ходу обхода, −1: против, 0: обе стороны
        nodes.push(o);
        cur = o;
        if (!removable.get(cur)) break;
        const l = inc.get(cur);
        const nxt = l[0] === s ? l[1] : l[0];
        if (used[nxt]) break;
        s = nxt;
      }
      chains.push({ a: k, b: cur, nodes, dir, speed: segSpeed[s0], dist });
    };
    for (const v of nodeIds) {
      if (removable.get(v)) continue;
      for (const s of inc.get(v)) if (!used[s]) walk(v, s);
    }
    // Кольца, целиком состоящие из проходных узлов: первый узел кольца становится вершиной.
    for (const v of nodeIds) {
      if (!removable.get(v)) continue;
      const l = inc.get(v);
      if (l.some((s) => !used[s])) {
        removable.set(v, false);
        for (const s of l) if (!used[s]) walk(v, s);
      }
    }

    // 4. Дуги с весами.
    let arcs = []; // {u, v (osm id), dist, time, geom: [osm ids interior]}
    for (const c of chains) {
      if (c.a === c.b) continue; // петля не влияет на кратчайшие пути
      const vms = c.speed / 3.6;
      const dist = opts.roundWeights ? ceil3(c.dist) : c.dist;
      const time = opts.roundWeights ? ceil4(dist / vms) : c.dist / vms;
      const interior = c.nodes.slice(1, -1);
      if (c.dir >= 0) arcs.push({ u: c.a, v: c.b, dist, time, geom: interior });
      if (c.dir <= 0) arcs.push({ u: c.b, v: c.a, dist, time, geom: interior.slice().reverse() });
    }
    const vertexSet = new Set();
    for (const a of arcs) { vertexSet.add(a.u); vertexSet.add(a.v); }
    const vSimple = vertexSet.size, eSimple = arcs.length;

    // 5. Наибольшая компонента сильной связности.
    let ids = Array.from(vertexSet).sort((x, y) => x - y);
    let sccSize = ids.length, sccCount = 1;
    if (opts.scc && ids.length) {
      const pos = new Map(ids.map((id, i) => [id, i]));
      const { start, adj } = csrOf(ids.length, arcs.map((a) => pos.get(a.u)), arcs.map((a) => pos.get(a.v)));
      const { comp, count } = tarjanSCC(ids.length, start, adj);
      const big = largestComponent(comp, count);
      sccSize = big.size; sccCount = count;
      ids = ids.filter((id, i) => comp[i] === big.id);
      const keep = new Set(ids);
      arcs = arcs.filter((a) => keep.has(a.u) && keep.has(a.v));
    }

    // 6. Нумерация вершин по возрастанию OSM id, дуги — по (from, to, dist, time).
    const index = new Map(ids.map((id, i) => [id, i]));
    arcs.forEach((a) => { a.fi = index.get(a.u); a.ti = index.get(a.v); });
    arcs.sort((x, y) => x.fi - y.fi || x.ti - y.ti || x.dist - y.dist || x.time - y.time);
    const from = [], to = [], dist = [], time = [], geomOffsets = [0], geomCoords = [];
    for (const a of arcs) {
      from.push(a.fi); to.push(a.ti); dist.push(a.dist); time.push(a.time);
      for (const id of a.geom) {
        geomCoords.push(Math.round(nodeLon.get(id) * 1e6), Math.round(nodeLat.get(id) * 1e6));
      }
      geomOffsets.push(geomCoords.length);
    }
    return {
      meta: {
        date: osm.osm3s && osm.osm3s.timestamp_osm_base ? osm.osm3s.timestamp_osm_base : null,
        source: '© OpenStreetMap contributors, ODbL',
        vRaw, eRaw, vSimple, eSimple, v: ids.length, e: arcs.length, scc: sccSize, sccCount,
        builder: 'graph.js',
      },
      osmId: ids,
      lat: ids.map((id) => nodeLat.get(id)),
      lon: ids.map((id) => nodeLon.get(id)),
      edges: { from, to, dist, time, geomOffsets, geomCoords },
    };
  }

  /** Запрос Overpass для рамки (s, w, n, e). */
  function overpassQuery(b) {
    return (
      '[out:json][timeout:180];way["highway"~"^(' + config.HIGHWAYS.join('|') + ')$"](' +
      [b.south, b.west, b.north, b.east].join(',') + ');(._;>;);out body qt;'
    );
  }

  const graph = {
    Graph, tarjanSCC, largestComponent, buildFromOverpass, overpassQuery,
    wayAccepted, wayDirection, waySpeed,
  };
  GP.graph = graph;
  GP.Graph = Graph;
  if (isNode) module.exports = graph;
})(typeof window !== 'undefined' ? window : globalThis);

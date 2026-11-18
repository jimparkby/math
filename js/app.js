/*
 * GeoPath — интерфейс: Mapbox-слои, построение маршрута, таблица сравнения, анимация,
 * учебный пример, эксперимент, самопроверка. Математика — в graph.js / algorithms.js.
 */
(function () {
  'use strict';
  const GP = window.GeoPath;
  const { config, geo, algorithms: A, experiment: X, selftest: T } = GP;
  const $ = (id) => document.getElementById(id);

  const S = {
    g: null, snapshot: null,
    map: null, mapReady: false, token: '',
    from: null, to: null, nextPick: 'from',
    markers: { from: null, to: null },
    crit: 'dist',
    last: null,
    graphShown: false, graphFC: null,
    anim: null,
    exp: null,
    extent: null,
  };

  /* ------------------------------------------------------------------ */
  /*  Форматирование                                                     */
  /* ------------------------------------------------------------------ */
  const nf = (x, d = 0) =>
    x === null || x === undefined || !isFinite(x)
      ? '—'
      : x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  function bytes(b) {
    if (b < 1024) return nf(b) + ' Б';
    if (b < 1024 ** 2) return nf(b / 1024, 1) + ' КБ';
    if (b < 1024 ** 3) return nf(b / 1024 ** 2, 1) + ' МБ';
    return nf(b / 1024 ** 3, 1) + ' ГБ';
  }
  function sci(x) {
    const e = Math.floor(Math.log10(x));
    const m = x / 10 ** e;
    const sup = String(e).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join('');
    return nf(m, 2) + '·10' + sup;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const now = () => performance.now();

  let statusTimer = null;
  function status(text, kind, ms) {
    const el = $('status');
    clearTimeout(statusTimer);
    if (!text) { el.hidden = true; return; }
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = text;
    el.hidden = false;
    if (ms) statusTimer = setTimeout(() => (el.hidden = true), ms);
  }

  /* ------------------------------------------------------------------ */
  /*  Граф                                                               */
  /* ------------------------------------------------------------------ */
  function loadSnapshot() {
    if (!window.MINSK_GRAPH) {
      status('Не найден файл <code>data/minsk-graph.js</code>. Сгенерируйте его: <code>python tools/build_graph.py</code>.', 'err');
      return;
    }
    const t0 = now();
    try {
      S.snapshot = GP.Graph.fromCompact(window.MINSK_GRAPH);
    } catch (e) {
      status('Ошибка построения графа: ' + esc(e.message), 'err');
      return;
    }
    S.snapshot.loadMs = now() - t0;
    setGraph(S.snapshot);
  }

  function setGraph(g) {
    S.g = g;
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    for (let i = 0; i < g.n; i++) {
      la0 = Math.min(la0, g.lat[i]); la1 = Math.max(la1, g.lat[i]);
      lo0 = Math.min(lo0, g.lon[i]); lo1 = Math.max(lo1, g.lon[i]);
    }
    S.extent = { s: la0, n: la1, w: lo0, e: lo1 };
    S.graphFC = null;
    S.last = null;
    renderModelStats();
    renderFWInfo();
    renderDataInfo();
    resetCmpTable();
    if (S.graphShown) drawGraph();
  }

  function renderModelStats() {
    const g = S.g, m = g.meta || {}, mem = g.memory();
    const rows = [
      ['|V| до упрощения (узлы OSM)', nf(m.vRaw)],
      ['|E| до упрощения', nf(m.eRaw)],
      ['|V| после упрощения (≈ перекрёстки)', nf(m.vSimple)],
      ['Компонент сильной связности', nf(m.sccCount)],
      ['Наибольшая SCC: |V| / |E|', nf(g.n) + ' / ' + nf(g.m)],
      ['Доля вершин в SCC', m.vSimple ? nf((100 * g.n) / m.vSimple, 1) + ' %' : '—'],
      ['Плотность |E| / |V|', nf(g.m / g.n, 2)],
      ['Тип графа', 'ориентированный, взвешенный'],
      ['Веса w(e)', 'расстояние, м · время, с'],
      ['Проверка: все w(e) ≥ 0', g.allNonNegative ? '<span class="yes" style="color:var(--ok);font-weight:700">✓ выполнено</span>' : '✗'],
      ['v<sub>max</sub> (для эвристики A*)', nf(g.vMax * 3.6, 0) + ' км/ч'],
      ['Память CSR: (|V|+1)·4 + |E|·20 Б', bytes(mem.csr)],
      ['Память матрицы весов: |V|²·8 Б', bytes(mem.matrix) + ' (в ' + nf(mem.matrix / mem.csr, 0) + ' раз больше)'],
    ];
    if (g.loadMs !== undefined) rows.push(['Загрузка снимка и построение CSR', nf(g.loadMs, 0) + ' мс']);
    $('modelStats').innerHTML = rows.map(([k, v]) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>').join('');
  }

  function renderFWInfo() {
    const n = S.g.n;
    const ops = n ** 3;
    $('fwInfo').innerHTML =
      'Для всего графа (|V| = ' + nf(n) + '): матрица |V|²·8 Б = <b>' + bytes(n * n * 8) + '</b>, ' +
      '|V|³ ≈ <b>' + sci(ops) + '</b> операций (≈ ' + nf(ops / 1e9 / 60, 0) + ' мин при 10⁹ операций/с). ' +
      'Поэтому на всём графе алгоритм не запускается — только на подграфе вокруг точки «Откуда».';
    $('fwResult').innerHTML = '';
  }

  function renderDataInfo() {
    const m = S.g.meta || {};
    const snap = S.g === S.snapshot;
    $('dataInfo').innerHTML =
      (snap ? 'Снимок графа: ' : 'Граф загружен из OSM в браузере: ') +
      '<b>данные OSM на ' + esc(fmtDate(m.date)) + '</b>' +
      (snap ? ' (подготовлен <code>tools/build_graph.py</code>)' : '') +
      '. © OpenStreetMap contributors, ODbL.';
    $('btnSnapshot').hidden = snap;
  }
  function fmtDate(d) {
    if (!d) return 'неизвестную дату';
    const x = new Date(d);
    return isNaN(x) ? d : x.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ------------------------------------------------------------------ */
  /*  Карта Mapbox                                                       */
  /* ------------------------------------------------------------------ */
  function readToken() {
    if (config.MAPBOX_TOKEN) return config.MAPBOX_TOKEN;
    try { return localStorage.getItem('geopath.mapboxToken') || ''; } catch (e) { return ''; }
  }
  function saveToken(t) {
    try { localStorage.setItem('geopath.mapboxToken', t); } catch (e) { /* приватный режим */ }
  }

  function mapFallback(text) {
    $('mapFallbackText').innerHTML = text;
    $('mapFallback').hidden = false;
  }

  function initMap() {
    if (typeof mapboxgl === 'undefined') {
      mapFallback('Не удалось загрузить Mapbox GL JS — <b>нет подключения к интернету</b> или доступ к api.mapbox.com заблокирован.');
      status('Нет подключения к интернету: карта и поиск мест недоступны. Расчёты работают по сохранённому снимку графа.', 'err');
      return;
    }
    S.token = readToken();
    if (!S.token) {
      mapFallback('Не задан токен Mapbox.');
      openTokenModal();
      return;
    }
    createMap();
  }

  function createMap() {
    if (S.map) { try { S.map.remove(); } catch (e) { /* ignore */ } }
    S.map = null; S.mapReady = false;
    $('mapFallback').hidden = true;
    mapboxgl.accessToken = S.token;
    let map;
    try {
      map = new mapboxgl.Map({
        container: 'map',
        style: config.MAP_STYLE,
        center: config.CENTER,
        zoom: 11.2,
        customAttribution: 'Граф дорог: © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      });
    } catch (e) {
      mapFallback('Ошибка инициализации карты: ' + esc(e.message));
      return;
    }
    S.map = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    map.on('load', () => {
      addLayers();
      S.mapReady = true;
      redrawAll();
    });
    map.on('error', (ev) => {
      const st = ev && ev.error && ev.error.status;
      if (st === 401 || st === 403) {
        mapFallback('Токен Mapbox недействителен или не разрешён для этой страницы (HTTP ' + st + ').');
        status('Токен Mapbox отклонён сервером. Введите другой токен (кнопка ⚙).', 'err');
      } else if (!S.mapReady && ev && ev.error && /Failed to fetch|NetworkError/i.test(String(ev.error.message))) {
        mapFallback('<b>Нет подключения к интернету</b>: карта не загрузилась.');
      }
    });
    map.on('click', onMapClick);
  }

  function addLayers() {
    const map = S.map;
    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of ['graph', 'graph-nodes', 'visited-d', 'visited-a', 'route-alt', 'route-main', 'snap', 'fw-sub']) {
      map.addSource(id, { type: 'geojson', data: empty });
    }
    map.addLayer({ id: 'graph-lines', type: 'line', source: 'graph', paint: { 'line-color': '#55627a', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 1.4], 'line-opacity': 0.55 } });
    map.addLayer({ id: 'graph-nodes', type: 'circle', source: 'graph-nodes', minzoom: 15, paint: { 'circle-radius': 2.6, 'circle-color': '#ffffff', 'circle-stroke-color': '#3a4556', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'fw-sub', type: 'line', source: 'fw-sub', paint: { 'line-color': '#8250df', 'line-width': 2.5, 'line-opacity': 0.8 } });
    const vis = (color) => ({ 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 15, 4], 'circle-color': color, 'circle-opacity': 0.75 });
    map.addLayer({ id: 'visited-d', type: 'circle', source: 'visited-d', paint: vis('#f28c28') });
    map.addLayer({ id: 'visited-a', type: 'circle', source: 'visited-a', paint: vis('#2da44e') });
    map.addLayer({ id: 'route-alt', type: 'line', source: 'route-alt', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#7d8696', 'line-width': 4, 'line-dasharray': [1.2, 1.4] } });
    map.addLayer({ id: 'route-main-case', type: 'line', source: 'route-main', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
    map.addLayer({ id: 'route-main', type: 'line', source: 'route-main', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1f6feb', 'line-width': 5 } });
    map.addLayer({ id: 'snap', type: 'line', source: 'snap', paint: { 'line-color': '#1c2430', 'line-width': 1.6, 'line-dasharray': [2, 2] } });
  }

  function setSrc(id, data) {
    if (!S.mapReady) return;
    const src = S.map.getSource(id);
    if (src) src.setData(data || { type: 'FeatureCollection', features: [] });
  }
  const line = (coords, props) => ({ type: 'Feature', properties: props || {}, geometry: { type: 'LineString', coordinates: coords } });
  const fc = (features) => ({ type: 'FeatureCollection', features });

  function redrawAll() {
    for (const w of ['from', 'to']) if (S[w]) placeMarker(w);
    if (S.last) drawRoute();
    if (S.graphShown) drawGraph();
  }

  /* ------------------------------------------------------------------ */
  /*  Точки «Откуда» / «Куда»                                            */
  /* ------------------------------------------------------------------ */
  function setPoint(which, lngLat, label, opts) {
    opts = opts || {};
    S[which] = { lng: lngLat[0], lat: lngLat[1], label: label || coordLabel(lngLat) };
    $(which === 'from' ? 'inFrom' : 'inTo').value = S[which].label;
    placeMarker(which);
    if (opts.fly && S.mapReady && !(S.from && S.to)) S.map.flyTo({ center: lngLat, zoom: Math.max(S.map.getZoom(), 13) });
  }
  const coordLabel = (ll) => ll[1].toFixed(5) + ', ' + ll[0].toFixed(5);

  function placeMarker(which) {
    if (!S.mapReady || !S[which]) return;
    const p = [S[which].lng, S[which].lat];
    let m = S.markers[which];
    if (!m) {
      const el = document.createElement('div');
      el.className = 'marker';
      el.style.cssText = 'width:26px;height:26px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);display:grid;place-items:center;color:#fff;font:700 12px system-ui;cursor:grab;background:' + (which === 'from' ? '#2da44e' : '#cf222e');
      el.textContent = which === 'from' ? 'A' : 'B';
      el.addEventListener('click', (e) => e.stopPropagation());
      m = new mapboxgl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(S.map);
      m.on('dragend', () => {
        const ll = m.getLngLat();
        setPoint(which, [ll.lng, ll.lat], 'Точка на карте: ' + coordLabel([ll.lng, ll.lat]));
        if (S.from && S.to) computeRoute();
      });
      S.markers[which] = m;
    } else {
      m.setLngLat(p);
    }
  }

  function onMapClick(e) {
    const ll = [e.lngLat.lng, e.lngLat.lat];
    const which = S.nextPick;
    setPoint(which, ll, 'Точка на карте: ' + coordLabel(ll));
    S.nextPick = which === 'from' ? 'to' : 'from';
    if (which === 'to' && S.from) computeRoute();
  }

  /* ---------- Поиск мест: пресеты + Mapbox Geocoding ---------- */
  function presetList(q) {
    q = (q || '').trim().toLowerCase();
    return Object.values(config.PLACES)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((p) => ({ name: p.name, sub: 'готовая точка', lngLat: p.lngLat, tag: true }));
  }

  function setupSuggest(inputId, listId, which) {
    const input = $(inputId), list = $(listId);
    let timer = null, items = [], active = -1, reqId = 0;
    const render = () => {
      if (!items.length) { list.hidden = true; return; }
      list.innerHTML = items
        .map((it, i) => '<li data-i="' + i + '" class="' + (it.tag ? 'tag ' : '') + (i === active ? 'active' : '') + '">' + esc(it.name) + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</li>')
        .join('');
      list.hidden = false;
    };
    const choose = (it) => {
      list.hidden = true;
      if (!it || !it.lngLat) return;
      setPoint(which, it.lngLat, it.name, { fly: true });
      S.nextPick = which === 'from' ? 'to' : 'from';
    };
    const search = async (q) => {
      const id = ++reqId;
      items = presetList(q);
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
      if (m) items.unshift({ name: 'Координаты ' + m[1] + ', ' + m[2], sub: 'широта, долгота', lngLat: [parseFloat(m[2]), parseFloat(m[1])] });
      active = items.length ? 0 : -1;
      render();
      if (!S.token || q.trim().length < 3 || m) return;
      const b = config.BBOX;
      const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(q) + '.json?' +
        new URLSearchParams({ access_token: S.token, bbox: [b.west, b.south, b.east, b.north].join(','), language: 'ru', limit: '6', proximity: config.CENTER.join(',') });
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (id !== reqId) return;
        const geoItems = (j.features || []).map((f) => ({ name: f.text, sub: f.place_name, lngLat: f.center }));
        items = presetList(q).concat(geoItems);
        if (!items.length) items = [{ name: 'Ничего не найдено в пределах Минска', sub: 'уточните запрос или выберите точку на карте' }];
      } catch (err) {
        if (id !== reqId) return;
        items = presetList(q).concat([{ name: 'Поиск мест недоступен', sub: navigator.onLine === false ? 'нет подключения к интернету' : 'ошибка сервиса геокодирования: ' + err.message }]);
      }
      active = items.length ? 0 : -1;
      render();
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(input.value), 300); // задержка 300 мс
    });
    input.addEventListener('focus', () => { if (!input.value || /^Точка на карте/.test(input.value)) { items = presetList(''); active = -1; render(); } });
    input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 180));
    input.addEventListener('keydown', (e) => {
      if (list.hidden) { if (e.key === 'Enter') computeRoute(); return; }
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { choose(items[active]); e.preventDefault(); }
      else if (e.key === 'Escape') { list.hidden = true; }
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li');
      if (li) { e.preventDefault(); choose(items[+li.dataset.i]); }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Построение маршрута                                                */
  /* ------------------------------------------------------------------ */
  function snapPoint(p, label) {
    const e = S.extent, pad = 0.01;
    const res = S.g.nearestVertex(p.lat, p.lng);
    if (!res || p.lat < e.s - pad || p.lat > e.n + pad || p.lng < e.w - pad || p.lng > e.e + pad || res.dist > 1000) {
      throw new Error('Точка «' + label + '» вне графа дорожной сети' + (res ? ' (до ближайшей дороги графа ' + nf(res.dist / 1000, 1) + ' км)' : '') + '. Выберите точку в пределах Минска.');
    }
    return res;
  }

  function computeRoute() {
    cancelAnimation();
    if (!S.g) return;
    if (!S.from || !S.to) {
      status('Укажите точки «Откуда» и «Куда»: выберите из подсказок, готовый сценарий или кликните по карте.', '', 5000);
      return;
    }
    let sn, tn;
    try {
      sn = snapPoint(S.from, 'Откуда');
      tn = snapPoint(S.to, 'Куда');
    } catch (e) {
      status(esc(e.message), 'err');
      clearRoute();
      return;
    }
    const g = S.g, s = sn.v, t = tn.v, crit = S.crit, other = crit === 'dist' ? 'time' : 'dist';
    const rD = A.dijkstra(g, s, t, { weight: crit });
    if (!rD.found) {
      status('Маршрут не найден: между точками нет пути по дорогам с учётом направлений движения.', 'err');
      clearRoute();
      return;
    }
    const rA = A.astar(g, s, t, { weight: crit });
    const rB = A.bidirectional(g, s, t, { weight: crit });
    const rAlt = A.dijkstra(g, s, t, { weight: other });
    status('');
    S.last = { s, t, sn, tn, crit, rD, rA, rB, rAlt, bf: null, times: null };
    renderResult();
    drawRoute(true);
    renderCmpTable();
    $('resExternal').textContent = '';
    // замер времени вычисления — после отрисовки, чтобы не задерживать интерфейс
    const token = S.last;
    setTimeout(() => {
      if (S.last !== token) return;
      const opt = { weight: crit };
      token.times = {
        D: X.timeIt(() => A.dijkstra(g, s, t, opt), 5, 'median'),
        A: X.timeIt(() => A.astar(g, s, t, opt), 5, 'median'),
        B: X.timeIt(() => A.bidirectional(g, s, t, opt), 5, 'median'),
      };
      if (S.last === token) renderCmpTable();
    }, 30);
  }

  function routeStats(r) {
    return { km: A.pathCost(S.g, r.path.edges, 'dist') / 1000, min: A.pathCost(S.g, r.path.edges, 'time') / 60 };
  }

  function renderResult() {
    const L = S.last;
    const main = routeStats(L.rD), alt = routeStats(L.rAlt);
    $('secResult').hidden = false;
    $('resKm').textContent = nf(main.km, 2) + ' км';
    $('resMin').textContent = nf(main.min, 1) + ' мин';
    const same = L.rD.path.edges.join() === L.rAlt.path.edges.join();
    let txt;
    if (L.s === L.t) {
      txt = 'Обе точки привязаны к одной вершине графа: маршрут нулевой длины.';
    } else if (same) {
      txt = 'Маршруты по обоим критериям <b>совпадают</b>: кратчайший путь одновременно самый быстрый.';
    } else if (L.crit === 'dist') {
      txt = 'Самый быстрый маршрут ' + diffWord(alt.km - main.km, 'длиннее', 'короче', 'км', 2) + ', но быстрее на <b>' + nf(main.min - alt.min, 1) + ' мин</b> (' + nf(alt.km, 2) + ' км, ' + nf(alt.min, 1) + ' мин).';
    } else {
      txt = 'Самый короткий маршрут короче на <b>' + nf(main.km - alt.km, 2) + ' км</b>, но дольше на <b>' + nf(alt.min - main.min, 1) + ' мин</b> (' + nf(alt.km, 2) + ' км, ' + nf(alt.min, 1) + ' мин).';
    }
    $('resAlt').innerHTML = txt;
    $('lgMain').textContent = L.crit === 'dist' ? 'кратчайший (оптимальный)' : 'самый быстрый (оптимальный)';
    $('lgAlt').textContent = L.crit === 'dist' ? 'самый быстрый' : 'кратчайший';
    $('resSnap').textContent =
      'Привязка к графу: «Откуда» — ' + nf(L.sn.dist, 0) + ' м, «Куда» — ' + nf(L.tn.dist, 0) + ' м до ближайшей вершины (пунктир). Вершин в пути: ' + L.rD.path.vertices.length + '.';
  }
  function diffWord(d, more, less, unit, dec) {
    if (Math.abs(d) < 0.005) return 'такой же длины';
    return (d > 0 ? more : less) + ' на <b>' + nf(Math.abs(d), dec) + ' ' + unit + '</b>';
  }

  function pathCoords(r) {
    const out = [];
    for (const e of r.path.edges) {
      const c = S.g.edgeCoords(e);
      if (out.length) c.shift();
      out.push(...c);
    }
    return out;
  }

  function drawRoute(fit) {
    if (!S.mapReady || !S.last) return;
    const L = S.last, g = S.g;
    const main = L.s === L.t ? [[g.lon[L.s], g.lat[L.s]], [g.lon[L.s], g.lat[L.s]]] : pathCoords(L.rD);
    const same = L.rD.path.edges.join() === L.rAlt.path.edges.join();
    setSrc('route-main', fc([line(main)]));
    setSrc('route-alt', fc(same || L.s === L.t ? [] : [line(pathCoords(L.rAlt))]));
    setSrc('snap', fc([
      line([[S.from.lng, S.from.lat], [g.lon[L.s], g.lat[L.s]]]),
      line([[S.to.lng, S.to.lat], [g.lon[L.t], g.lat[L.t]]]),
    ]));
    if (fit) {
      const b = new mapboxgl.LngLatBounds();
      main.forEach((c) => b.extend(c));
      b.extend([S.from.lng, S.from.lat]); b.extend([S.to.lng, S.to.lat]);
      const mobile = window.innerWidth <= 820;
      S.map.fitBounds(b, { padding: mobile ? 40 : 70, maxZoom: 16, duration: 700 });
    }
  }

  function clearRoute() {
    S.last = null;
    for (const id of ['route-main', 'route-alt', 'snap']) setSrc(id, null);
    $('secResult').hidden = true;
    resetCmpTable();
  }

  /* ---------- Таблица сравнения алгоритмов ---------- */
  function resetCmpTable() {
    $('cmpTable').tBodies[0].innerHTML = '<tr><td colspan="5" class="muted">Постройте маршрут, чтобы заполнить таблицу.</td></tr>';
  }

  function costText(c, w) {
    if (!isFinite(c)) return '—';
    return w === 'time' ? nf(c, 1) + ' с<br><span class="muted">' + nf(c / 60, 2) + ' мин</span>' : nf(c, 1) + ' м';
  }

  function renderCmpTable() {
    const L = S.last, g = S.g;
    if (!L) return resetCmpTable();
    const cols = [L.rD, L.rA, L.rB];
    const bf = L.bf;
    const pct = (x) => nf(x) + '<br><span class="muted">' + nf((100 * x) / g.n, 1) + ' %</span>';
    const yes = (r) => (A.pathCost && r && isFinite(r.cost) ? (T.same(r.cost, L.rD.cost) ? '<span class="yes">✓</span>' : '<span class="no">✗</span>') : '—');
    const ms = (x) => (x === undefined || x === null ? '<span class="muted">…</span>' : nf(x, x < 1 ? 3 : 2));
    const t = L.times || {};
    let bfCells;
    if (!bf) bfCells = null;
    const row = (name, vals, bfVal) =>
      '<tr><td>' + name + '</td>' + vals.map((v) => '<td>' + v + '</td>').join('') + '<td>' + bfVal + '</td></tr>';
    const bfBtn = '<button class="btn small" id="btnBF">Запустить</button>';
    let html = '';
    html += row('Стоимость L(P*)', cols.map((r) => costText(r.cost, L.crit)), bf && bf.done ? costText(bf.res.cost, L.crit) : bf ? '<span class="muted">' + esc(bf.progress) + '</span>' : bfBtn);
    html += row('Обработано вершин<br><span class="muted">(% от |V|)</span>', cols.map((r) => pct(r.settled)), bf && bf.done ? '<span class="muted">все дуги × проходы</span>' : '');
    html += row('Релаксаций (просмотров дуг)', cols.map((r) => nf(r.relaxations)), bf && bf.done ? nf(bf.res.relaxations) : '');
    html += row('Операций с кучей', cols.map((r) => nf(r.heapOps)), bf && bf.done ? '0 <span class="muted">(без кучи)</span>' : '');
    html += row('Проходов по всем дугам', ['—', '—', '—'], bf && bf.done ? nf(bf.res.passes) + '<br><span class="muted">из |V|−1 = ' + nf(g.n - 1) + '</span>' : '');
    html += row('Время вычисления, мс', [ms(t.D), ms(t.A), ms(t.B)], bf && bf.done ? nf(bf.ms, 1) : '');
    html += row('Совпадает с Дейкстрой', cols.map(yes), bf && bf.done ? yes(bf.res) + (bf.res.negativeCycle ? ' <span class="no">отр. цикл!</span>' : '') : '');
    $('cmpTable').tBodies[0].innerHTML = html;
    const b = $('btnBF');
    if (b) b.onclick = runBellmanFord;
  }

  /** Беллман — Форд по кнопке: по частям, чтобы вкладка не «зависала». */
  function runBellmanFord() {
    const L = S.last;
    if (!L) return;
    const bf = new A.BellmanFord(S.g, L.s, { weight: L.crit });
    L.bf = { done: false, progress: 'проход 1…', ms: 0 };
    renderCmpTable();
    const step = () => {
      if (S.last !== L) return;
      const t0 = now();
      const done = bf.step(300000);
      L.bf.ms += now() - t0; // учитываем только время вычислений, без пауз между частями
      if (done) {
        L.bf.done = true;
        L.bf.res = bf.result(L.t);
      } else {
        L.bf.progress = 'проход ' + bf.pass + '…';
        setTimeout(step, 0);
      }
      renderCmpTable();
    };
    setTimeout(step, 0);
  }

  /* ---------- Флойд — Уоршелл на подграфе ---------- */
  function runFW() {
    const g = S.g;
    let center;
    if (S.last) center = S.last.s;
    else if (S.from) { try { center = snapPoint(S.from, 'Откуда').v; } catch (e) { status(esc(e.message), 'err'); return; } }
    else center = g.nearestVertex(config.CENTER[1], config.CENTER[0]).v;
    const crit = S.crit;
    const r = T.checkFloydSubgraph(g, center, crit);
    const sub = r.sub;
    $('fwResult').innerHTML =
      '<table class="kv">' +
      '<tr><td>Подграф (вершины в радиусе 500 м)</td><td>|V| = ' + sub.n + ', |E| = ' + sub.m + '</td></tr>' +
      '<tr><td>Память матрицы |V|²·8 Б</td><td>' + bytes(sub.n * sub.n * 8) + '</td></tr>' +
      '<tr><td>Операций |V|³</td><td>' + nf(r.fw.ops) + '</td></tr>' +
      '<tr><td>Время Флойда — Уоршелла</td><td>' + nf(r.ms, 2) + ' мс</td></tr>' +
      '<tr><td>Совпадает с Дейкстрой (все ' + nf(r.total) + ' пар, ' + (crit === 'time' ? 'время' : 'расстояние') + ')</td><td>' +
      (r.ok === r.total ? '<b style="color:var(--ok)">✓ ' + nf(r.ok) + ' / ' + nf(r.total) + '</b>' : '<b style="color:var(--bad)">✗ ' + nf(r.ok) + ' / ' + nf(r.total) + '</b>') + '</td></tr>' +
      '<tr><td>Для сравнения — весь граф: |V|³</td><td>' + sci(g.n ** 3) + ' (в ' + sci((g.n / sub.n) ** 3) + ' раз больше)</td></tr>' +
      '</table>';
    if (S.mapReady) {
      const feats = [];
      for (let k = 0; k < sub.m; k++) feats.push(line(sub.edgeCoords(k)));
      setSrc('fw-sub', fc(feats));
      const b = new mapboxgl.LngLatBounds();
      for (let i = 0; i < sub.n; i++) b.extend([sub.lon[i], sub.lat[i]]);
      S.map.fitBounds(b, { padding: 80, maxZoom: 16 });
    }
  }
  function fmtDuration(ms) {
    const s = ms / 1000;
    if (s < 60) return nf(s, 1) + ' с';
    if (s < 3600) return nf(s / 60, 1) + ' мин';
    if (s < 86400) return nf(s / 3600, 1) + ' ч';
    return nf(s / 86400, 1) + ' сут';
  }

  /* ------------------------------------------------------------------ */
  /*  Анимация поиска                                                    */
  /* ------------------------------------------------------------------ */
  function cancelAnimation() {
    if (S.anim) { cancelAnimationFrame(S.anim.raf); S.anim = null; }
    setSrc('visited-d', null);
    setSrc('visited-a', null);
    $('animCounter').hidden = true;
    $('btnAnim').textContent = '▶ Анимация поиска';
  }

  function startAnimation() {
    if (S.anim) { cancelAnimation(); return; }
    if (!S.last) { status('Сначала постройте маршрут — анимация показывает поиск для текущей пары точек.', '', 5000); return; }
    if (!S.mapReady) { status('Анимация требует карты (нет токена или подключения к интернету).', 'err', 5000); return; }
    const L = S.last, g = S.g, opt = { weight: L.crit, record: true };
    const od = A.dijkstra(g, L.s, L.t, opt).order;
    const oa = A.astar(g, L.s, L.t, opt).order;
    const mode = $('animMode').value;
    const DURATION = 6000;
    const rate = mode === 'both' ? Math.max(od.length, oa.length) / DURATION : (od.length + oa.length) / DURATION;
    const fD = [], fA = [];
    const pt = (v) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [g.lon[v], g.lat[v]] } });
    let shownD = 0, shownA = 0;
    const t0 = now();
    const anim = (S.anim = { raf: 0 });
    $('animCounter').hidden = false;
    $('btnAnim').textContent = '■ Остановить';
    const frame = () => {
      if (S.anim !== anim) return;
      const k = Math.floor((now() - t0) * rate);
      let wantD, wantA;
      if (mode === 'both') { wantD = Math.min(od.length, k); wantA = Math.min(oa.length, k); }
      else { wantD = Math.min(od.length, k); wantA = Math.max(0, Math.min(oa.length, k - od.length)); }
      // данные обновляются пачкой раз в кадр, а не по одной точке
      if (wantD > shownD) { for (let i = shownD; i < wantD; i++) fD.push(pt(od[i])); shownD = wantD; setSrc('visited-d', fc(fD)); }
      if (wantA > shownA) { for (let i = shownA; i < wantA; i++) fA.push(pt(oa[i])); shownA = wantA; setSrc('visited-a', fc(fA)); }
      const step = mode === 'both' ? Math.max(shownD, shownA) : shownD + shownA;
      const finished = shownD === od.length && shownA === oa.length;
      $('animCounter').innerHTML =
        'Шаг ' + nf(step) + ' · <span class="d">Дейкстра: ' + nf(shownD) + '</span> · <span class="a">A*: ' + nf(shownA) + '</span> обработанных вершин' +
        (finished ? '<br>Итог: A* обработал в <b>' + nf(od.length / oa.length, 1) + ' раза</b> меньше вершин (' + nf(oa.length) + ' против ' + nf(od.length) + ').' : '');
      if (finished) { S.anim = null; $('btnAnim').textContent = '▶ Анимация поиска'; return; }
      anim.raf = requestAnimationFrame(frame);
    };
    anim.raf = requestAnimationFrame(frame);
  }

  /* ---------- Показ графа ---------- */
  function drawGraph() {
    if (!S.mapReady) return;
    if (!S.graphFC) {
      const g = S.g, lines = [], seen = new Set();
      for (let k = 0; k < g.m; k++) {
        const u = g.adjFrom[k], v = g.adjTo[k];
        const key = u < v ? u + '_' + v + '_' + g.wDist[k] : v + '_' + u + '_' + g.wDist[k];
        if (seen.has(key)) continue; // двусторонняя улица — одна линия
        seen.add(key);
        lines.push(line(g.edgeCoords(k)));
      }
      const nodes = [];
      for (let i = 0; i < g.n; i++) nodes.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [g.lon[i], g.lat[i]] } });
      S.graphFC = { lines: fc(lines), nodes: fc(nodes) };
    }
    setSrc('graph', S.graphFC.lines);
    setSrc('graph-nodes', S.graphFC.nodes);
  }
  function toggleGraph() {
    if (!S.mapReady) { status('Показ графа требует карты.', 'err', 4000); return; }
    S.graphShown = !S.graphShown;
    if (S.graphShown) drawGraph();
    else { setSrc('graph', null); setSrc('graph-nodes', null); }
    $('btnGraph').textContent = S.graphShown ? 'Скрыть граф' : 'Показать граф';
    if (S.graphShown) status('Показано ' + nf(S.g.n) + ' вершин и ' + nf(S.g.m) + ' дуг. Вершины видны при масштабе ≥ 15.', 'ok', 4000);
  }

  function clearAll() {
    cancelAnimation();
    clearRoute();
    S.from = S.to = null; S.nextPick = 'from';
    $('inFrom').value = ''; $('inTo').value = '';
    for (const w of ['from', 'to']) if (S.markers[w]) { S.markers[w].remove(); S.markers[w] = null; }
    if (S.graphShown) toggleGraph();
    setSrc('fw-sub', null);
    $('fwResult').innerHTML = '';
    status('');
  }

  /* ---------- Внешняя сверка (необязательно) ---------- */
  async function externalCheck() {
    if (!S.last) { status('Сначала постройте маршрут.', '', 4000); return; }
    if (!S.token) { status('Для внешней сверки нужен токен Mapbox.', 'err', 4000); return; }
    const url = 'https://api.mapbox.com/directions/v5/mapbox/driving/' +
      S.from.lng + ',' + S.from.lat + ';' + S.to.lng + ',' + S.to.lat + '?overview=false&access_token=' + encodeURIComponent(S.token);
    $('resExternal').textContent = 'Запрос к внешнему сервису…';
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok || !j.routes || !j.routes.length) throw new Error(j.message || 'HTTP ' + r.status);
      const ro = j.routes[0];
      $('resExternal').innerHTML = 'Внешний сервис (Mapbox Directions, driving): ' + nf(ro.distance / 1000, 2) + ' км, ' + nf(ro.duration / 60, 1) +
        ' мин — <i>внешняя оценка для сравнения, не результат системы</i> (учитывает пробки/повороты и другую модель скоростей).';
    } catch (e) {
      $('resExternal').textContent = 'Внешняя сверка недоступна: ' + e.message;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Учебный пример (граф статьи, таблица 2)                            */
  /* ------------------------------------------------------------------ */
  const TUT_POS = [[60, 215], [175, 295], [205, 170], [365, 260], [410, 90], [170, 55]];
  let tut = null;
  function openTutorial() {
    const g = T.paperGraph();
    tut = { g, steps: A.dijkstraTrace(g, 0), k: 0, timer: null };
    $('tutModal').hidden = false;
    renderTutorial();
  }
  function renderTutorial() {
    const { g, steps, k } = tut;
    const N = T.PAPER_NAMES, st = steps[k], prev = steps[Math.max(0, k - 1)];
    const last = k === steps.length - 1;
    const pathV = last ? [0, 2, 5, 4] : [];
    const onPath = (u, v) => { for (let i = 0; i + 1 < pathV.length; i++) if ((pathV[i] === u && pathV[i + 1] === v) || (pathV[i] === v && pathV[i + 1] === u)) return true; return false; };
    let svg = '';
    for (const [u, v, w] of T.PAPER_EDGES) {
      const [x1, y1] = TUT_POS[u], [x2, y2] = TUT_POS[v];
      const tree = (st.prev[v] === u && st.done[v]) || (st.prev[u] === v && st.done[u]);
      svg += '<line class="edge' + (onPath(u, v) ? ' path' : tree ? ' tree' : '') + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>';
      svg += '<text class="ew" x="' + ((x1 + x2) / 2 + 4) + '" y="' + ((y1 + y2) / 2 - 4) + '">' + w + '</text>';
    }
    for (let v = 0; v < 6; v++) {
      const [x, y] = TUT_POS[v];
      const cls = v === st.u ? 'cur' : st.done[v] ? 'done' : st.updated.includes(v) ? 'upd' : '';
      svg += '<g class="node ' + cls + '"><circle cx="' + x + '" cy="' + y + '" r="17"/><text x="' + x + '" y="' + y + '">' + N[v] + '</text></g>';
      svg += '<text class="lbl" x="' + x + '" y="' + (y - 24) + '">' + (st.d[v] === Infinity ? '∞' : st.d[v]) + '</text>';
    }
    $('tutSvg').innerHTML = svg;

    let text;
    if (k === 0) text = 'Инициализация: d(A) = 0, для остальных вершин d(v) = ∞. Все вершины не посещены.';
    else {
      const u = st.u;
      const upd = st.updated.map((v) => N[v] + ': ' + (prev.d[v] === Infinity ? '∞' : prev.d[v]) + ' → ' + st.d[v]).join(', ');
      text = '<b>Шаг ' + k + '.</b> Выбираем непосещённую вершину с минимальной меткой: <b>' + N[u] + '</b> (d = ' + st.d[u] + '), она становится посещённой. ' +
        'Релаксация дуг из ' + N[u] + ' по формуле d(v) = min(d(v), d(' + N[u] + ') + w(' + N[u] + ',v)): ' + (upd ? 'обновлены ' + upd + '.' : 'метки не изменились.');
      if (last) text += '<br><b>Готово.</b> Кратчайший путь A → E: <b>A–C–F–E</b>, L = 9 + 2 + 9 = <b>20</b>.';
    }
    $('tutText').innerHTML = text;

    let th = '<thead><tr><th>Шаг</th><th>Вершина</th>' + N.map((x) => '<th>' + x + '</th>').join('') + '</tr></thead><tbody>';
    for (let i = 0; i <= k; i++) {
      const s = steps[i], p = steps[Math.max(0, i - 1)];
      th += '<tr class="' + (i === k ? 'active' : '') + '"><td>' + i + '</td><td>' + (s.u < 0 ? 'нач.' : N[s.u]) + '</td>';
      for (let v = 0; v < 6; v++) {
        const wasDone = i > 0 && p.done[v];
        const cls = v === s.u ? 'cur' : wasDone ? 'done' : s.updated.includes(v) && i > 0 ? 'upd' : '';
        th += '<td class="' + cls + '">' + (wasDone ? '✓' : s.d[v] === Infinity ? '∞' : s.d[v]) + '</td>';
      }
      th += '</tr>';
    }
    $('tutTable').innerHTML = th + '</tbody>';
    $('tutPrev').disabled = k === 0;
    $('tutNext').disabled = last;
  }
  function tutStep(d) {
    tut.k = Math.max(0, Math.min(tut.steps.length - 1, tut.k + d));
    renderTutorial();
  }
  function tutPlay() {
    if (tut.timer) { clearInterval(tut.timer); tut.timer = null; $('tutPlay').textContent = '▶ Авто'; return; }
    if (tut.k === tut.steps.length - 1) tut.k = 0;
    $('tutPlay').textContent = '❚❚ Пауза';
    tut.timer = setInterval(() => {
      if (tut.k >= tut.steps.length - 1) { clearInterval(tut.timer); tut.timer = null; $('tutPlay').textContent = '▶ Авто'; return; }
      tutStep(1);
    }, 1300);
    renderTutorial();
  }
  function closeTutorial() {
    if (tut && tut.timer) clearInterval(tut.timer);
    $('tutPlay').textContent = '▶ Авто';
    $('tutModal').hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /*  Вычислительный эксперимент                                         */
  /* ------------------------------------------------------------------ */
  async function runExperiment() {
    const btn = $('btnExp');
    const pairs = Math.max(10, Math.min(2000, parseInt($('expPairs').value, 10) || 100));
    const weight = $('expCrit').value;
    btn.disabled = true;
    const pr = $('expProgress');
    pr.hidden = false;
    const bar = pr.querySelector('.bar'), lbl = pr.querySelector('span');
    $('expOut').innerHTML = '';
    try {
      const res = await X.run(S.g, {
        pairs, weight, seed: config.EXPERIMENT_SEED,
        onProgress: (i, n) => { bar.style.width = (100 * i) / n + '%'; lbl.textContent = 'Пара ' + i + ' из ' + n; },
      });
      S.exp = res;
      renderExperiment(res);
    } catch (e) {
      $('expOut').innerHTML = '<p class="err">Ошибка эксперимента: ' + esc(e.message) + '</p>';
    }
    pr.hidden = true;
    btn.disabled = false;
  }

  function renderExperiment(res) {
    const h = res.header;
    const crit = h.weight === 'time' ? 'время' : 'расстояние';
    let html = '<div class="exp-head">Снимок OSM: <b>' + esc(fmtDate(h.osmDate)) + '</b> · |V| = ' + nf(h.v) + ' · |E| = ' + nf(h.e) +
      ' · критерий: ' + crit + ' · seed = ' + h.seed + ' · пар: ' + res.rows.length + ' · ' + esc(h.browser) + '</div>';
    html += '<div class="table-wrap"><table class="cmp"><thead><tr><th>Длина маршрута</th><th>Пар</th><th>Ср. длина, км</th><th>Извил.</th>' +
      '<th>Обраб. верш.: Дейкстра</th><th>A*</th><th>Двунапр.</th><th>A* меньше в, раз</th>' +
      '<th>Время Дейкстры, мс</th><th>A*, мс</th><th>Двунапр., мс</th><th>Совп., %</th></tr></thead><tbody>';
    for (const s of res.summary) {
      html += '<tr class="' + (s.group === 'все' ? 'total' : '') + '"><td>' + s.group + '</td><td>' + s.count + '</td><td>' + nf(s.avgKm, 2) + '</td><td>' + nf(s.tortuosity, 2) +
        '</td><td>' + nf(s.settledD, 0) + '</td><td>' + nf(s.settledA, 0) + '</td><td>' + nf(s.settledB, 0) + '</td><td>' + nf(s.ratioDA, 2) +
        '</td><td>' + nf(s.msD, 3) + '</td><td>' + nf(s.msA, 3) + '</td><td>' + nf(s.msB, 3) + '</td><td>' + nf(s.matchPct, 0) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<p class="note">«A* меньше в, раз» — отношение среднего числа обработанных вершин Дейкстры к A*. Извилистость — длина по дорогам / расстояние по прямой. Время — минимум по 3 сериям ≥ 30 мс.</p>';
    html += chartSVG(res.rows);
    html += '<div class="row wrap"><button class="btn small" id="btnCSV">Скачать CSV (все пары)</button><button class="btn small" id="btnTSV">Копировать таблицу для статьи</button></div>';
    $('expOut').innerHTML = html;
    $('btnCSV').onclick = () => download(X.toCSV(res), 'geopath_experiment_' + h.weight + '_seed' + h.seed + '_' + res.rows.length + '.csv', 'text/csv;charset=utf-8');
    $('btnTSV').onclick = () => copyText(X.toTSV(res));
  }

  function chartSVG(rows) {
    const W = 400, H = 250, ml = 48, mr = 10, mt = 14, mb = 34;
    const xMax = niceMax(Math.max(...rows.map((r) => r.routeKm)));
    const yMax = niceMax(Math.max(...rows.map((r) => r.D.settled)));
    const X0 = (x) => ml + (x / xMax) * (W - ml - mr);
    const Y0 = (y) => H - mb - (y / yMax) * (H - mt - mb);
    let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Обработанные вершины в зависимости от длины маршрута">';
    for (let i = 0; i <= 5; i++) {
      const x = (xMax * i) / 5, y = (yMax * i) / 5;
      s += '<line x1="' + X0(x) + '" y1="' + (H - mb) + '" x2="' + X0(x) + '" y2="' + mt + '" stroke="#eef1f4"/>';
      s += '<line x1="' + ml + '" y1="' + Y0(y) + '" x2="' + (W - mr) + '" y2="' + Y0(y) + '" stroke="#eef1f4"/>';
      s += '<text x="' + X0(x) + '" y="' + (H - mb + 13) + '" text-anchor="middle">' + nf(x, xMax < 10 ? 1 : 0) + '</text>';
      s += '<text x="' + (ml - 5) + '" y="' + (Y0(y) + 3) + '" text-anchor="end">' + nf(y) + '</text>';
    }
    s += '<line x1="' + ml + '" y1="' + (H - mb) + '" x2="' + (W - mr) + '" y2="' + (H - mb) + '" stroke="#999"/>';
    s += '<line x1="' + ml + '" y1="' + mt + '" x2="' + ml + '" y2="' + (H - mb) + '" stroke="#999"/>';
    s += '<text x="' + (W + ml) / 2 + '" y="' + (H - 4) + '" text-anchor="middle">длина маршрута, км</text>';
    s += '<text x="10" y="' + (H - mb) / 2 + '" text-anchor="middle" transform="rotate(-90 10 ' + (H - mb) / 2 + ')">обработано вершин</text>';
    for (const r of rows) s += '<circle cx="' + X0(r.routeKm).toFixed(1) + '" cy="' + Y0(r.D.settled).toFixed(1) + '" r="2.6" fill="#f28c28" fill-opacity=".8"/>';
    for (const r of rows) s += '<circle cx="' + X0(r.routeKm).toFixed(1) + '" cy="' + Y0(r.A.settled).toFixed(1) + '" r="2.6" fill="#2da44e" fill-opacity=".8"/>';
    s += '<circle cx="' + (ml + 12) + '" cy="' + (mt + 6) + '" r="4" fill="#f28c28"/><text x="' + (ml + 20) + '" y="' + (mt + 9) + '">Дейкстра</text>';
    s += '<circle cx="' + (ml + 82) + '" cy="' + (mt + 6) + '" r="4" fill="#2da44e"/><text x="' + (ml + 90) + '" y="' + (mt + 9) + '">A*</text>';
    return s + '</svg>';
  }
  function niceMax(x) {
    if (!(x > 0)) return 1;
    const e = 10 ** Math.floor(Math.log10(x));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= x) return m * e;
    return 10 * e;
  }

  function download(text, name, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function copyText(text) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    status(ok ? 'Таблица скопирована — вставьте в Word (Ctrl+V), она вставится как таблица.' : 'Не удалось скопировать в буфер обмена.', ok ? 'ok' : 'err', 5000);
  }

  /* ------------------------------------------------------------------ */
  /*  Самопроверка                                                       */
  /* ------------------------------------------------------------------ */
  async function runSelfTest() {
    const btn = $('btnTest'), out = $('testOut'), pr = $('testProgress');
    btn.disabled = true;
    out.innerHTML = '';
    pr.hidden = false;
    const lbl = pr.querySelector('span'), bar = pr.querySelector('.bar');
    bar.style.width = '100%'; bar.style.opacity = '.35';
    const useRef = S.g === S.snapshot && window.REFERENCE && window.REFERENCE_META && window.REFERENCE_META.v === S.g.n;
    const t0 = now();
    const res = await T.run(S.g, {
      reference: useRef ? window.REFERENCE : null,
      pairs: 50, bfPairs: 3,
      onProgress: (t) => (lbl.textContent = t),
      onCheck: (c) => {
        const li = document.createElement('li');
        li.className = c.ok === null ? 'skip' : c.ok ? 'ok' : 'bad';
        li.innerHTML = '<b>' + esc(c.name) + '</b><span class="det">' + esc(c.details || '') + '</span>';
        out.appendChild(li);
      },
    });
    const li = document.createElement('li');
    li.className = 'summary ' + (res.allOk ? 'ok' : 'bad');
    li.innerHTML = '<b>' + (res.allOk ? 'Все проверки пройдены' : 'Ошибок: ' + res.failed) + ' (' + nf((now() - t0) / 1000, 1) + ' с)</b>';
    out.appendChild(li);
    pr.hidden = true;
    btn.disabled = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Обновление данных из OSM в браузере                                */
  /* ------------------------------------------------------------------ */
  async function refreshOSM() {
    let bbox = config.BBOX;
    if ($('osmArea').value === 'view') {
      if (!S.mapReady) { status('Для выбора области нужна карта.', 'err', 4000); return; }
      const b = S.map.getBounds();
      bbox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
      const area = (bbox.north - bbox.south) * (bbox.east - bbox.west);
      if (area > 0.1) { status('Видимая область слишком велика для загрузки — приблизьте карту.', 'err', 5000); return; }
    }
    const q = GP.graph.overpassQuery(bbox);
    const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
    const btn = $('btnOSM');
    btn.disabled = true;
    let osm = null, lastErr = '';
    for (const url of servers) {
      status('Загрузка данных OSM: ' + esc(new URL(url).host) + '… (может занять до минуты)');
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!j.elements || !j.elements.length) throw new Error(j.remark || 'пустой ответ');
        osm = j;
        break;
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (!osm) {
      status('Не удалось загрузить данные OSM (' + esc(lastErr) + '). ' + (navigator.onLine === false ? 'Нет подключения к интернету.' : 'Серверы Overpass перегружены — повторите позже.'), 'err');
      btn.disabled = false;
      return;
    }
    status('Построение графа…');
    await new Promise((r) => setTimeout(r, 20));
    try {
      const t0 = now();
      const data = GP.graph.buildFromOverpass(osm);
      const g = GP.Graph.fromCompact(data);
      g.loadMs = now() - t0;
      clearAll();
      setGraph(g);
      status('Граф обновлён из OSM: |V| = ' + nf(g.n) + ', |E| = ' + nf(g.m) + ' (данные на ' + esc(fmtDate(data.meta.date)) + '). Сверка с NetworkX относится только к сохранённому снимку.', 'ok', 8000);
    } catch (e) {
      status('Ошибка построения графа: ' + esc(e.message), 'err');
    }
    btn.disabled = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Токен                                                              */
  /* ------------------------------------------------------------------ */
  function openTokenModal() {
    $('tokenInput').value = S.token || '';
    $('tokenErr').hidden = true;
    $('tokenModal').hidden = false;
    setTimeout(() => $('tokenInput').focus(), 50);
  }
  function submitToken() {
    const t = $('tokenInput').value.trim();
    if (!/^pk\.[\w-]+\.[\w-]+$/.test(t)) {
      $('tokenErr').textContent = 'Нужен публичный токен вида pk.xxxxx.yyyyy (секретные токены sk.… в браузере использовать нельзя).';
      $('tokenErr').hidden = false;
      return;
    }
    S.token = t;
    saveToken(t);
    $('tokenModal').hidden = true;
    if (typeof mapboxgl === 'undefined') { mapFallback('Нет подключения к интернету: Mapbox GL JS не загружен.'); return; }
    createMap();
  }

  /* ------------------------------------------------------------------ */
  /*  Запуск                                                             */
  /* ------------------------------------------------------------------ */
  function init() {
    // сценарии
    $('scenarios').innerHTML = config.SCENARIOS.map(([a, b], i) =>
      '<button class="chip" data-i="' + i + '">' + esc(short(config.PLACES[a].name)) + ' → ' + esc(short(config.PLACES[b].name)) + '</button>').join('');
    $('scenarios').addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const [a, c] = config.SCENARIOS[+b.dataset.i];
      setPoint('from', config.PLACES[a].lngLat, config.PLACES[a].name);
      setPoint('to', config.PLACES[c].lngLat, config.PLACES[c].name);
      S.nextPick = 'from';
      computeRoute();
    });
    setupSuggest('inFrom', 'sugFrom', 'from');
    setupSuggest('inTo', 'sugTo', 'to');
    $('btnSwap').onclick = () => {
      const f = S.from, t = S.to;
      S.from = t; S.to = f;
      $('inFrom').value = S.from ? S.from.label : '';
      $('inTo').value = S.to ? S.to.label : '';
      placeMarker('from'); placeMarker('to');
      if (S.from && S.to) computeRoute();
    };
    document.querySelectorAll('input[name=crit]').forEach((r) =>
      r.addEventListener('change', () => { S.crit = r.value; if (S.last) computeRoute(); }));
    $('btnRoute').onclick = computeRoute;
    $('btnFW').onclick = runFW;
    $('btnAnim').onclick = startAnimation;
    $('btnGraph').onclick = toggleGraph;
    $('btnClear').onclick = clearAll;
    $('btnTutorial').onclick = openTutorial;
    $('btnExternal').onclick = externalCheck;
    $('btnExp').onclick = runExperiment;
    $('btnTest').onclick = runSelfTest;
    $('btnOSM').onclick = refreshOSM;
    $('btnSnapshot').onclick = () => { clearAll(); setGraph(S.snapshot); };
    $('btnToken').onclick = openTokenModal;
    $('btnFallbackToken').onclick = openTokenModal;
    $('tokenOk').onclick = submitToken;
    $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitToken(); });
    $('tokenSkip').onclick = () => { $('tokenModal').hidden = true; };
    $('tutClose').onclick = closeTutorial;
    $('tutNext').onclick = () => tutStep(1);
    $('tutPrev').onclick = () => tutStep(-1);
    $('tutReset').onclick = () => { tut.k = 0; renderTutorial(); };
    $('tutPlay').onclick = tutPlay;
    $('tutModal').addEventListener('click', (e) => { if (e.target.id === 'tutModal') closeTutorial(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (!$('tutModal').hidden) closeTutorial(); }
      if (!$('tutModal').hidden) { if (e.key === 'ArrowRight') tutStep(1); if (e.key === 'ArrowLeft') tutStep(-1); }
    });
    window.addEventListener('offline', () => status('Нет подключения к интернету: карта и поиск мест могут быть недоступны. Расчёты работают по снимку графа.', 'err'));

    loadSnapshot();
    initMap();
  }
  function short(name) {
    return name.replace(/^ТРЦ\s+/, '').replace(/\s*\(.*\)$/, '').replace(', главный корпус', '').replace('Ж/д вокзал Минск-Пассажирский', 'Вокзал');
  }

  init();
})();

/*
 * GeoPath — геометрия на поверхности Земли и вспомогательные функции.
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});

  /** Средний радиус Земли (IUGG), м. */
  const R = 6371008.8;
  const RAD = Math.PI / 180;

  /**
   * Расстояние по дуге большого круга (формула гаверсинусов):
   *   d = 2R · arcsin( √( sin²(Δφ/2) + cos φ₁ · cos φ₂ · sin²(Δλ/2) ) )
   * φ — широта, λ — долгота (градусы на входе, радианы внутри). Результат в метрах.
   */
  function haversine(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * RAD, p2 = lat2 * RAD;
    const dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
    const s1 = Math.sin(dp / 2), s2 = Math.sin(dl / 2);
    let a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
    if (a > 1) a = 1;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /** Округление координаты до 6 знаков (≈ 0,1 м) — так хранится снимок графа. */
  function round6(x) {
    return Math.round(x * 1e6) / 1e6;
  }

  /**
   * Генератор псевдослучайных чисел mulberry32 с фиксированным seed.
   * Нужен для воспроизводимости эксперимента: тот же seed → те же пары вершин.
   */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Целое из [0, n) по генератору r. */
  function randInt(r, n) {
    return Math.floor(r() * n);
  }

  const geo = { R, haversine, round6, rng, randInt };
  GP.geo = geo;
  if (typeof module !== 'undefined' && module.exports) module.exports = geo;
})(typeof window !== 'undefined' ? window : globalThis);

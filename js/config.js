/*
 * GeoPath — конфигурация.
 * Работает и в браузере (window.GeoPath.config), и в Node (module.exports).
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});

  const config = {
    // Публичный токен Mapbox (pk....). Если пусто — при старте будет предложено ввести его,
    // введённый токен сохраняется в localStorage браузера.
    MAPBOX_TOKEN: '',

    MAP_STYLE: 'mapbox://styles/mapbox/light-v11',

    // Рамка Минска (в пределах МКАД): юг, запад, север, восток.
    BBOX: { south: 53.835, west: 27.405, north: 53.975, east: 27.705 },
    CENTER: [27.555, 53.905], // [lon, lat]

    // Классы дорог OSM, входящие в граф (п. 2.2 ТЗ).
    HIGHWAYS: [
      'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
      'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
      'residential', 'living_street',
    ],

    // Типовые скорости (км/ч) при отсутствии тега maxspeed — допущение модели (п. 2.3 ТЗ).
    SPEEDS: {
      motorway: 90, trunk: 70, primary: 60, secondary: 50, tertiary: 40,
      unclassified: 30, residential: 25, living_street: 10,
      motorway_link: 40, trunk_link: 40, primary_link: 35, secondary_link: 35, tertiary_link: 30,
    },
    MAX_SPEED_KMH: 110, // верхняя граница для тега maxspeed

    // Генератор пар вычислительного эксперимента (фиксированный seed → воспроизводимость).
    EXPERIMENT_SEED: 20261121,
    EXPERIMENT_MIN_STRAIGHT_M: 300,

    // Готовые сценарии. Координаты: [lon, lat] (проверены по Nominatim/OSM, см. README).
    PLACES: {
      dana: { name: 'ТРЦ Dana Mall', lngLat: [27.6521, 53.9336] },
      arena: { name: 'ТРЦ Arena City', lngLat: [27.4886, 53.9379] },
      malinovka: { name: 'ст. м. «Малиновка»', lngLat: [27.4757, 53.8490] },
      galleria: { name: 'ТРЦ Galleria Minsk', lngLat: [27.5485, 53.9085] },
      vokzal: { name: 'Ж/д вокзал Минск-Пассажирский', lngLat: [27.5507, 53.8908] },
      bntu: { name: 'БНТУ, главный корпус (пр. Независимости, 65)', lngLat: [27.5934, 53.9212] },
    },
    SCENARIOS: [
      ['dana', 'arena'],
      ['arena', 'malinovka'],
      ['galleria', 'vokzal'],
      ['bntu', 'dana'],
    ],
  };

  GP.config = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})(typeof window !== 'undefined' ? window : globalThis);

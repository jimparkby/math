/*
 * Шаг сборки на Vercel: создаёт js/token.js из переменной окружения MAPBOX_TOKEN,
 * чтобы токен не хранился в репозитории.   node tools/write_token.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const token = (process.env.MAPBOX_TOKEN || '').trim();
fs.writeFileSync(
  path.join(__dirname, '..', 'js', 'token.js'),
  'window.GEOPATH_MAPBOX_TOKEN = ' + JSON.stringify(token) + ';\n'
);
console.log(token ? 'js/token.js: токен Mapbox записан' : 'js/token.js: переменная MAPBOX_TOKEN не задана — токен будет запрошен в браузере');

/*
 * GeoPath — вычислительный эксперимент из командной строки (тот же код, что в браузере).
 *   node tools/run_experiment.js [пар=100] [dist|time]
 * Результат: results/experiment_<критерий>_seed<seed>_<пар>.csv и .tsv
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const config = require(path.join(ROOT, 'js/config.js'));
const G = require(path.join(ROOT, 'js/graph.js'));
const E = require(path.join(ROOT, 'js/experiment.js'));

const pairs = parseInt(process.argv[2] || '100', 10);
const weight = process.argv[3] === 'time' ? 'time' : 'dist';
const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'data/minsk-graph.js'), 'utf8'), sb);
const g = G.Graph.fromCompact(sb.window.MINSK_GRAPH);

(async () => {
  const t0 = Date.now();
  const res = await E.run(g, {
    pairs, weight, seed: config.EXPERIMENT_SEED,
    onProgress: (i, n) => process.stdout.write('\rпара ' + i + ' / ' + n),
  });
  console.log('\nГотово за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с; ' + res.header.browser);
  const dir = path.join(ROOT, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, 'experiment_' + weight + '_seed' + res.header.seed + '_' + pairs);
  fs.writeFileSync(base + '.csv', E.toCSV(res));
  fs.writeFileSync(base + '.tsv', E.toTSV(res));
  console.log(E.toTSV(res));
  console.log('Записано: ' + base + '.csv / .tsv');
})();

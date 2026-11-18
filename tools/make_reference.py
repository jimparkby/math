#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GeoPath — эталонные расстояния NetworkX для самопроверки (п. 4.2 ТЗ).

Загружает тот же граф (JSON-часть data/minsk-graph.js), выбирает 200 случайных пар
вершин (seed фиксирован) и считает networkx.dijkstra_path_length по обоим весам.
Результат: data/reference.js  →  window.REFERENCE = [{s, t, dist, time}, ...]

Параллельные дуги (две дуги u→v) в nx.DiGraph сливаются: берётся минимальный вес
по каждому критерию отдельно — на длины кратчайших путей это не влияет.

Запуск:  pip install networkx ;  python tools/make_reference.py
"""
import json
import os
import random
import time

import networkx as nx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = 20261121
PAIRS = 200


def load_graph_js(path):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    i = text.index('window.MINSK_GRAPH = ') + len('window.MINSK_GRAPH = ')
    j = text.rindex(';')
    return json.loads(text[i:j])


def main():
    data = load_graph_js(os.path.join(ROOT, 'data', 'minsk-graph.js'))
    e = data['edges']
    n = len(data['lat'])
    G = nx.DiGraph()
    G.add_nodes_from(range(n))
    for u, v, d, t in zip(e['from'], e['to'], e['dist'], e['time']):
        if G.has_edge(u, v):
            a = G[u][v]
            a['dist'] = min(a['dist'], d)
            a['time'] = min(a['time'], t)
        else:
            G.add_edge(u, v, dist=d, time=t)
    print('NetworkX %s: |V| = %d, |E| (без параллельных) = %d' % (nx.__version__, G.number_of_nodes(), G.number_of_edges()))

    rnd = random.Random(SEED)
    out = []
    t0 = time.time()
    while len(out) < PAIRS:
        s, t = rnd.randrange(n), rnd.randrange(n)
        if s == t:
            continue
        out.append({
            's': s, 't': t,
            'dist': nx.dijkstra_path_length(G, s, t, weight='dist'),
            'time': nx.dijkstra_path_length(G, s, t, weight='time'),
        })
    print('%d пар посчитано за %.1f с' % (len(out), time.time() - t0))

    meta = {'seed': SEED, 'pairs': PAIRS, 'networkx': nx.__version__, 'graphDate': data['meta']['date'],
            'v': n, 'e': len(e['from'])}
    path = os.path.join(ROOT, 'data', 'reference.js')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('/* Сгенерировано tools/make_reference.py (NetworkX dijkstra_path_length). */\n')
        f.write('window.REFERENCE_META = ' + json.dumps(meta, ensure_ascii=False) + ';\n')
        f.write('window.REFERENCE = ' + json.dumps(out, separators=(',', ':')) + ';\n')
    print('Записано', path)


if __name__ == '__main__':
    main()

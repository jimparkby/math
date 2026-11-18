#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GeoPath — построение графа дорожной сети Минска из OpenStreetMap.

    Overpass API → фильтрация (п. 2.2) → дуги с весами (п. 2.3) → упрощение (п. 2.4)
    → наибольшая компонента сильной связности (п. 2.6) → data/minsk-graph.js

Логика повторяет js/graph.js (buildFromOverpass) шаг в шаг, поэтому на одном и том же
ответе Overpass оба построителя дают одинаковые |V| и |E| (проверяет tests/algorithms.test.js).

Запуск:
    python tools/build_graph.py                       # скачать данные и построить граф
    python tools/build_graph.py --input data/raw/overpass_minsk.json   # построить из сохранённого ответа
Только стандартная библиотека Python 3.8+.
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BBOX = (53.835, 27.405, 53.975, 27.705)  # юг, запад, север, восток
HIGHWAYS = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
    'residential', 'living_street',
]
# Типовые скорости, км/ч (те же, что в js/config.js)
SPEEDS = {
    'motorway': 90, 'trunk': 70, 'primary': 60, 'secondary': 50, 'tertiary': 40,
    'unclassified': 30, 'residential': 25, 'living_street': 10,
    'motorway_link': 40, 'trunk_link': 40, 'primary_link': 35, 'secondary_link': 35, 'tertiary_link': 30,
}
MAX_SPEED_KMH = 110
SERVERS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

R = 6371008.8  # средний радиус Земли, м
RAD = math.pi / 180


def haversine(lat1, lon1, lat2, lon2):
    """d = 2R·arcsin(√(sin²(Δφ/2) + cos φ₁·cos φ₂·sin²(Δλ/2))) — тот же порядок операций, что в js/geo.js."""
    p1 = lat1 * RAD
    p2 = lat2 * RAD
    dp = (lat2 - lat1) * RAD
    dl = (lon2 - lon1) * RAD
    s1 = math.sin(dp / 2)
    s2 = math.sin(dl / 2)
    a = s1 * s1 + math.cos(p1) * math.cos(p2) * s2 * s2
    if a > 1:
        a = 1
    return 2 * R * math.asin(math.sqrt(a))


def js_round(x):
    """Math.round из JavaScript (половина — вверх)."""
    return math.floor(x + 0.5)


def round6(x):
    return js_round(x * 1e6) / 1e6


def ceil3(x):
    return math.ceil(x * 1000) / 1000


def ceil4(x):
    return math.ceil(x * 10000) / 10000


def way_speed(tags):
    ms = tags.get('maxspeed')
    if isinstance(ms, str):
        m = re.match(r'^\s*(\d+(?:\.\d+)?)', ms)
        if m:
            v = float(m.group(1))
            if re.search('mph', ms, re.I):
                v *= 1.609344
            if v > 0:
                return min(v, MAX_SPEED_KMH)
    return SPEEDS[tags['highway']]


def way_direction(tags):
    ow = tags.get('oneway')
    if ow in ('yes', '1', 'true'):
        return 1
    if ow in ('-1', 'reverse'):
        return -1
    if ow == 'no':
        return 0
    if tags.get('junction') in ('roundabout', 'circular') or tags.get('highway') == 'motorway':
        return 1
    return 0


def way_accepted(tags, hw):
    if not tags or tags.get('highway') not in hw:
        return False
    if tags.get('access') in ('no', 'private'):
        return False
    if tags.get('motor_vehicle') in ('no', 'private'):
        return False
    if tags.get('area') == 'yes':
        return False
    return True


def tarjan_scc(n, start, adj):
    """Итеративный алгоритм Тарьяна (без рекурсии)."""
    index = [-1] * n
    low = [0] * n
    on_stack = [False] * n
    stack = []
    comp = [-1] * n
    idx = 0
    count = 0
    for s in range(n):
        if index[s] != -1:
            continue
        index[s] = low[s] = idx
        idx += 1
        stack.append(s)
        on_stack[s] = True
        cs = [[s, start[s]]]
        while cs:
            top = cs[-1]
            v, p = top
            if p < start[v + 1]:
                top[1] += 1
                w = adj[p]
                if index[w] == -1:
                    index[w] = low[w] = idx
                    idx += 1
                    stack.append(w)
                    on_stack[w] = True
                    cs.append([w, start[w]])
                elif on_stack[w] and index[w] < low[v]:
                    low[v] = index[w]
            else:
                if low[v] == index[v]:
                    while True:
                        w = stack.pop()
                        on_stack[w] = False
                        comp[w] = count
                        if w == v:
                            break
                    count += 1
                cs.pop()
                if cs:
                    u = cs[-1][0]
                    if low[v] < low[u]:
                        low[u] = low[v]
    return comp, count


def build(osm, simplify=True, scc=True, round_weights=True):
    hw = set(HIGHWAYS)
    node_lat, node_lon = {}, {}
    for el in osm['elements']:
        if el['type'] == 'node':
            node_lat[el['id']] = round6(el['lat'])
            node_lon[el['id']] = round6(el['lon'])

    seg_a, seg_b, seg_dir, seg_speed, seg_dist = [], [], [], [], []
    for el in osm['elements']:
        if el['type'] != 'way' or not way_accepted(el.get('tags'), hw):
            continue
        tags = el['tags']
        d = way_direction(tags)
        sp = way_speed(tags)
        nd = el['nodes']
        for i in range(len(nd) - 1):
            a, b = nd[i], nd[i + 1]
            if a == b or a not in node_lat or b not in node_lat:
                continue
            seg_a.append(a); seg_b.append(b); seg_dir.append(d); seg_speed.append(sp)
            seg_dist.append(haversine(node_lat[a], node_lon[a], node_lat[b], node_lon[b]))
    S = len(seg_a)

    inc = {}
    for s in range(S):
        for x in (seg_a[s], seg_b[s]):
            inc.setdefault(x, []).append(s)
    v_raw = len(inc)
    e_raw = sum(2 if d == 0 else 1 for d in seg_dir)

    def flow_at(s, v):
        if seg_dir[s] == 0:
            return 0
        st = seg_a[s] if seg_dir[s] > 0 else seg_b[s]
        return 1 if st == v else -1

    def other(s, v):
        return seg_b[s] if seg_a[s] == v else seg_a[s]

    node_ids = sorted(inc.keys())
    removable = {}
    for v in node_ids:
        r = False
        if simplify:
            l = inc[v]
            if len(l) == 2:
                s1, s2 = l
                if other(s1, v) != other(s2, v) and seg_speed[s1] == seg_speed[s2]:
                    f1, f2 = flow_at(s1, v), flow_at(s2, v)
                    r = (f1 == 0 and f2 == 0) or f1 * f2 == -1
        removable[v] = r

    used = bytearray(S)
    chains = []

    def walk(k, s0):
        nodes = [k]
        cur, s, dist, direction = k, s0, 0.0, None
        while True:
            used[s] = 1
            o = other(s, cur)
            dist += seg_dist[s]
            if direction is None:
                direction = flow_at(s, cur)
            nodes.append(o)
            cur = o
            if not removable[cur]:
                break
            l = inc[cur]
            nxt = l[1] if l[0] == s else l[0]
            if used[nxt]:
                break
            s = nxt
        chains.append((k, cur, nodes, direction, seg_speed[s0], dist))

    for v in node_ids:
        if removable[v]:
            continue
        for s in inc[v]:
            if not used[s]:
                walk(v, s)
    for v in node_ids:
        if not removable[v]:
            continue
        l = inc[v]
        if any(not used[s] for s in l):
            removable[v] = False
            for s in l:
                if not used[s]:
                    walk(v, s)

    arcs = []  # [u, v, dist, time, interior]
    for a, b, nodes, d, sp, dist_sum in chains:
        if a == b:
            continue
        vms = sp / 3.6
        dist = ceil3(dist_sum) if round_weights else dist_sum
        tm = ceil4(dist / vms) if round_weights else dist_sum / vms
        interior = nodes[1:-1]
        if d >= 0:
            arcs.append([a, b, dist, tm, interior])
        if d <= 0:
            arcs.append([b, a, dist, tm, interior[::-1]])
    vset = set()
    for a in arcs:
        vset.add(a[0]); vset.add(a[1])
    v_simple, e_simple = len(vset), len(arcs)

    ids = sorted(vset)
    scc_size, scc_count = len(ids), 1
    if scc and ids:
        pos = {x: i for i, x in enumerate(ids)}
        n = len(ids)
        start = [0] * (n + 1)
        for a in arcs:
            start[pos[a[0]] + 1] += 1
        for u in range(n):
            start[u + 1] += start[u]
        fill = start[:n]
        adj = [0] * len(arcs)
        for a in arcs:
            u = pos[a[0]]
            adj[fill[u]] = pos[a[1]]
            fill[u] += 1
        comp, count = tarjan_scc(n, start, adj)
        size = [0] * count
        for c in comp:
            size[c] += 1
        best = 0
        for c in range(1, count):
            if size[c] > size[best]:
                best = c
        scc_size, scc_count = size[best], count
        ids = [x for i, x in enumerate(ids) if comp[i] == best]
        keep = set(ids)
        arcs = [a for a in arcs if a[0] in keep and a[1] in keep]

    index = {x: i for i, x in enumerate(ids)}
    arcs.sort(key=lambda a: (index[a[0]], index[a[1]], a[2], a[3]))
    e_from, e_to, e_dist, e_time, g_off, g_coords = [], [], [], [], [0], []
    for a in arcs:
        e_from.append(index[a[0]]); e_to.append(index[a[1]]); e_dist.append(a[2]); e_time.append(a[3])
        for nid in a[4]:
            g_coords.append(int(js_round(node_lon[nid] * 1e6)))
            g_coords.append(int(js_round(node_lat[nid] * 1e6)))
        g_off.append(len(g_coords))
    date = (osm.get('osm3s') or {}).get('timestamp_osm_base')
    return {
        'meta': {
            'date': date,
            'bbox': list(BBOX),
            'source': '© OpenStreetMap contributors, ODbL',
            'vRaw': v_raw, 'eRaw': e_raw, 'vSimple': v_simple, 'eSimple': e_simple,
            'v': len(ids), 'e': len(arcs), 'scc': scc_size, 'sccCount': scc_count,
            'builder': 'build_graph.py',
        },
        'osmId': ids,
        'lat': [node_lat[x] for x in ids],
        'lon': [node_lon[x] for x in ids],
        'edges': {'from': e_from, 'to': e_to, 'dist': e_dist, 'time': e_time,
                  'geomOffsets': g_off, 'geomCoords': g_coords},
    }


def overpass_query(b):
    return ('[out:json][timeout:300];way["highway"~"^(' + '|'.join(HIGHWAYS) + ')$"]('
            + ','.join(str(x) for x in b) + ');(._;>;);out body qt;')


def fetch(b, save_to):
    q = overpass_query(b)
    data = urllib.parse.urlencode({'data': q}).encode()
    wait = 10
    for attempt in range(8):
        for url in SERVERS:
            try:
                print('Запрос к', url, '...', flush=True)
                req = urllib.request.Request(url, data=data, headers={'User-Agent': 'GeoPath-research/1.0'})
                with urllib.request.urlopen(req, timeout=600) as resp:
                    raw = resp.read()
                osm = json.loads(raw)
                if 'elements' in osm and len(osm['elements']) > 1000 and 'remark' not in osm:
                    with open(save_to, 'wb') as f:
                        f.write(raw)
                    return osm
                print('  неполный ответ:', osm.get('remark'))
            except Exception as e:  # noqa
                print('  ошибка:', e)
        print('Повтор через', wait, 'с')
        time.sleep(wait)
        wait = min(wait * 2, 120)
    sys.exit('Не удалось получить данные Overpass')


def main():
    ap = argparse.ArgumentParser(description='Overpass → граф → data/minsk-graph.js')
    ap.add_argument('--input', help='сохранённый ответ Overpass (JSON)')
    ap.add_argument('--output', default=os.path.join(ROOT, 'data', 'minsk-graph.js'))
    args = ap.parse_args()

    if args.input:
        with open(args.input, encoding='utf-8') as f:
            osm = json.load(f)
    else:
        os.makedirs(os.path.join(ROOT, 'data', 'raw'), exist_ok=True)
        osm = fetch(BBOX, os.path.join(ROOT, 'data', 'raw', 'overpass_minsk.json'))

    t0 = time.time()
    g = build(osm)
    m = g['meta']
    print('Снимок OSM: %s' % m['date'])
    print('|V| сырой = %d, |E| сырой = %d' % (m['vRaw'], m['eRaw']))
    print('|V| после упрощения = %d, |E| = %d' % (m['vSimple'], m['eSimple']))
    print('Компонент сильной связности: %d; наибольшая: |V| = %d, |E| = %d' % (m['sccCount'], m['v'], m['e']))
    with open(args.output, 'w', encoding='utf-8') as f:
        f.write('/* Сгенерировано tools/build_graph.py. Данные © OpenStreetMap contributors, ODbL. */\n')
        f.write('window.MINSK_GRAPH = ')
        json.dump(g, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('Записано %s (%.1f МБ) за %.1f с' % (args.output, os.path.getsize(args.output) / 1e6, time.time() - t0))


if __name__ == '__main__':
    main()

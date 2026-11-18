/*
 * GeoPath — двоичная минимальная куча (очередь с приоритетами) на типизированных массивах.
 *
 * Ключ — Float64 (оценка расстояния), значение — Int32 (номер вершины).
 * «Ленивое удаление»: при улучшении оценки вершина добавляется повторно, а устаревшие
 * записи пропускаются при извлечении (проверка done[u] в алгоритме).
 * Сложность push / pop — O(log n).
 */
(function (root) {
  'use strict';
  const GP = (root.GeoPath = root.GeoPath || {});

  class MinHeap {
    constructor(capacity) {
      this.cap = Math.max(16, capacity | 0);
      this.keys = new Float64Array(this.cap);
      this.vals = new Int32Array(this.cap);
      this.size = 0;
      this.ops = 0; // число операций push + pop (для статистики алгоритмов)
    }

    clear() {
      this.size = 0;
      this.ops = 0;
    }

    _grow() {
      const cap = this.cap * 2;
      const k = new Float64Array(cap);
      const v = new Int32Array(cap);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
      this.cap = cap;
    }

    /** Добавить (key, val): просеивание вверх. */
    push(key, val) {
      if (this.size === this.cap) this._grow();
      const keys = this.keys, vals = this.vals;
      let i = this.size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p];
        vals[i] = vals[p];
        i = p;
      }
      keys[i] = key;
      vals[i] = val;
      this.ops++;
    }

    /** Минимальный ключ (без извлечения). */
    peekKey() {
      return this.keys[0];
    }

    peekVal() {
      return this.vals[0];
    }

    /** Извлечь значение с минимальным ключом: просеивание вниз. Ключ доступен в this.lastKey. */
    pop() {
      const keys = this.keys, vals = this.vals;
      const topVal = vals[0];
      this.lastKey = keys[0];
      const n = --this.size;
      this.ops++;
      if (n > 0) {
        const key = keys[n], val = vals[n];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && keys[c + 1] < keys[c]) c++;
          if (keys[c] >= key) break;
          keys[i] = keys[c];
          vals[i] = vals[c];
          i = c;
        }
        keys[i] = key;
        vals[i] = val;
      }
      return topVal;
    }
  }

  GP.MinHeap = MinHeap;
  if (typeof module !== 'undefined' && module.exports) module.exports = { MinHeap };
})(typeof window !== 'undefined' ? window : globalThis);

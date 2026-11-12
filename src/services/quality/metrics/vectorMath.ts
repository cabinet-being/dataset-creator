/** Returns an L2-normalized Float64 copy, or null for empty / zero vectors. */
export const normalizeVector = (vector: ArrayLike<number> | undefined): Float64Array | null => {
  if (!vector || !vector.length) return null;
  let length = 0;
  for (let index = 0; index < vector.length; index += 1) length += vector[index] * vector[index];
  length = Math.sqrt(length);
  if (!Number.isFinite(length) || length === 0) return null;
  const result = new Float64Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) result[index] = vector[index] / length;
  return result;
};

export const dot = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  let value = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) value += left[index] * right[index];
  return value;
};

export const toFloat32 = (vector: Float64Array): Float32Array => Float32Array.from(vector);

export const median = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Eigenvalues of a real symmetric matrix (Householder tridiagonalization +
 * implicit QL). The input rows are overwritten.
 */
export const symmetricEigenvalues = (matrix: Float64Array[]): number[] => {
  const n = matrix.length;
  if (n === 0) return [];
  if (n === 1) return [matrix[0][0]];
  const a = matrix;
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  for (let i = n - 1; i > 0; i -= 1) {
    const l = i - 1;
    let h = 0;
    if (l > 0) {
      let scale = 0;
      for (let k = 0; k <= l; k += 1) scale += Math.abs(a[i][k]);
      if (scale === 0) {
        e[i] = a[i][l];
      } else {
        for (let k = 0; k <= l; k += 1) { a[i][k] /= scale; h += a[i][k] * a[i][k]; }
        let f = a[i][l];
        let g = f >= 0 ? -Math.sqrt(h) : Math.sqrt(h);
        e[i] = scale * g;
        h -= f * g;
        a[i][l] = f - g;
        f = 0;
        for (let j = 0; j <= l; j += 1) {
          g = 0;
          for (let k = 0; k <= j; k += 1) g += a[j][k] * a[i][k];
          for (let k = j + 1; k <= l; k += 1) g += a[k][j] * a[i][k];
          e[j] = g / h;
          f += e[j] * a[i][j];
        }
        const hh = f / (h + h);
        for (let j = 0; j <= l; j += 1) {
          f = a[i][j];
          g = e[j] - hh * f;
          e[j] = g;
          for (let k = 0; k <= j; k += 1) a[j][k] -= f * e[k] + g * a[i][k];
        }
      }
    } else {
      e[i] = a[i][l];
    }
    d[i] = h;
  }
  for (let i = 0; i < n; i += 1) d[i] = a[i][i];
  for (let i = 1; i < n; i += 1) e[i - 1] = e[i];
  e[n - 1] = 0;
  for (let l = 0; l < n; l += 1) {
    let iterations = 0;
    let m: number;
    do {
      for (m = l; m < n - 1; m += 1) {
        const dd = Math.abs(d[m]) + Math.abs(d[m + 1]);
        if (Math.abs(e[m]) <= Number.EPSILON * dd) break;
      }
      if (m !== l) {
        if (iterations++ >= 60) break;
        let g = (d[l + 1] - d[l]) / (2 * e[l]);
        let r = Math.hypot(g, 1);
        g = d[m] - d[l] + e[l] / (g + (g >= 0 ? r : -r));
        let s = 1; let c = 1; let p = 0;
        let underflow = false;
        for (let i = m - 1; i >= l; i -= 1) {
          const f = s * e[i];
          const b = c * e[i];
          r = Math.hypot(f, g);
          e[i + 1] = r;
          if (r === 0) { d[i + 1] -= p; e[m] = 0; underflow = true; break; }
          s = f / r; c = g / r;
          g = d[i + 1] - p;
          r = (d[i] - g) * s + 2 * c * b;
          p = s * r;
          d[i + 1] = g + p;
          g = c * r - b;
        }
        if (underflow) continue;
        d[l] -= p; e[l] = g; e[m] = 0;
      }
    } while (m !== l);
  }
  return Array.from(d);
};

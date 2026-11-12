import { dot, normalizeVector, symmetricEigenvalues } from './vectorMath';

/**
 * Vendi Score: exp of the Shannon entropy of the eigenvalues of K / n, where K
 * is the cosine-similarity matrix. n identical vectors → 1, n orthogonal → n.
 * Zero or missing vectors are ignored.
 */
export const vendiScore = (vectors: readonly (ArrayLike<number> | undefined)[]): number => {
  const rows = vectors.map(normalizeVector).filter((row): row is Float64Array => row !== null);
  const n = rows.length;
  if (n === 0) return 0;
  if (n === 1) return 1;
  const dimension = Math.min(...rows.map((row) => row.length));
  // K = X·Xᵀ (n×n) and Xᵀ·X (d×d) share non-zero eigenvalues; use the smaller one.
  let gram: Float64Array[];
  if (n <= dimension) {
    gram = rows.map(() => new Float64Array(n));
    for (let i = 0; i < n; i += 1) {
      for (let j = i; j < n; j += 1) {
        const value = dot(rows[i], rows[j]);
        gram[i][j] = value; gram[j][i] = value;
      }
    }
  } else {
    gram = Array.from({ length: dimension }, () => new Float64Array(dimension));
    for (const row of rows) {
      for (let i = 0; i < dimension; i += 1) {
        const value = row[i];
        if (value === 0) continue;
        const target = gram[i];
        for (let j = i; j < dimension; j += 1) target[j] += value * row[j];
      }
    }
    for (let i = 0; i < dimension; i += 1) for (let j = 0; j < i; j += 1) gram[i][j] = gram[j][i];
  }
  const eigenvalues = symmetricEigenvalues(gram).map((value) => Math.max(0, value / n));
  const total = eigenvalues.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const value of eigenvalues) {
    const p = value / total;
    if (p > 1e-12) entropy -= p * Math.log(p);
  }
  return Math.exp(entropy);
};

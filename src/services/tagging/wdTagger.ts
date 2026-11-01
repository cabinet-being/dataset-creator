export type TagCategory = 'rating' | 'general' | 'character' | 'other';

export type SelectedTag = {
  name: string;
  category: TagCategory;
};

export const filterTagPredictions = <T extends { tag: string; score: number }>(
  predictions: T[],
  categories: TagCategory[],
  generalThreshold: number,
  maxTags: number,
  options: { characterThreshold?: number; includeRatings?: boolean } = {}
): T[] => predictions
  .filter((prediction, index) => {
    const category = categories[index] ?? 'general';
    if (category === 'rating' && !options.includeRatings) return false;
    const threshold = category === 'character'
      ? Math.max(generalThreshold, options.characterThreshold ?? 0.85)
      : generalThreshold;
    return prediction.score >= threshold;
  })
  .sort((left, right) => right.score - left.score)
  .slice(0, maxTags);

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (quoted) throw new Error('selected_tags.csv contains an unterminated quoted field.');
  values.push(current.trim());
  return values;
};

export const parseSelectedTagCsv = (csv: string): { rows: SelectedTag[]; hasCategories: boolean } => {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error('selected_tags.csv must contain a header row and at least one tag row.');

  const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const nameIndex = header.indexOf('name');
  const categoryIndex = header.indexOf('category');
  if (nameIndex < 0) throw new Error('selected_tags.csv is missing the required "name" column.');

  const rows = lines.slice(1).map((line, index) => {
    const row = parseCsvLine(line);
    if (row.length !== header.length) {
      throw new Error(`selected_tags.csv row ${index + 2} has ${row.length} fields; expected ${header.length}.`);
    }
    const name = row[nameIndex].trim().toLowerCase().replace(/\s+/g, '_');
    if (!name) throw new Error(`selected_tags.csv row ${index + 2} is missing a tag name.`);

    let category: TagCategory = 'general';
    if (categoryIndex >= 0) {
      const rawCategory = row[categoryIndex].trim();
      if (!/^\d+$/.test(rawCategory)) throw new Error(`selected_tags.csv row ${index + 2} has an invalid category.`);
      const categoryNumber = Number(rawCategory);
      category = categoryNumber === 9 ? 'rating' : categoryNumber === 0 ? 'general' : categoryNumber === 4 ? 'character' : 'other';
    }
    return { name, category };
  });
  return { rows, hasCategories: categoryIndex >= 0 };
};

export const parseSelectedTagRows = (csv: string): SelectedTag[] => parseSelectedTagCsv(csv).rows;

/** Copies canvas RGBA pixels into a float tensor in the requested model channel order. */
export const packImageChannels = (
  rgba: ArrayLike<number>,
  pixelCount: number,
  layout: 'nhwc' | 'nchw',
  channelOrder: 'rgb' | 'bgr'
): Float32Array => {
  const data = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    const first = rgba[sourceIndex + (channelOrder === 'rgb' ? 0 : 2)];
    const middle = rgba[sourceIndex + 1];
    const last = rgba[sourceIndex + (channelOrder === 'rgb' ? 2 : 0)];
    if (layout === 'nhwc') {
      const targetIndex = pixelIndex * 3;
      data[targetIndex] = first;
      data[targetIndex + 1] = middle;
      data[targetIndex + 2] = last;
    } else {
      data[pixelIndex] = first;
      data[pixelCount + pixelIndex] = middle;
      data[pixelCount * 2 + pixelIndex] = last;
    }
  }
  return data;
};

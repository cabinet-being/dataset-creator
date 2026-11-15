export const parseTags = (value: string): string[] => {
  const seen = new Set<string>();
  return value.split(/[\n,]/).map((tag) => tag.trim()).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
};

export const sameTags = (left: string[] | undefined, right: string[]) =>
  left !== undefined && left.length === right.length && left.every((tag, index) => tag === right[index]);

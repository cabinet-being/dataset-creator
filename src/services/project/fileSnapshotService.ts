export const snapshotFile = async (file: File): Promise<File> => {
  const buffer = await file.arrayBuffer();
  return new File([buffer], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
};

export const snapshotFileIfNeeded = async (blob: Blob): Promise<Blob> => {
  if (!(blob instanceof File)) {
    return blob;
  }

  return snapshotFile(blob);
};

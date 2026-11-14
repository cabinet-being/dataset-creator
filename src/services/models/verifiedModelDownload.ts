export type VerifiedModelAsset = { label: string; url: string; bytes: number; sha256: string };
export type ModelDownloadProgress = { phase: string; completed: number; total: number };
export type ModelDownloadMessages = {
  http?: (status: number) => string;
  size?: string;
  incomplete?: string;
  integrity?: string;
};
export type ModelDownloadOptions = {
  signal?: AbortSignal;
  progress?: (progress: ModelDownloadProgress) => void;
  /** Bytes received so far for this asset (for callers combining several files). */
  onBytes?: (received: number) => void;
  phase?: string;
  messages?: ModelDownloadMessages;
};

export const sha256Hex = async (buffer: ArrayBuffer): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const verifyModelAsset = async (buffer: ArrayBuffer, asset: Pick<VerifiedModelAsset, 'label' | 'bytes' | 'sha256'>, message?: string): Promise<void> => {
  const hash = await sha256Hex(buffer);
  if (buffer.byteLength !== asset.bytes || hash !== asset.sha256) throw new Error(message ?? `${asset.label} failed its integrity check. Download it again.`);
};

export const downloadVerifiedModelAsset = async (asset: VerifiedModelAsset, options: ModelDownloadOptions = {}): Promise<ArrayBuffer> => {
  const { signal, progress, onBytes, messages } = options;
  const response = await fetch(asset.url, { signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error(messages?.http?.(response.status) ?? `${asset.label} download failed (${response.status}).`);
  const buffer = new Uint8Array(asset.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > buffer.byteLength) throw new Error(messages?.size ?? `Unexpected ${asset.label} size.`);
      buffer.set(value, offset);
      offset += value.byteLength;
      onBytes?.(offset);
      progress?.({ phase: options.phase ?? `Downloading ${asset.label}`, completed: offset, total: asset.bytes });
    }
  } finally { await reader.cancel(); }
  if (offset !== buffer.byteLength) throw new Error(messages?.incomplete ?? `Incomplete ${asset.label} download. Please retry.`);
  await verifyModelAsset(buffer.buffer, asset, messages?.integrity);
  signal?.throwIfAborted();
  return buffer.buffer;
};

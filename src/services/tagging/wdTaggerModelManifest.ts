import type { VerifiedModelAsset } from '../models/verifiedModelDownload';

const repository = 'SmilingWolf/wd-vit-tagger-v3';
const revision = '7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f';
const fileUrl = (file: string) => `https://huggingface.co/${repository}/resolve/${revision}/${file}`;

export type WdTaggerModelManifest = {
  id: string; name: string; repository: string; revision: string;
  license: string; licenseUrl: string; sourceUrl: string;
  files: { model: VerifiedModelAsset; tags: VerifiedModelAsset };
  totalBytes: number;
};

// Chosen on 2026-11-12 as the smallest WD v3 tagger (swinv2 467 MB, convnext 395 MB, eva02/vit-large ~1.26 GB); Apache-2.0.
const files = {
  model: { label: 'model.onnx', url: fileUrl('model.onnx'), bytes: 378536310, sha256: '35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6' },
  tags: { label: 'selected_tags.csv', url: fileUrl('selected_tags.csv'), bytes: 308468, sha256: '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217' },
};

export const WD_TAGGER_MODEL: WdTaggerModelManifest = {
  id: 'wd-vit-tagger-v3',
  name: 'WD ViT Tagger v3',
  repository,
  revision,
  license: 'Apache-2.0',
  licenseUrl: `https://huggingface.co/${repository}/blob/${revision}/README.md`,
  sourceUrl: `https://huggingface.co/${repository}`,
  files,
  totalBytes: files.model.bytes + files.tags.bytes,
};

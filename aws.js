import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = process.env.S3_BUCKET;

const s3 = S3_BUCKET ? new S3Client({ region: AWS_REGION }) : null;
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function imageUploadsConfigured() {
  return !!(s3 && S3_BUCKET);
}

export function nextImageIndex(entity) {
  const base = String(entity?.key || "");
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\.jpg$`, "i");
  let max = 0;

  for (const filename of entity?.images || []) {
    const match = String(filename || "").match(pattern);
    if (!match) continue;
    max = Math.max(max, parseInt(match[1], 10) || 0);
  }

  return max + 1;
}

export function imageFilenameForEntity(entity, index) {
  return `${entity.key}${index}.jpg`;
}

export function imageObjectKeys(list, filename) {
  return {
    originalKey: `${list}/${filename}`,
    thumbKey: `${list}/tn/${filename}`,
  };
}

export function isValidEntityImageFilename(entityKey, filename) {
  const pattern = new RegExp(`^${entityKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+\\.jpg$`, "i");
  return pattern.test(filename);
}

export async function presignImageUploadPair(list, filename) {
  if (!imageUploadsConfigured()) {
    throw new Error("S3 upload not configured");
  }

  const { originalKey, thumbKey } = imageObjectKeys(list, filename);

  const [originalUploadUrl, thumbUploadUrl] = await Promise.all([
    getSignedUrl(s3, new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: originalKey,
      ContentType: "image/jpeg",
      CacheControl: IMAGE_CACHE_CONTROL,
    }), { expiresIn: 60 * 5 }),
    getSignedUrl(s3, new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: thumbKey,
      ContentType: "image/jpeg",
      CacheControl: IMAGE_CACHE_CONTROL,
    }), { expiresIn: 60 * 5 }),
  ]);

  return {
    filename,
    originalKey,
    thumbKey,
    originalUploadUrl,
    thumbUploadUrl,
  };
}

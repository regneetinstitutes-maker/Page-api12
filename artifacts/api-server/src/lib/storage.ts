import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class StorageError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message);
    this.name = "StorageError";
  }
}

function config() {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) throw new StorageError("S3 storage is not configured.");
  return { bucket, region };
}

let client: S3Client | undefined;
function s3() {
  const { region } = config();
  client ??= new S3Client({ region });
  return client;
}

export async function createUploadUrl(input: { key: string; contentType: string; maxBytes: number }) {
  const { bucket } = config();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: input.key,
    ContentType: input.contentType,
    Metadata: { maxBytes: String(input.maxBytes) },
  });
  return getSignedUrl(s3(), command, { expiresIn: 900 });
}

export async function createDownloadUrl(key: string) {
  const { bucket } = config();
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function verifyUploadedObject(input: { key: string; contentTypes: string[]; maxBytes: number }) {
  const { bucket } = config();
  try {
    const object = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }));
    if (!object.ContentType || !input.contentTypes.includes(object.ContentType) || object.ContentLength == null || object.ContentLength > input.maxBytes) {
      throw new StorageError("Uploaded object failed validation.", 400);
    }
    return { contentType: object.ContentType, contentLength: object.ContentLength };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("Uploaded object was not found in storage.", 400);
  }
}

export function competitionObjectKey(type: "omb" | "tournament", id: string, kind: "screenshot" | "voice-note") {
  return `competitions/${type}/${id}/${kind}`;
}

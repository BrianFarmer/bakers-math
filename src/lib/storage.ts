import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export interface Storage {
  ensureBucket(): Promise<void>;
  presignUpload(key: string, contentType: string, bytes: number): Promise<string>;
  presignDownload(key: string): Promise<string>;
  head(key: string): Promise<{ bytes: number; contentType?: string } | null>;
  remove(key: string): Promise<void>;
}

function client(endpoint: string) {
  return new S3Client({
    endpoint,
    region: config.s3.region,
    forcePathStyle: true, // MinIO
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
}

export function createS3Storage(): Storage {
  const internal = client(config.s3.endpoint);
  // Presigned URLs are signed for the host the phone will use, which differs from the
  // container-internal address when running under Docker Compose.
  const publicClient = client(config.s3.publicEndpoint);
  const Bucket = config.s3.bucket;

  return {
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket }));
      }
    },
    presignUpload(key, contentType, bytes) {
      // ContentLength is part of the signature, so the upload must be exactly the declared size.
      return getSignedUrl(publicClient, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: bytes }), {
        expiresIn: config.media.uploadUrlTtlSeconds,
      });
    },
    presignDownload(key) {
      return getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: config.media.downloadUrlTtlSeconds,
      });
    },
    async head(key) {
      try {
        const res = await internal.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { bytes: res.ContentLength ?? 0, contentType: res.ContentType };
      } catch (err: any) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
        throw err;
      }
    },
    async remove(key) {
      await internal.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://bakers:bakers@localhost:5432/bakers_math'),
  jwtSecret: env('JWT_SECRET', 'dev-only-secret-change-me'),
  accessTokenTtlSeconds: Number(env('ACCESS_TOKEN_TTL_SECONDS', '900')),
  refreshTokenTtlDays: Number(env('REFRESH_TOKEN_TTL_DAYS', '30')),
  passwordResetUrl: env('PASSWORD_RESET_URL', 'bakersmath://reset-password'),
  s3: {
    endpoint: env('S3_ENDPOINT', 'http://localhost:9000'),
    publicEndpoint: env('S3_PUBLIC_ENDPOINT', process.env.S3_ENDPOINT ?? 'http://localhost:9000'),
    region: env('S3_REGION', 'us-east-1'),
    bucket: env('S3_BUCKET', 'bakers-math-media'),
    accessKeyId: env('S3_ACCESS_KEY', 'bakers'),
    secretAccessKey: env('S3_SECRET_KEY', 'bakers-secret'),
  },
  media: {
    maxPhotoBytes: 20 * 1024 * 1024,
    maxVideoBytes: 200 * 1024 * 1024,
    maxVideoSeconds: 180,
    uploadUrlTtlSeconds: 60 * 60,
    downloadUrlTtlSeconds: 15 * 60,
  },
};

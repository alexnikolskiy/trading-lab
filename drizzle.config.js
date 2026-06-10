/** @type {import('drizzle-kit').Config} */
export default {
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
};

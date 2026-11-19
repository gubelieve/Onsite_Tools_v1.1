import 'dotenv/config'
import { defineConfig } from '@prisma/config'

// `prisma generate` (postinstall) only needs a syntactically valid URL; it never
// connects. The fallback keeps `npm ci` working on a machine with no .env yet,
// the same trick Lab_management's Dockerfile uses for its build stage.
const url = process.env.DATABASE_URL || 'postgresql://build:build@127.0.0.1:5432/build?schema=public'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url },
})

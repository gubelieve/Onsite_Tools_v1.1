import 'dotenv/config'
import path from 'node:path'
import { defineConfig } from '@prisma/config'

// The database always lives next to the app, so the folder can be copied anywhere.
const url = process.env.DATABASE_URL || `file:${path.join(process.cwd(), 'data', 'onsite.db')}`

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url },
})

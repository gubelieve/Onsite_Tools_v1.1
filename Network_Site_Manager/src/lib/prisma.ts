import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'

// Same client setup as Lab_management: pg pool + PrismaPg adapter, with the
// Postgres schema taken from ?schema= on DATABASE_URL.
//
// Not imported by any page yet — the UI runs on sample data (src/lib/data.ts)
// until a database is provisioned. Import it from data.ts when it is.
const prismaClientSingleton = () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  const schema = new URL(connectionString).searchParams.get('schema') || 'public'
  const pool = new Pool({ connectionString })
  return new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>
} & typeof global

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma

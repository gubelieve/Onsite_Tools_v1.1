import path from "node:path"
import { PrismaClient } from "@prisma/client"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
import { DATA_DIR, ensureDir } from "./paths"

// Local SQLite file next to the app - no database server, no login.
export const DATABASE_URL = process.env.DATABASE_URL || `file:${path.join(DATA_DIR, "onsite.db")}`

const prismaClientSingleton = () => {
  ensureDir(DATA_DIR)
  const adapter = new PrismaBetterSqlite3({ url: DATABASE_URL })
  return new PrismaClient({ adapter })
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>
} & typeof global

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== "production") globalThis.prismaGlobal = prisma

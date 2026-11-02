// LAN mode launcher: next start on 0.0.0.0, but only for browsers that know the access key (src/proxy.ts).
// The key is kept in data/access-key.txt so links keep working after a restart - delete the file for a new one.
//   node scripts/start-lan.mjs          start the server
//   node scripts/start-lan.mjs --key    print the key only (run.bat uses it to open the browser already signed in)
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dataDir = path.join(process.env.ONSITE_BASE_DIR || process.cwd(), "data")
const keyFile = path.join(dataDir, "access-key.txt")

function loadKey() {
  const fromEnv = process.env.ONSITE_ACCESS_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const saved = fs.readFileSync(keyFile, "utf8").trim()
    if (saved) return saved
  } catch { /* first LAN run */ }
  const key = randomBytes(18).toString("base64url")
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(keyFile, key + "\n", { mode: 0o600 })
  return key
}

const key = loadKey()
if (process.argv.includes("--key")) {
  console.log(key)
  process.exit(0)
}

const addresses = Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address)
console.log("\n  LAN mode - other PCs need the access key:")
console.log(`    key  ${key}`)
for (const ip of addresses) console.log(`    open http://${ip}:8090/?key=${key}`)
console.log("  Delete data/access-key.txt to issue a new key.\n")

const next = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next")
const child = spawn(process.execPath, [next, "start", "-H", "0.0.0.0", "-p", "8090"], {
  stdio: "inherit", env: { ...process.env, ONSITE_ACCESS_KEY: key },
})
child.on("exit", (code) => process.exit(code ?? 0))
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig))

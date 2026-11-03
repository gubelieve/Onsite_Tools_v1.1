/**
 * The certificate the built-in HTTPS server presents. Node can make keys but not certificates, so the X.509
 * structure is written out here in DER by hand - a self-signed RSA-2048 / SHA-256 certificate is a few dozen bytes
 * of structure around the key, and pulling in a crypto library for it would be the bigger risk.
 *
 * Kept in data/https/ and reused, so a device that trusted it once keeps trusting it. It is remade only when the
 * address the devices use is not in it (a new site, a new interface) - the trustpoint name carries its fingerprint,
 * so a device always gets the certificate that is actually being served.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { DATA_DIR, ensureDir } from "../paths"
import { localAddresses } from "./firewall"

export interface ServerCert { cert: string; key: string; fingerprint: string; x509: crypto.X509Certificate }

// ------------------------------------------------------------------ DER
const len = (n: number) => n < 0x80 ? Buffer.from([n])
  : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 255]) : Buffer.from([0x83, n >> 16, (n >> 8) & 255, n & 255])
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]) }
const seq = (...p: Buffer[]) => tlv(0x30, ...p)
const set = (...p: Buffer[]) => tlv(0x31, ...p)
const NULL = Buffer.from([0x05, 0x00])
const TRUE = tlv(0x01, Buffer.from([0xff]))
const octets = (b: Buffer) => tlv(0x04, b)
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b)
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"))
const integer = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b)
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner)

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number)
  const out = [40 * a + b]
  for (const n of rest) {
    const chunk = [n & 0x7f]
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** UTCTime until 2049, GeneralizedTime after - what RFC 5280 asks for. */
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z" // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso))
}

const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [TRUE] : []), octets(value))

/** One self-signed certificate for `ips` (subjectAltName), valid for ten years. */
export function makeSelfSigned(ips: string[], commonName = ips[0] ?? "Onsite Tools"): { cert: string; key: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const spki = publicKey.export({ type: "spki", format: "der" })
  const sha256Rsa = seq(oid("1.2.840.113549.1.1.11"), NULL)
  const name = seq(set(seq(oid("2.5.4.3"), utf8(commonName))), set(seq(oid("2.5.4.10"), utf8("Onsite Tools"))))
  const serial = crypto.randomBytes(16)
  serial[0] &= 0x7f
  const now = Date.now()
  const san = seq(...ips.filter((ip) => net.isIPv4(ip)).map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
    tlv(0x82, Buffer.from("localhost")))
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    sha256Rsa,
    name,
    seq(time(new Date(now - 24 * 3600 * 1000)), time(new Date(now + 10 * 365 * 24 * 3600 * 1000))),
    name,
    spki,
    explicit(3, seq(
      // A CA certificate, so "crypto pki authenticate" on a Cisco device accepts it as the root it trusts.
      ext("2.5.29.19", true, seq(TRUE)),
      // digitalSignature, keyEncipherment, keyCertSign
      ext("2.5.29.15", true, bits(Buffer.from([0xa4]), 2)),
      ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
      ext("2.5.29.17", false, san),
      ext("2.5.29.14", false, octets(crypto.createHash("sha1").update(spki).digest())),
    )),
  )
  const der = seq(tbs, sha256Rsa, bits(crypto.sign("sha256", tbs, privateKey)))
  const pem = (label: string, b: Buffer) => `-----BEGIN ${label}-----\n${b.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`
  return { cert: pem("CERTIFICATE", der), key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }
}

const load = (cert: string, key: string): ServerCert => {
  const x509 = new crypto.X509Certificate(cert)
  return { cert, key, x509, fingerprint: x509.fingerprint256.replace(/:/g, "").toLowerCase() }
}

/** The stored certificate when it covers `ip`, otherwise a new one for `ip` and every address of this PC. */
export function serverCert(ip: string, dir = path.join(DATA_DIR, "https")): ServerCert {
  const certFile = path.join(dir, "onsite-tools.crt"), keyFile = path.join(dir, "onsite-tools.key")
  try {
    const stored = load(fs.readFileSync(certFile, "utf8"), fs.readFileSync(keyFile, "utf8"))
    if ((!net.isIPv4(ip) || stored.x509.checkIP(ip)) && new Date(stored.x509.validTo).getTime() > Date.now() + 30 * 24 * 3600 * 1000) return stored
  } catch { /* none yet, or unreadable - make a new one */ }
  const ips = [...new Set([ip, ...localAddresses().map((a) => a.split(" ")[0]), "127.0.0.1"].filter((a) => net.isIPv4(a)))]
  const made = makeSelfSigned(ips, net.isIPv4(ip) ? ip : undefined)
  ensureDir(dir)
  fs.writeFileSync(keyFile, made.key, { encoding: "utf8", mode: 0o600 })
  fs.writeFileSync(certFile, made.cert, "utf8")
  return load(made.cert, made.key)
}

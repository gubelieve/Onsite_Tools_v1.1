// Manual helper: `npx tsx tests/run-fake-device.ts` keeps a fake Cisco device up for end-to-end checks.
import { startFakeDevice } from "./fake-device"

startFakeDevice().then((d) => {
  console.log(`FAKE_DEVICE_PORT=${d.port}`)
  setTimeout(() => d.close().then(() => process.exit(0)), Number(process.env.FAKE_SECONDS ?? 120) * 1000)
})

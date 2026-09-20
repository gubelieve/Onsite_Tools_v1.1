"use client"

import * as React from "react"
import { Button } from "@astryxdesign/core/Button"
import { NumberInput } from "@astryxdesign/core/NumberInput"
import { Selector } from "@astryxdesign/core/Selector"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { updateSettings } from "@/actions/settings"
import { Panel } from "@/components/page-header"
import type { AppSettings } from "@/lib/settings"

export function SettingsForm({ initial, deviceTypes }: { initial: AppSettings; deviceTypes: string[] }) {
  const toast = useToast()
  const [s, setS] = React.useState(initial)
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS((p) => ({ ...p, [k]: v }))
  return (
    <Panel title="Tool defaults">
      <div className="grid max-w-3xl grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
        <TextInput label="Default SSH username" value={s.username} onChange={(v) => set("username", v)} isOptional />
        <Selector label="Default device type" value={s.deviceType} onChange={(v) => set("deviceType", v)} options={deviceTypes.map((t) => ({ value: t, label: t }))} />
        <NumberInput label="Default parallel sessions" value={s.threads} min={1} max={100} onChange={(v) => set("threads", Number(v) || 10)} />
        <NumberInput label="SSH connect timeout (seconds)" value={s.sshTimeout} min={5} max={120} onChange={(v) => set("sshTimeout", Number(v) || 20)} />
        <TextInput label="Default SNMP community (v2c)" type="password" value={s.snmpCommunity} onChange={(v) => set("snmpCommunity", v)} isOptional
          description="Stored in the local database file - leave empty if this PC is shared." />
      </div>
      <div className="mt-5">
        <Button variant="primary" label="Save settings" clickAction={async () => { setS(await updateSettings(s)); toast({ body: "Settings saved" }) }} />
      </div>
    </Panel>
  )
}

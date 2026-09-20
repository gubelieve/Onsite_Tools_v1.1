import { PageHeader } from "@/components/page-header"
import { DEVICE_TYPES } from "@/lib/net/ssh"
import { getSettings } from "@/lib/settings"
import { SettingsForm } from "./settings-form"

export default async function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Defaults that pre-fill the tool forms. Stored in the local database on this PC. Passwords are never stored here." />
      <SettingsForm initial={await getSettings()} deviceTypes={[...DEVICE_TYPES]} />
    </>
  )
}

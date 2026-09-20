/** Tool registry - the single list of tools (menu, pages and API all read from here). */
import { captureDnac, dnacPortAssignment, dnacRestApi, sdWanApi } from "./controller-tools"
import { interfaceReport, securityHealthCheck, snmpInventory } from "./offline-tools"
import { cdpInventory, clientStatusChecker, configDevices, getInventory, lldpInventory, verifySnmpUser } from "./ssh-tools"
import { upgradeIos } from "./upgrade-ios"
import type { PublicTool, ToolDef } from "./types"

export const TOOLS: ToolDef[] = [
  configDevices, upgradeIos, clientStatusChecker,
  getInventory, cdpInventory, lldpInventory, snmpInventory, verifySnmpUser,
  interfaceReport, securityHealthCheck,
  dnacRestApi, dnacPortAssignment, sdWanApi, captureDnac,
].sort((a, b) => a.order - b.order)

export const getTool = (id: string) => TOOLS.find((t) => t.id === id)

export function publicTool(t: ToolDef): PublicTool {
  const { run: _run, ...rest } = t
  void _run
  return rest
}

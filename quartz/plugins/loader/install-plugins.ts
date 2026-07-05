#!/usr/bin/env node
import { installPlugins, parsePluginSource } from "./gitLoader.js"
import fs from "fs"
import path from "path"
import yaml from "yaml"

async function main() {
  const configPath = path.resolve(process.cwd(), "quartz.config.yaml")
  if (!fs.existsSync(configPath)) {
    console.error("quartz.config.yaml not found.")
    process.exit(1)
  }
  const fileContent = fs.readFileSync(configPath, "utf8")
  const quartzConfig = yaml.parse(fileContent)
  const externalPlugins = quartzConfig.plugins
    ?.filter((p: any) => p.enabled !== false)
    ?.map((p: any) => p.source) || []

  if (externalPlugins.length === 0) {
    console.log("No external plugins to install.")
    return
  }

  console.log(`Installing ${externalPlugins.length} plugin(s)...`)

  const specs = externalPlugins.map((source: string) => parsePluginSource(source))
  const installed = await installPlugins(specs, { verbose: true })

  if (installed.size === externalPlugins.length) {
    console.log("✓ All plugins installed successfully")
  } else {
    console.error(`✗ Only ${installed.size}/${externalPlugins.length} plugins installed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Failed to install plugins:", err)
  process.exit(1)
})

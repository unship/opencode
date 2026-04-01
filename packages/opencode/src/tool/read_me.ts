import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./read_me.txt"
import GUIDELINES from "./read_me_guidelines.txt"

const AVAILABLE_MODULES = ["interactive", "chart", "diagram"] as const

export const ReadMeTool = Tool.define("read_me", {
  description: DESCRIPTION,
  parameters: z.object({
    modules: z
      .array(z.enum(AVAILABLE_MODULES))
      .min(1)
      .describe("The module names to load guidelines for: interactive, chart, diagram"),
  }),
  async execute(params) {
    const sections: string[] = []
    const lines = GUIDELINES.split("\n")

    // Always include everything up to the first "## Module:" header
    const firstModuleIdx = lines.findIndex((l: string) => l.startsWith("## Module:"))
    if (firstModuleIdx > 0) {
      sections.push(lines.slice(0, firstModuleIdx).join("\n").trim())
    }

    // Include requested module sections
    for (const mod of params.modules) {
      const header = `## Module: ${mod}`
      const startIdx = lines.findIndex((l: string) => l.startsWith(header))
      if (startIdx < 0) continue
      let endIdx = lines.findIndex((l: string, i: number) => i > startIdx && l.startsWith("## Module:"))
      if (endIdx < 0) endIdx = lines.length
      sections.push(lines.slice(startIdx, endIdx).join("\n").trim())
    }

    return {
      title: `Loaded guidelines: ${params.modules.join(", ")}`,
      output: sections.join("\n\n"),
      metadata: {
        modules: params.modules,
        truncated: false,
      },
    }
  },
})

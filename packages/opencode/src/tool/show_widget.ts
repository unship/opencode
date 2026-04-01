import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./show_widget.txt"

export const ShowWidgetTool = Tool.define("show_widget", {
  description: DESCRIPTION,
  parameters: z.object({
    i_have_seen_read_me: z
      .boolean()
      .describe("Confirm you have called read_me first. Must be true."),
    title: z
      .string()
      .describe("A snake_case identifier for this widget, e.g. fruit_selector, meal_planner"),
    loading_messages: z
      .array(z.string())
      .min(1)
      .max(4)
      .describe("1-4 short messages to show while the widget loads"),
    widget_code: z
      .string()
      .describe("Self-contained HTML fragment: <style>...</style> HTML content <script>...</script>"),
  }),
  async execute(params) {
    if (!params.i_have_seen_read_me) {
      throw new Error(
        "You must call the read_me tool before using show_widget. Set i_have_seen_read_me to true after calling read_me.",
      )
    }

    return {
      title: params.title,
      output: "Widget rendered successfully.",
      metadata: {
        title: params.title,
        loading_messages: params.loading_messages,
        widget_code: params.widget_code,
        truncated: false,
      },
    }
  },
})

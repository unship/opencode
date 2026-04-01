Lazy-load widget design guidelines before using the show_widget tool.

You MUST call this tool before your first use of show_widget in a conversation. The returned guidelines contain the rules, constraints, and host APIs your widget_code must follow.

## Parameters

- modules: An array of module names to load guidelines for. Available modules: "interactive", "chart", "diagram"

Each module returns rules specific to that widget type. Load only what you need to keep context lean.

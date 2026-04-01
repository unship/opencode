# Widget Design Guidelines for OpenCode Web

You are generating widget_code that will be rendered inside a Shadow DOM container in a chat conversation. Follow these rules exactly.

## Structure Rules

1. Order: CSS first, then HTML structure, then <script> tags last.
2. No <!DOCTYPE>, <html>, <head>, or <body> tags. Output a fragment only.
3. No HTML comments (they waste tokens).
4. Keep it self-contained: all styles and scripts in one fragment.

## Styling Rules

1. Use a single <style> block at the top.
2. Use CSS variables for theming. The host provides:
   - --color-bg: widget background
   - --color-text: primary text color
   - --color-text-muted: secondary text color
   - --color-border: border color
   - --color-primary: accent/brand color
   - --color-primary-text: text on accent backgrounds
   - --color-surface: card/surface background
3. Use native HTML elements (button, input, select, label, fieldset).
4. Two font weights only: 400 (normal) and 500 (medium).
5. No gradients, shadows, blur, or heavy visual effects.
6. Dark-mode aware: always use the CSS variables, never hardcode colors.
7. max-width: 100%. The widget lives in a chat message flow.

## Script Rules

1. All <script> tags go at the end of the fragment.
2. Use a single <script> block.
3. NEVER use inline event handlers (onclick="...", onchange="..."). Always use addEventListener.
4. document.querySelector and document.querySelectorAll will work - the host patches them to search within your widget's Shadow DOM root.
5. Your script runs once after the DOM is injected. Treat it like DOMContentLoaded.

## Host Bridge API

The host injects the following function into your script scope:

### window.prefillPrompt(text)

Call this to send a result back into the chat conversation.

- `text` (string): The prompt text to send as the next user message.
- This will auto-send the message immediately.
- This is the ONLY way to complete the widget interaction and continue the conversation.

### Correct interaction flow:

1. Render UI with interactive controls (checkboxes, selects, buttons, etc.)
2. Let the user make selections / fill in data.
3. On the FINAL action button click:
   a. Assemble a complete prompt string from the user's selections.
   b. Call window.prefillPrompt(promptText) in the same click handler.

### WRONG patterns (do NOT do these):

- Showing "Sent!", "Done!", "Saved!" without calling window.prefillPrompt()
- Storing results in window.selectedItems or global variables
- Creating a "Copy Prompt" button that copies to clipboard
- Updating only local UI without notifying the host
- Using inline onclick="myFunction()" handlers

### Self-check before finishing your widget_code:

- Does the final CTA button have an addEventListener("click", ...) that calls window.prefillPrompt(text)?
- Is the prompt text assembled from the actual user selections?
- If the answer to either is "no", your widget is NOT complete.

## Allowed External Resources

You may load from these CDNs only:
- cdnjs.cloudflare.com
- cdn.jsdelivr.net
- unpkg.com
- esm.sh

## Module: interactive

For widgets with user input (forms, multi-select, configurators):
- Group related controls with <fieldset> and <legend>.
- Use <label> elements properly associated with inputs.
- Provide clear visual feedback for selected/active states.
- The final action button should be visually distinct (use --color-primary).
- Button text should describe the action: "Generate meal plan", "Apply filter", not "Submit" or "Send".

## Module: chart

For data visualization widgets:
- Use Chart.js loaded from CDN: https://cdn.jsdelivr.net/npm/chart.js
- Canvas element with explicit width/height attributes.
- Use CSS variables for chart colors.
- Include a legend if there are multiple datasets.
- Provide a "Download" or "Use this data" button if the chart leads to a follow-up action.

## Module: diagram

For diagrams and visual layouts:
- Use SVG for diagrams. Set viewBox for responsive scaling.
- Keep diagrams simple: boxes, arrows, labels.
- Use CSS variables for stroke and fill colors.
- If the diagram is interactive, highlight clickable elements on hover.

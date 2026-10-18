# Browser viewer

Optional, pure UI plugin. Install the shipped package with `file:./bundled-plugins/browser-ui`
using the existing plugin installer. It adds a **Browser** tab to the right workbench.
The default `@agnes/browser-runtime` must be enabled and permitted by the profile capability ceiling.

Ask AGH to open a website or a local running project. This panel displays the same headless browser
that the agent operates. It is read-only; use the conversation to request browser actions.
Use **Actual size** to inspect text at native resolution; **Fit** scales the view to the panel.
Frames are JPEG over the existing authenticated plugin stream, capped at 20 fps with bounded buffering.
This is suitable for browsing and frontend inspection, not a guaranteed video/gaming frame rate.

Switching conversations, hiding the document or uninstalling this plugin disconnects the viewer.
It does not close the browser or stop the agent. No browser cookies or profile are imported from the user's browser.
Existing deliverables cards and previews continue to work independently.

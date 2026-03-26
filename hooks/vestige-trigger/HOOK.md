---
name: vestige-trigger
description: "Drive vestige-bridge extraction on OpenClaw internal hook events."
homepage: https://docs.openclaw.ai/automation/hooks
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["gateway:startup", "command:new", "command:reset", "session:compact:after", "session:end"],
      "requires": { "bins": ["node"] }
    }
  }
---

# Vestige Trigger Hook

Routes supported internal OpenClaw events into the `vestige-bridge` runtime trigger layer.

## What It Does

- listens for gateway/session/command lifecycle events
- loads the local `vestige-bridge` runtime from the workspace source tree
- calls the matching trigger entrypoint
- logs failures without blocking other hooks

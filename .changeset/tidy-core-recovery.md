---
"@diffdash/desktop": patch
---

Fix startup timeouts on populated profiles by allowing bounded Core resource recovery beyond the old five-second limit. Stop Core and release its database ownership when Electron disconnects, including during startup, and clean up partial startup before reporting failure.

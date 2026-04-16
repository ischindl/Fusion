---
"@gsxdsm/fusion": patch
---

Fix roadmap AI suggestion generation hanging by adding 120-second timeout protection to `generateMilestoneSuggestions()` and `generateFeatureSuggestions()` functions, and a 130-second route-level safety-net timeout on both suggestion endpoints. Previously, if the AI provider was slow or unresponsive, HTTP requests would hang indefinitely. The fix ensures agent sessions are properly disposed on timeout and returns a 503 Service Unavailable response with a descriptive error message.

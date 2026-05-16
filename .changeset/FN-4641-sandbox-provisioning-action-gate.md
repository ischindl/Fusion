---
"@runfusion/fusion": patch
---

Add `sandbox_provisioning` action-gate category, `sandboxProvisioning` project setting,
`resolveSandboxProvisioningPolicy` in @fusion/core, and a
`requireSandboxProvisioningApproval` engine helper. Lays the approval seam that future
bubblewrap (FN-4637), sandbox-exec (FN-4638), and container (FN-4642) backends use to
gate first-time host bootstrap.

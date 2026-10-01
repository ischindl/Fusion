/**
 * Pure transient-error predicates — NO module imports.
 *
 * FNXC:Reliability-ErrorClassification 2026-07-15-18:40:
 * Extracted from `transient-error-detector.ts` (FN-8004) so that
 * `transient-merge-error-classifier.ts` can share ONE definition of "transient"
 * without inheriting the detector's `usage-limit-detector.js → logger.js` import
 * chain. FN-5627 originally split the merge classifier out precisely to keep that
 * chain away from consumers whose tests `vi.mock("../logger.js")` with a partial
 * surface (notification-service.test.ts) — importing the detector directly would
 * have silently reintroduced it.
 *
 * INVARIANT: this module must stay import-free. Anything needing `isUsageLimitError`
 * or a logger belongs in `transient-error-detector.ts`, not here.
 *
 * `transient-error-detector.ts` re-exports every symbol below, so existing importers
 * are unaffected and may continue importing from either module.
 */

/**
 * Patterns that indicate transient network/infrastructure errors.
 * These are checked case-insensitively against error messages.
 *
 * These patterns cover:
 * - Proxy/gateway connection errors (upstream connect, disconnect/reset)
 * - Connection refusal/reset (ECONNREFUSED, connection reset)
 * - Timeouts (ETIMEDOUT, timeout in connection context)
 * - Socket errors (socket hang up)
 * - Transport layer failures
 * - AI provider abort errors (request was aborted — temporary streaming/API cancellations)
 * - OpenAI/Codex infrastructure errors surfaced as structured `server_error` payloads
 */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  // Proxy/gateway errors - indicate temporary routing issues
  /upstream connect error/i,
  /disconnect\/reset before headers/i,
  /retried and the latest reset reason/i,
  /remote connection failure/i,
  /transport failure reason/i,
  /delayed connect error/i,

  // Connection establishment failures - usually temporary
  /Connection refused/i,
  /connection reset/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,

  // Timeout patterns (connection-scoped — see the provider-request-timeout block below for the
  // narrow exception covering SDK request timeouts)
  /timeout.*connection/i,
  /connection.*timeout/i,

  /*
  FNXC:Reliability-ErrorClassification 2026-08-10-18:32:
  Provider REQUEST timeouts are transient. `"Request timed out."` is the literal default message of
  the Anthropic and OpenAI SDKs' `APIConnectionTimeoutError`, surfaced to Fusion by
  `checkSessionError` after pi-coding-agent exhausts its own in-session retries.

  Previously the connection-scoped patterns above deliberately excluded "general timeouts", so this
  string matched NOTHING and fell through to the generic failure branch in `specifyTask`
  (triage.ts) — which restores `status: null` and writes no counter, no `nextRecoveryAt`, and no
  park. Triage rediscovery then re-admitted the card on the very next poll, forever.

  Measured impact before this change: 48 `Specification failed: Request timed out.` events across
  10 tasks in 30 hours, with zero backoff between attempts (FN-8950 alone burned 8 consecutive
  attempts over ~8 hours and never reached implementation). Failed planning attempts averaged 33
  minutes each — 91 of them in 2 days, ~50 hours of wall-clock producing nothing, which was 24% of
  all planning time. Classifying these as transient routes them into the BOUNDED recovery policy
  (`MAX_RECOVERY_RETRIES` = 3 with 60s/120s/300s jittered backoff via `nextRecoveryAt`) that the
  connection-level patterns already use, so a provider blip costs three spaced retries instead of an
  unbounded loop.

  ANCHORING IS LOAD-BEARING: match `request timed out`, never a bare /timed? out/. Agent log prose
  and verification output legitimately contain "timed out" (observed: "BuildKit timed out",
  "stuck-kill unwind timeout"), and a broad pattern would reclassify real, permanent task failures
  as retryable — the exact mistake the original connection-only rule was written to avoid. This
  does NOT affect model fallback, which pi decides internally and Fusion only observes
  (`auth/fallback-model-observer.ts`).
  */
  /\brequest timed out\b/i,
  /\bAPIConnectionTimeoutError\b/i,

  // AI provider abort errors — temporary request cancellations (e.g., Anthropic streaming aborts)
  // These occur when the provider's infrastructure drops an in-flight request.
  /request was aborted/i,
  // DOMException-style AbortError ("This operation was aborted"), emitted by fetch/
  // AbortController when a provider drops an in-flight operation. Excludes user-
  // initiated cancellations like "operation was aborted by user" — those are not transient.
  /operation was aborted(?!\s+by\b)/i,

  // OpenAI/Codex structured infrastructure failures. These arrive as JSON-ish payloads
  // like {"type":"error","error":{"type":"server_error","code":"server_error",...}}
  // and are temporary service-side failures rather than task-specific defects.
  /"type":"server_error"/i,
  /"code":"server_error"/i,
  /An error occurred while processing your request\./i,

  // pi-ai openai-codex-responses WebSocket transport errors. The provider holds
  // a long-lived WebSocket to the Codex backend; transient drops surface as
  // bare "WebSocket error" / "WebSocket closed <code> <reason>" / a half-open
  // stream that ended before `response.completed`. All three are network-layer
  // hiccups, not task defects — retry them.
  /WebSocket error\b/i,
  /WebSocket closed\b/i,
  /WebSocket stream closed before response\.completed/i,

  /*
  FNXC:AcpRuntime 2026-07-15-18:25:
  ACP-backed runtimes (Grok, OMP, generic ACP) surface provider-side turn failures as JSON-RPC
  errors. `provider.ts#describeAcpTurnError` renders these as `... (acp rpc code -32603, retryable)`;
  the adapters wrap that as `<Runtime> ACP turn failed: ...`. Both signatures are matched here.

  Anchoring is deliberate: the bare JSON-RPC text is "Internal error", far too generic to match
  globally (it would swallow unrelated application failures and mask real defects). We only treat
  it as transient when it carries the ACP rpc-code envelope or the adapter's turn-failure prefix.

  FN-8004: a Grok `-32603` blip during AI merge was classified permanent, parked the task `failed`,
  and — because `status:"failed"` is what suppresses recovery — stranded 8 files of finished work.
  */
  /\bacp rpc code -32(?:603|00[0-3])\b/i,
  /\bACP turn failed\b/i,
  /\bACP failed to start\b/i,
  /\bACP session has no live connection\b/i,
];

/*
FNXC:Reliability-ErrorClassification 2026-07-25-21:10 (session/lease contention is NOT a provider failure):
Fusion serializes work on a shared path with in-process leases: the activeSessionRegistry foreign-task
guard, the workspace sub-repo acquire lease, and the workspace sub-repo land lease. When a second task
contends, the holder throws one of these three messages. They are pure CONTENTION — another task is
mid-flight on the same path — so the only correct response is "wait and try again", never "this model /
provider / plan is broken".
Reported failure: a Plan Review collision was classified as a provider failure ("Plan Review provider
failure — retrying in place (2/2)"), retried twice with no delay against a hold retrying could not clear,
then parked the task with its budget spent. Matching these shapes as transient makes every generic
retry/requeue path (executor main session, merge classifier, durable-agent heartbeat recovery) wait it
out instead. Graph nodes get an explicit backoff hold on top — see SESSION_CONTENTION_HOLD_VALUE.
*/
export const SESSION_CONTENTION_PATTERNS: RegExp[] = [
  // ActiveSessionPathHeldByForeignTaskError (active-session-registry.ts)
  /active-session path\s+\S+\s+is held by task\s+\S+/i,
  // WorkspaceRepoAcquireBusyError (worktree-acquisition.ts)
  /workspace sub-repo\s+\S+\s+acquisition is in progress for task\s+\S+/i,
  // WorkspaceRepoLandBusyError (merger-ai.ts)
  /workspace sub-repo\s+\S+\s+land is in progress for task\s+\S+/i,
];

/**
 * Detect a path/lease contention failure: another task holds the session path,
 * sub-repo acquire lease, or sub-repo land lease this task wants. Always
 * temporary — the holder releases when its own work finishes.
 */
export function isSessionContentionError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return SESSION_CONTENTION_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-13:05 (RUFU-286):
A time-boxed provider throttle is a wait-until condition, not a repair-it condition. The motivating
incident: an Anthropic 429 `rate_limit_error` ("This request would exceed your account's rate limit.
Please try again later.") reached a durable agent wrapped in pi's fallback envelope
`Unable to select a usable model after 1 attempt (primary unknown model, no fallback configured,
trigger: prompt-time): 429 {"type":"error","error":{"type":"rate_limit_error",...}}`. pi substitutes
the literal `unknown model` into that wrapper whenever Fusion resolved no model (pi used its own
built-in default), so the wrapper — not the envelope — is what downstream text classifiers saw, and
it matched the operator-actionable /unknown model/i pattern. Consequence: the agent parked
`paused`/`pauseReason:"error-unrecoverable"` with no scheduled re-probe and the FN-7884 startup sweep
refuses to clear that class, so a throttle that expires in minutes silently becomes an operator
page. Measured: the engine-wide `agent:error-parked-unrecoverable` rate had climbed to 4.8 events/day.

Shape (a): a structured provider envelope type — Anthropic 429 `rate_limit_error`, OpenAI 429
`rate_limit_exceeded`. Shape (b): the pi fallback wrapper whose tail carries shape (a); a whole-string
envelope test covers both because pi interpolates the underlying reason verbatim. The wrapper alone
(without an envelope tail) must NOT fire — it also wraps durable classes at session creation.

Hard usage caps are excluded FIRST and win: `insufficient_quota` ("budget has been exhausted. Please
purchase more."), quota-exceeded, billing, plan-access and weekly "usage limit reached" wording are
provider-account states no retry fixes. An Anthropic insufficient_quota envelope carries
`"type":"insufficient_quota"`, never a rate-limit type, so the exclusion is precedence insurance for
messages that mention both (e.g. an OpenAI rate_limit envelope whose message says "check your billing").

Deliberately narrow: generic prose ("we hit a rate limit", the dashboard's own provider-pause reason
`provider-rate-limit:<id>`, retry-count chatter) must not match — only the structured type tokens
providers emit in a 429 body. That is also why the token is not put into TRANSIENT_ERROR_PATTERNS:
this classification feeds operator-actionability, not task retry queues.
*/
const PROVIDER_THROTTLE_ENVELOPE_PATTERN =
  /["']type["']\s*:\s*["']rate_limit_(?:error|exceeded)["']|\brate_limit_error\b|\brate_limit_exceeded\b/i;

/*
FNXC:ProviderThrottleIsTransient 2026-09-30-17:12 (RUFU-286 code review P2):
The envelope tokens above are the Anthropic/OpenAI spellings only, so every other provider's
unambiguous request-rate code fell to the generic branch — and for a durable agent that branch is
the error-recovery budget, which ends in a park. These additions are the codes that ONLY ever mean
"your request rate is too high, try again in a moment", never an account state:
- AWS/Bedrock: `ThrottlingException` (bedrock-runtime and Step Functions style), `Throttling`,
  `ThrottlingException`'s v2 siblings `RequestLimitExceeded` / `TooManyRequestsException`, and the
  CamelCase `rateLimitExceeded` the JS SDK puts on `err.name`/`err.code`.
- Azure OpenAI and AI-Gateway: 429 bodies whose `error.code` is `TooManyRequests`.
- SDK class names carried in the message text (`RateLimitError`, `APIError: 429`-style prefixes are
  NOT matched — a bare status code proves nothing about which quota tier tripped).

DELIBERATE EXCLUSION — Google `RESOURCE_EXHAUSTED`. Vertex/Gemini use ONE code for two opposite
verdicts: per-minute request rate (a wait) and daily/per-project quota exhaustion (an operator
action). Nothing in the body distinguishes them (`"Resource has been exhausted (e.g. check quota.)"`
appears for both), so matching it would silently convert a hard quota stop into an endless
backoff-and-reprobe that never pages anyone — the exact failure mode RUFU-286 exists to remove. An
unclassified `RESOURCE_EXHAUSTED` still gets the bounded retry budget and then parks
`error-retry-exhausted`, which IS visible. Add it only together with a field that separates the two.

Hard-cap precedence is unchanged and still wins: an AWS `ThrottlingException` whose message also says
"purchase more" stays operator-actionable.
*/
const PROVIDER_THROTTLE_ENUM_PATTERN =
  /\bThrottling(?:Exception)?\b|\bTooManyRequests(?:Exception)?\b|\bRequestLimitExceeded\b|\brateLimitExceeded\b|\bRateLimitError\b/i;
const PROVIDER_HARD_USAGE_CAP_PATTERN =
  /insufficient_quota|quota[_\s-]?exceeded|billing|plan access|usage limit reached|budget has been exhausted|purchase more/i;

/**
 * Detect a time-boxed provider throttle — a 429 whose structured type says retry later
 * (`rate_limit_error` Anthropic / `rate_limit_exceeded` OpenAI, plus the AWS/Azure request-rate
 * enums), including pi's fallback wrapper when its tail carries that envelope. Excludes hard usage
 * caps (`insufficient_quota`, quota-exceeded, billing, plan-access, weekly usage-limit wording):
 * those need operator action.
 */
export function isProviderThrottleEnvelopeError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  if (PROVIDER_HARD_USAGE_CAP_PATTERN.test(errorMessage)) {
    return false;
  }
  return PROVIDER_THROTTLE_ENVELOPE_PATTERN.test(errorMessage) || PROVIDER_THROTTLE_ENUM_PATTERN.test(errorMessage);
}

/**
 * Check if an error message indicates a transient network/infrastructure error.
 *
 * Transient errors are temporary conditions that typically resolve after a delay:
 * - Network blips and temporary routing issues
 * - Proxy/gateway hiccups (upstream connect errors)
 * - Connection resets during establishment
 * - Temporary service unavailability (connection refused)
 * - Socket timeouts during connection
 *
 * Returns `true` for transient errors — these should trigger a retry by moving
 * the task back to "todo" rather than marking as "failed".
 *
 * Returns `false` for permanent failures (code errors, test failures) or
 * usage limit errors (rate limits that need global pause).
 *
 * @param errorMessage - The error message to classify
 * @returns true if the error appears transient and retryable
 */
export function isTransientError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  if (isTransientAuthCredentialError(errorMessage)) {
    return true;
  }
  // FNXC:Reliability-ErrorClassification 2026-07-25-21:10: lease/session contention is transient by
  // construction, so every generic retry path waits for the holder instead of parking the task.
  if (isSessionContentionError(errorMessage)) {
    return true;
  }
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/*
FNXC:Reliability-ErrorClassification 2026-07-12-20:10:
A long-running agent session holds its OAuth access token in memory. Claude Max access tokens rotate mid-run (~8 h lifetime); the in-flight call fails with a 401 {"type":"authentication_error","message":"Invalid authentication credentials"} even though the credentials file has already been refreshed, and the very next call succeeds. These must classify as TRANSIENT (retryable) and NOT operator-actionable, so in-run retry (withRateLimitRetry) and durable-agent heartbeat error recovery (FN-7835/FN-7844/FN-7859) auto-recover instead of parking agents paused with pauseReason "error-unrecoverable". Previously the message matched the operator-actionable /credential/ and /unauthorized/ patterns and defaulted to "permanent", so a routine token rotation parked every durable agent for manual operator repair.
Genuinely operator-actionable auth failures are excluded first: OAuth scope/permission-grant errors (token valid but lacks grants) and explicit API-key problems (invalid/missing x-api-key) — retrying those only repeats the failing call.
*/
const TRANSIENT_AUTH_CREDENTIAL_ROTATION_PATTERN =
  /"type":\s*"authentication_error"|invalid authentication credentials|token[_\s]?expired/i;
/*
FNXC:Reliability-ErrorClassification 2026-07-12-21:05:
PR #2027 review: the `"type":"authentication_error"` envelope is intentionally broad (providers put rotation failures behind it with varying messages), so the exclusion list must carry the operator-actionable load. Beyond scope grants and invalid/missing API keys, exclude account/credential states no retry can fix: revoked/suspended/disabled/deactivated keys or accounts and inactive subscriptions. A message matching any of these stays permanent/operator-actionable even inside an authentication_error envelope; retries are pointless and would un-park agents a human must repair. Unmatched novel auth messages still classify transient, but the bounded heartbeat error-recovery budget re-parks them as `error-retry-exhausted` after a few attempts, so the failure mode is a handful of visible retries, not an unpark loop.
*/
const OPERATOR_ACTIONABLE_AUTH_EXCLUSION_PATTERN =
  /oauth token does not meet scope|insufficient[_\s-]?scope|invalid[_\s-]?scope|invalid (?:api[_\s-]?key|x-api-key)|missing\s+(?:\S+\s+)?(?:api[_\s-]?)?key|revoked|suspend(?:ed)?|disabled|deactivated|subscription|account (?:is )?(?:locked|closed|inactive)|access denied/i;

/**
 * Detect a transient authentication failure caused by credential rotation
 * (e.g. a Claude Max OAuth access token expiring mid-run). Scope-grant and
 * API-key misconfiguration errors are excluded — those need operator action.
 */
export function isTransientAuthCredentialError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  if (OPERATOR_ACTIONABLE_AUTH_EXCLUSION_PATTERN.test(errorMessage)) {
    return false;
  }
  return TRANSIENT_AUTH_CREDENTIAL_ROTATION_PATTERN.test(errorMessage);
}

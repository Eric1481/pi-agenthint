# pi-agenthint

**Agent Hint request metadata and lifecycle reporting for [Pi](https://pi.dev/).**

`pi-agenthint` derives bounded scheduling, cache, and lifecycle hints from Pi's public
ExtensionAPI and attaches them to model-provider requests as an `X-Agent-Hint` HTTP header.
It never adds an Agent Hint field to the provider request body.

[Install](#install) · [Verify](#verify) · [Configure](#configuration) ·
[How it works](#how-it-works) · [Safety](#safety-and-failure-behavior) ·
[Test](#testing)

## Why

A provider, router, or observability service may benefit from facts that Pi already knows:

- which session and request ordinal produced a call;
- whether the agent is running, waiting for a tool or person, suspended, or finished;
- which message ranges are candidates for prompt-cache pinning or temporary retention;
- bounded predictions learned from completed calls and tool executions;
- an explicitly trusted priority binding supplied by the deployment.

Without an extension, those facts remain inside the agent process. This package exposes them in
one size-limited header while keeping the model payload unchanged. The receiving service must
understand the header; the extension does not assume that an unsupported provider will act on it.

## Install

Requires Node.js 22.19 or newer and Pi with the provider-header lifecycle hooks. The package is
verified against `@earendil-works/pi-coding-agent@1.1.0` and `@1.2.0`.

```sh
pi install npm:pi-agenthint
```

Installing the package is the opt-in. Header injection is enabled by default; the optional
out-of-band reporting channel remains disabled until explicitly configured.

**Upgrading.** `pi update npm:pi-agenthint` moves an unpinned install to the latest release. An
install that pinned a version (`pi install npm:pi-agenthint@0.1.1`) stays pinned by design — reinstall
without the version to follow releases:

```sh
pi install npm:pi-agenthint          # unpin and move to the current release
```

Upgrading matters for anything before `0.2.0`: those releases send a two-entry `cache_control`
array whose first entry carries no TTL, and consumers that parse only the first entry silently drop
the retention request.

Do not enable this package alongside an AscendAgent-Pi release that still contains its embedded
Agent Hint implementation. Both producers refuse to overwrite an existing `X-Agent-Hint`, so
only the first loaded producer will send a value.

## Verify

Start Pi and run:

```text
/agenthint
```

The command reports the loaded Pi version, configuration source, injection and skip counters,
current lifecycle state, prediction inputs, reporting health, and the last hint sent. It does not
make a model request.

A decoded header has this general shape; optional groups are present only when supported by current
observations and configuration:

```json
{
  "session": {
    "session_id": "...",
    "agent_type": "pi-agent",
    "call_index": 1,
    "epoch": 0
  },
  "agent_status": {
    "state": "running",
    "state_since_ms": 1730000000000
  },
  "cache_control": [
    {
      "type": "ephemeral",
      "ttl_s": 600,
      "range": { "end": 2, "unit": "message" }
    }
  ]
}
```

## Configuration

Defaults require no file. To override them, point `PI_AGENTHINT_CONFIG` at one complete JSON
file:

```sh
PI_AGENTHINT_CONFIG=/absolute/path/to/agenthint.json pi
```

```json
{
  "enabled": true,
  "agentType": "pi-agent",
  "suspendAfterMs": 90000,
  "humanApprovalWaitMs": 300000,
  "humanInputWaitMs": 60000,
  "cacheControl": true,
  "cacheTtlS": null,
  "priority": true,
  "prediction": true,
  "predictionWindow": 20,
  "predictionPolicy": "p90",
  "predictionMinSamples": 3,
  "strictPriority": true,
  "strictPriorityEnv": "PI_AGENTHINT_STRICT_PRIORITY",
  "reporting": {
    "enabled": false,
    "endpoint": "",
    "tokenEnv": "PI_AGENTHINT_TOKEN",
    "timeoutMs": 3000,
    "maxRetries": 2,
    "queueLimit": 64
  }
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable in-band header injection. |
| `agentType` | string | `"pi-agent"` | Stable agent type placed in the session identity. |
| `suspendAfterMs` | integer | `90000` | Upgrade a continuing human wait from `pause` to `suspend`. |
| `humanApprovalWaitMs` | integer | `300000` | Expected approval-wait budget used for bounded predictions. |
| `humanInputWaitMs` | integer | `60000` | Expected non-approval human-input wait budget. |
| `cacheControl` | boolean | `true` | Publish provider-visible logical message ranges. |
| `cacheTtlS` | integer \| null | `null` | Retention seconds for the ephemeral range. `null` derives it from the observed gap (next tool's expected duration, else the inter-call interval, else 300 s, doubled and clamped to 60–3600); `0` sends no declaration at all; a number fixes it. |
| `priority` | boolean | `true` | Publish the locally derived advisory priority. Levels are binary: `3` when a person is waiting on this request, `1` otherwise; `reason` carries the detail (`user_waiting` / `critical_path` / `background`). |
| `prediction` | boolean | `true` | Publish estimates only after enough completed observations exist. |
| `predictionWindow` | integer | `20` | Maximum recent samples retained per bounded statistics bucket. |
| `predictionPolicy` | string | `"p90"` | Collapse observations using `mean`, `p50`, or `p90`. |
| `predictionMinSamples` | integer | `3` | Minimum completed samples before an estimate is published. |
| `strictPriority` | boolean | `true` | Allow a trusted external priority binding; never self-assign one. |
| `strictPriorityEnv` | string | `"PI_AGENTHINT_STRICT_PRIORITY"` | Environment variable containing `<level>:<reason>`. |
| `reporting.enabled` | boolean | `false` | Send lifecycle transitions to an HTTP collector. |
| `reporting.endpoint` | HTTP URL | `""` | Collector endpoint; required when reporting is enabled. |
| `reporting.tokenEnv` | string | `"PI_AGENTHINT_TOKEN"` | Environment variable read at delivery time for the bearer token. |
| `reporting.timeoutMs` | integer | `3000` | Per-attempt reporting timeout. |
| `reporting.maxRetries` | integer | `2` | Bounded retries for a failed report. |
| `reporting.queueLimit` | integer | `64` | Maximum queued lifecycle events; the oldest is dropped first. |

Configuration is strict: unknown fields, wrong types, invalid ranges, and non-HTTP reporting URLs
are rejected. An invalid explicit file disables header injection and is shown by `/agenthint`;
the extension does not silently fall back to enabled defaults.

The reporting bearer token is resolved from its environment variable for each delivery and is
never stored in status or retained by the reporter.

## How it works

The extension uses Pi's public lifecycle surfaces:

- `before_provider_headers` builds and attaches the hint for every provider attempt;
- `after_provider_response` records completed provider timing;
- `context_with_system` derives logical prompt-cache message ranges;
- session, compaction, tree, tool, UI-prompt, and settle events drive lifecycle state;
- custom session entries preserve request ordinals and context epochs across a restart.

The header value is canonical JSON encoded as base64url and capped at 4096 encoded bytes. Optional
groups are removed in a deterministic order if necessary. If the required session identity still
cannot fit, the hint is omitted instead of truncated into invalid JSON.

A resumed session writes checkpoints as `pi-agenthint.checkpoint` and can read the legacy
`ascendagent-pi.agent-hint-checkpoint` type for migration.

## Safety and failure behavior

- Existing `X-Agent-Hint` headers are never overwritten.
- Provider request bodies are never modified.
- Header construction, optional reporting, checkpoint writes, and observation failures are
  isolated from the model request.
- External reporting is off by default and accepts only an explicit HTTP or HTTPS endpoint.
- Reporting tokens are read from environment variables and are never returned by `/agenthint`.
- Statistics use bounded windows and do not infer unsupported parent-child agent relationships.
- A hint is advisory metadata, not an authentication, authorization, or sandbox boundary.

## Compatibility and AscendAgent-Pi parity

The standalone package was extracted from the Agent Hint implementation in AscendAgent-Pi and
audited against the current implementation on October 13, 2026:

- hint construction and schema validation are identical;
- lifecycle and prediction logic are identical apart from standalone naming and configuration;
- the reporter resolves its token at delivery time instead of retaining it;
- new checkpoints use the standalone name while legacy AscendAgent-Pi checkpoints remain readable;
- `/agenthint` replaces the Bundle-specific `/ascend-hint` command.

These differences remove Bundle and Office dependencies without changing the provider header
contract. Pi versions outside the verified set are reported by `/agenthint` and produce a TUI
warning rather than being silently treated as verified.

## Testing

```sh
npm install --ignore-scripts
npm run test:unit
npm run test:e2e
npm run check
```

The deterministic suite contains 138 unit, contract, integration, security, package-install, and
session-recovery tests. The separate end-to-end test starts a real Pi 1.1 process against a local
OpenAI-compatible mock provider and asserts from the captured HTTP request that:

- `X-Agent-Hint` is present and decodes to valid session and lifecycle data;
- the call ordinal begins at one for the first provider request;
- no `agent_hint` field is added to the provider body.

No network credentials or model quota are required for the test.

### Layout

```text
src/
├── extension.js       # Pi ExtensionAPI wiring and /agenthint
├── config.js          # strict standalone configuration
├── hint-build.js      # canonical header construction and size budget
├── hint-schema.js     # field validation and optional-field shedding
├── hint-state.js      # lifecycle state machine
├── hint-stats.js      # bounded observations and predictions
├── hint-control.js    # strict priority and optional reporting
└── hint-recovery.js   # durable checkpoint compatibility

test/
├── *.test.js          # unit, contract, integration, security, and install tests
└── e2e/wire.test.js   # real Pi + local mock provider wire acceptance
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

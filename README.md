# pi-agenthint

`pi-agenthint` is a standalone [Pi](https://pi.dev/) extension that publishes Agent Hint v2
metadata on model requests. It derives only facts exposed by Pi's public ExtensionAPI and places
the result in the `X-Agent-Hint` HTTP header; it never changes the provider request body.

The hint can describe session identity and forks, lifecycle state, request priority, prompt-cache
ranges, and bounded predictions learned from observed calls. An optional HTTP channel reports
states such as pause, suspend, and finalize when no model request is in flight.

## Install

```sh
pi install npm:pi-agenthint
```

Installing the dedicated package is the opt-in: in-band hints are enabled by default. External
status reporting is disabled until explicitly configured. Use `/agenthint` inside Pi to inspect
the last value sent, counters, current state, prediction inputs, and reporting health.

Do not enable this package alongside an AscendAgent-Pi version that still contains its embedded
AgentHint implementation. Both correctly refuse to overwrite an existing `X-Agent-Hint`, but only
the first loaded producer will send a value.

## Configuration

Defaults require no file. To override them, point `PI_AGENTHINT_CONFIG` at one complete JSON file:

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
  "cacheTtlS": 600,
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

Configuration is strict: unknown fields, wrong types, invalid ranges, and non-HTTP reporting URLs
are rejected. An invalid explicit file disables header injection and is shown by `/agenthint`; the
extension does not silently fall back to enabled defaults.

Hard priority is never self-assigned. If a trusted deployment enables it, the configured
environment variable contains `<level>:<reason>`. The optional reporting bearer token is also read
from an environment variable at call time and is never included in status output.

## Wire behavior

The header value is UTF-8 JSON encoded as base64url and capped at 4096 encoded bytes. Optional
fields are removed in a deterministic order when necessary; if the required session identity still
does not fit, the hint is omitted rather than sending an invalid value.

The extension uses these Pi 1.1 lifecycle surfaces:

- `before_provider_headers` and `after_provider_response` for exact request timing;
- `context_with_system` for logical message cache ranges;
- session, compaction, tree, tool, UI prompt, and settle events for lifecycle state;
- custom session entries for durable request ordinals and context epochs.

A resumed session can read legacy `ascendagent-pi.agent-hint-checkpoint` entries once and writes new
checkpoints as `pi-agenthint.checkpoint`.

## Development

Requires Node.js 22.19 or newer.

```sh
npm install --ignore-scripts
npm test
npm pack --dry-run
```

The package is verified against `@earendil-works/pi-coding-agent@1.1.0`. Pi supplies that peer at
runtime; it is not bundled into the package.

## License

No open-source license has yet been granted for the extracted AscendAgent implementation. The npm
metadata is therefore `UNLICENSED` until the project owner explicitly selects a license.

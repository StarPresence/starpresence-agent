# StarReview agent CLI

Review management for AI agents. `starreview` lets any agent that can run a shell command (Claude Code, Codex, OpenClaw, nanoclaw, Hermes, and friends) manage a business's online review replies: list unanswered reviews across platforms, draft replies in the owner's voice, submit them to StarReview, and report review KPIs.

**The safety model is the product:** the agent drafts and submits; it never posts. StarReview applies the owner's existing approval and automatic-publishing settings. An eligible, unedited StarReview draft may be scheduled without another click when standing consent and safety checks allow it. Agent-written, edited, or safety-held replies remain pending.

## Install

```bash
npm install -g @starreview/cli
export STARREVIEW_API_KEY=sragt_...
```

Requests time out after 120 seconds by default. Set `STARREVIEW_TIMEOUT_MS` to a whole number from `1000` through `600000` to override it.

Or as an agent skill:

```bash
npx skills add Fabsbags/starreview-agent
```

The owner creates the API key in their [StarReview settings](https://www.starreview.ch/) (Einstellungen → Agent-Zugang). One key covers all their businesses and can be revoked there at any time.

## Commands

```
starreview reviews [--business <id>] [--location <id>] [--provider <slug>] [--limit <n>]
starreview review <reviewId>
starreview draft <reviewId>
starreview submit <reviewId> --variant <n> [--text <edited>] [--post-at <iso>]
starreview submit <reviewId> --text <own reply> [--post-at <iso>]
starreview stats [--days <n>] [--business <id>] [--location <id>]
starreview locations [--business <id>]
starreview info                      # no key needed
starreview check "<business name>"   # no key needed - free response-rate check
```

Every command prints one JSON document to stdout (agent-first output). Errors print `{ "error": "<code>", "message": "..." }` and exit non-zero. See [SKILL.md](./SKILL.md) for the full agent contract: multi-business picker, per-platform post-submit outcomes, error codes, rate limits, and the honesty rules.

## Example

```bash
$ starreview reviews --limit 1
[
  {
    "reviewId": "8b1c...",
    "starRating": 4,
    "text": "Tolles Essen, etwas lange gewartet.",
    "reviewerName": "M. Keller",
    "reviewDate": "2026-07-20",
    "provider": "google",
    "hasDraft": false
  }
]

$ starreview draft 8b1c...
$ starreview submit 8b1c... --variant 1
{ "submitted": true, "autoScheduled": false, "gateOutcomes": { ... } }
```

Here `autoScheduled: false` means the reply waits in the owner's StarReview approval queue. When an eligible, unedited StarReview draft returns `autoScheduled: true`, StarReview has scheduled it under the owner's standing consent. The CLI itself never posts.

## What this repo is (and is not)

This is a thin, MIT-licensed client over StarReview's hosted MCP endpoint (`https://mcp.starreview.ch/`). It contains no server code and no secrets; the only credential it ever touches is your own `STARREVIEW_API_KEY` environment variable. MCP-native clients (Claude, ChatGPT, Cursor) can skip the CLI and connect to the endpoint directly - see [starreview-mcp](https://github.com/Fabsbags/starreview-mcp) and [starreview.ch/agents](https://www.starreview.ch/agents/).

## Coordinated release order (maintainers)

The CLI deliberately pins its development contract to the exact MCP release. For a coordinated MCP/CLI release:

1. Pack the MCP candidate in the backend repository. The backend candidate gate installs that local package into a CLI checkout and runs `npm run test:contract`; this does not require a registry release.
2. Publish the verified `@starreview/mcp` version.
3. Run ordinary CLI CI, the packed production canary, and then publish `@starreview/cli`.

Ordinary CLI CI is expected to fail with an npm `E404` before step 2; do not loosen the exact MCP pin to work around that ordering.

The protected `production-canary` GitHub environment must provide:

- Secret `STARREVIEW_CANARY_PER_BUSINESS_API_KEY`: a legacy/admin-issued `sragt_` credential pinned to the dedicated synthetic business. Never use an account-wide self-service key. The workflow maps this secret to the canary runtime's `STARREVIEW_CANARY_API_KEY`.
- Variable `STARREVIEW_CANARY_BUSINESS_ID`: the expected dedicated synthetic business ID.

The canary scopes `list_locations` to that expected business and rejects picker, empty, inactive, malformed, or explicitly mismatched results. The API response cannot independently prove whether an `sragt_` credential is per-business or account-wide, so correct secret provisioning remains an operational requirement. Run `npm run canary:production -- --help` to display these requirements without making a request.

## License

MIT

---
name: starreview
description: Use when managing a business's online review replies (Google, TripAdvisor, and more) via the starreview CLI - list unanswered reviews, draft replies in the owner's voice, submit them for the owner's approval, and report review KPIs. Requires STARREVIEW_API_KEY. The agent drafts; the human approves; StarReview publishes.
---

# StarReview agent CLI

StarReview drafts and submits review replies for local businesses. You (the agent) draft and submit; the owner's decision governs publishing; StarReview publishes. You can never post a reply yourself - no command for it exists.

## Setup

```bash
npm install -g @starreview/cli   # or: npx @starreview/cli <command>
export STARREVIEW_API_KEY=sragt_...
```

The owner creates the key in their StarReview settings (Einstellungen -> Agent-Zugang) at https://www.starreview.ch/. The key covers ALL businesses the owner manages. No key yet? The `info` and `check` commands work without one - use `check` to show the owner their current response rate before they sign up.

Every command prints ONE JSON document to stdout. Success prints the payload; failure prints `{ "error": "<code>", "message": "..." }` with a non-zero exit. Parse stdout, branch on exit code.

## Workflow

```bash
starreview stats --days 30            # optional: how are the reviews doing
starreview reviews --limit 10         # unanswered reviews, each with .provider
starreview review <reviewId>          # full text, language, existing drafts
starreview draft <reviewId>           # StarReview drafts variants (owner's voice)
starreview submit <reviewId> --variant 1              # commit a draft for approval
starreview submit <reviewId> --variant 1 --text "..." # commit with your edit
starreview submit <reviewId> --text "..."             # your OWN reply (always waits for a human)
```

- `reviews` accepts `--business <id>` (see multi-business below), `--location <id>`, `--provider <slug>`, `--limit <n<=50>`.
- `submit --post-at <ISO>`: StarReview will not post before that time.
- `draft` costs the owner nothing; only a PUBLISHED reply is billed (CHF 0.50).

## Multi-business

The key identifies the OWNER. If they manage several businesses, list-type commands return a picker instead of doing the work:

```json
{ "businesses": [{ "businessId": "...", "name": "..." }], "hint": "..." }
```

Check for this shape (`businesses` + `hint`) before treating a response as the answer, then re-run with `--business <id>`. Review-keyed commands (`review`, `draft`, `submit`) never return a picker - the review pins the business.

## Platforms are open-ended

Every review carries `provider` (`google`, `tripadvisor`, ...). The value set GROWS as StarReview activates platforms - never hardcode it, never reject an unknown value. What differs per platform is only the post-submit outcome, always signaled in the response itself:

- `autoScheduled: true` - the reply rides the owner's standing consent (unedited StarReview draft, positive review, consented business); StarReview posts it.
- `submitted: true` without scheduling - the reply waits in the owner's approval queue.
- `awaitingManualPost: true` + `platformListingUrl` - approved reply on a platform with no reply API (e.g. TripAdvisor): the OWNER posts it through that link. A distinct SUCCESS, not a failure - do not retry.

## Honesty rules (do not violate)

- Never claim a reply was posted. Say it was submitted for the owner's approval (or auto-scheduled on their standing consent when `autoScheduled` is true).
- Never present `awaitingManualPost` as posted; give the owner the link instead.
- Negative and sensitive reviews always wait for a human; every draft passes a sentiment check.

## Error codes

Refusals (do NOT blind-retry): `forbidden`, `posting_paywall` (owner must subscribe), `review_not_pending` (refresh the list), `free_quota_exhausted`, `not_editable`, `already_processed` (treat as success), `business_not_connected` (send the owner to onboarding).

Failures/limits: `missing_api_key` / `unauthorized` (fix the key), `invalid_arguments`, `not_found`, `variant_not_found` (re-run `draft`), `rate_limited_per_minute` (back off >=60s), `daily_draft_cap_exceeded` (stop for the day), `db_error` / `internal_error` (retry with backoff), `network_error`.

Rate limits: 20 calls/min per key; drafting ~25/day per business. Public: 10 calls/min per IP, `check` results cached ~30 days - never repeat for the same place.

## Compatibility promise

Changes are additive-only: new commands, optional flags, response fields, and `provider` values may appear in any minor version; nothing existing is removed or changes meaning without a MAJOR version bump. An agent written against this document keeps working.

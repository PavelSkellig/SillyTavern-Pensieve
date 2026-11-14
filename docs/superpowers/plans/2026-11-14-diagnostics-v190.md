# Safe staged diagnostics · v1.9.0

> Inline execution using superpowers:executing-plans; one fresh final whole-branch reviewer. Standing user preference: implement/publish without another approval round.

**Goal:** Implement corrected текст (16).txt on published v1.8.0. текст (15).txt withdrawn, no code applied.
**Spec:** C:/Users/PavelPC/Downloads/Telegram Desktop/текст (16).txt.
**Architecture:** A static error/stage/operation catalog and safe bounded journal. Context stages annotate existing exceptions without changing generation/archive algorithms. Reports contain enums/counts/versions/status and sanitized code-file stack locations, never arbitrary error text, context/settings objects or URLs. Unknown technical strings are explicitly withheld. A small in-flow notification and existing Settings details use the same20-entry journal; no top-level tab or error modal. Local browser storage keyed by opaque hash of native account handle persists even if backend/settings saves fail, independently of existing memory data.
**Tech:** Native JS modules, localStorage adapter, scoped HTML/CSS, native clipboard + fallback; Node and real disposable ST1.19.0 Chromium/WebKit synthetic requests.

## Global constraints / review focus
- All error codes unique; preserve deepest observed stage and distinguish confirmed API/context/cancel signals from unknown causes. Do not blame ST/API/another extension without evidence.
- Privacy is allowlist-based: no free-form exception text, URLs, names, chat/memory/prompt text or secrets in persisted/copy/console data; only known codes/classes/statuses, fixed explanations and safe code basenames+line/column. Untrusted stored records revalidated on load.
- Exactly20recent distinct records, bounded repeats, console dedup, explicit clear only journal. Dynamic per-account scope, memory-only fallback if storage unavailable, no recursive diagnostics failures.
- Stage trace: chat data → active entries → hierarchy → content → tokens → macro → injection → source exclusion → ST handoff. Live snapshots count only metadata and expose macro unknown when no actual use established.
- Noncritical UI/badge/token-label/render failures warn and never cancel roleplay. Context corruption uses existing native abort; explicitly handle cancellation/release failures and fail closed at payload serialization if native cancellation itself fails. Never mutate user chat or memory to report an error.
- Finally clears busy/send locks even after errors/cancel; no automatic retries. Keep raw own generation literal and preset/archive/export/import format intact.

## Task1: catalog and safe journal
- [ ] RED codes/stages/deepest tags, known/unknown/confirmedAPI classification; sanitized persisted/copied/console reports under adversarial exception/state/storage inputs.
- [ ] Implement catalog, version module, safe annotations, bounded persistent service with dedup/clear/account isolation/fallback. No archive/settings writes.
- [ ] Unit suite/check GREEN; commit.

## Task2: native operation boundaries
- [ ] RED exact failed context stages, macro/source errors, API/timeout/empty/format/cancel, save type/read/restore/import failures, optional UI failure and release failure. Existing data and source selection unchanged.
- [ ] Instrument actual Engine/Host/MemoryEcho stages and enrich blocked-memory reasons without changing algorithms. Preserve original exceptions internally; only service-approved summaries reach UI/console. Robust finally/abort, no retry loops.
- [ ] Unit suite/check GREEN; commit.

## Task3: minimal notification and Settings
- [ ] Inline notification details+copy, account-local journal and Settings collapsed Diagnostics at bottom even without chat. Journal viewer inline, copy full bounded report, clear only journal. No modal/top tab.
- [ ] Route own sync/async event errors to service, preserve failure isolation and one stable listener set. Copy fallback works without ClipboardAPI.
- [ ] Real ST synthetic injected failures: exactmacro/source stages, API500/confirmedlimit/timeout/empty, saving volume, JS handler, cancel/retry, reload persistence, >20dedup, secret canaries absent in report/storage/console, iPhone320/390copy and no overlay. Regression presets/backup/context.

## Task4: release
- [ ] Full checks, docs/screenshot/version1.9.0, one independent final read-only review; fix material findings once RED→GREEN.
- [ ] Authorized main/tag publication, public manifest + clean-clone tests. Stop own test server; delete only this plan scratch after path verification.

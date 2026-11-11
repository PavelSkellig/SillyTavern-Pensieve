# Visible history and memory source links · v1.6.4

> Execute inline with superpowers:executing-plans; one final independent whole-branch review.

**Goal:** Implement and publish текст (9).txt on top of v1.6.3, continuing the user's immediate implementation/publication preference.
**Architecture:** Resolve local source UUIDs plus original fingerprints and actual hierarchy. In the existing ST generation interceptor, refresh the actual memory snapshot and splice only the separate request array before WI and Chat/Text Completion formatting. Do not touch live message visibility, text or saves. Reuse the same source links for passive full-hierarchy chat labels.
**Stack:** Existing JavaScript modules, scoped CSS, Node tests, actual ST1.19.0, Playwright Chromium/WebKit.
**Spec:** C:/Users/PavelPC/Downloads/Telegram Desktop/текст (9).txt.

## Constraints
- Source history is excluded only when actually replaced by enabled, unblocked active memory; no exclusion for disabled/inactive memory or unrelated messages/chats.
- Preserve manual generation/raw prompts, preview/save/archive/export/import formats and existing safety gates for unbound foreign backup sources.
- No live message writes, Hide/unhide, added settings or confirmation for normal native reveal.
- Labels: ◈ Омут памяти · Эпизод №9 → Глава №3 → Том №1; actual existing links only, inactive levels included, no actions. Preserve native visibility; the old collapse preference may shorten only natively hidden messages, never revealed ones.
- Isolated repair checkout, branch codex/pensieve-v1.6.4; no user files/data migration.

## Review focus
- ST preformats/regexes request messages and assigns filtered indices: identify via verified live source UUID, never formatted text or positional index.
- Missing/changed/ambiguous or detached foreign sources must never cause unrelated-message exclusion; existing unresolved-source protection remains.
- Only effective top-level memory covers descendants; inactive archives, disabled injection, blocked token budgets do not suppress raw history.
- Multiple hierarchy parents, deleted links and custom/legacy titles must produce truthful labels without duplicate chains.
- Normal Chat and Text Completion, native reveal, chat switch, rejection/cancel, reload: no visibility/text/save side effects.

## Task 1: request context
Files: new src/source-links.js, src/engine.js, index.js; tests/engine.test.js and tests/source-links.test.js.
Interfaces: memorySources(entries,chat,key,roots) -> {ids:Set,episodes:Set}; stripMemorySources(request,liveChat,ids) mutates only request array; Engine.prepareContext(request,type) refreshes/injects memory and filters actual request.
- [x] RED: native reveal makes Engine.memory blocked; after fix false and prepareContext removes only covered request copies, untouched live text/visibility, no saves.
- [x] Cover episode→chapter→volume, disabled/inactive/blocked memory, moved/regexed messages, changed/duplicate UUIDs and foreign archives.
- [x] Implement verified local source links; remove only resolvable native overlap from blocking, retaining unresolved/import safety. Wire existing interceptor.
- [x] GREEN Node whole suite/check; commit and ledger evidence.

## Task 2: labels and end-to-end release
Files: src/source-links.js, src/ui.js, style.css, tests/source-links.test.js, tests/visible-history.mjs, version metadata and release docs.
Interface: messageLabels(entries,chat,key) -> Map(sourceId,label); derived from real typed parent paths and numbering.
- [x] RED labels: full chain regardless activity, branch/deletion/missing levels, safe provenance; real browser passive labels, native reveal retained.
- [x] Implement compact label without expand action; reveal must disable old clamp immediately through native attribute selector.
- [x] Actual ST Chat/Text payload tests: native episode and volume reveal, fresh continuation, memory disabled, creation from revealed text, chat isolation and reload, no data/visibility changes.
- [x] Chromium/WebKit relevant regressions and Node/check; single fresh review; fix material findings RED→GREEN.
- [x] Version1.6.4/docs/screenshots prepared.
- Release gate: atomic main+tag publication, public manifest and clean-clone verification; results recorded in the release session.

Final review fixes: covered terminal native Continue is refused before splicing/HTTP/writeback; normal replies and uncovered Continue remain usable. No-chat quiet generation retains the former empty-memory fallback. Both findings reproduced RED→GREEN in Node and real ST, with Chromium/WebKit.

# Chat episode actions and complete memory backup · v1.6

> **For agentic workers:** Use superpowers:executing-plans in this session with one whole-change independent review. Steps use checkbox syntax.

**Goal:** Publish the user-authorized additions from «текст (5).txt» on top of v1.5.0.

**Architecture:** Reuse Engine.generateSummary/saveDraft and the existing preview UI. Add one conditional message action, an additive previewEpisodes setting, and a versioned pure backup/restore planner. Commit a validated whole archive through the existing ST save/readback path; prompt/settings restoration is explicit, with rollback of local state on save failure.

**Tech Stack:** Native JS modules, HTML/CSS, Node tests, disposable ST1.19.0, Chromium/WebKit Playwright.

**Spec:** Downloads/Telegram Desktop/текст (5).txt and supplied three-icon image. User explicitly chose “Внедрить и опубликовать”.

## Global Constraints

- Existing records, literal prompts, three-level hierarchy, source Hide ownership, archive and settings survive upgrade.
- No automatic generation/compression, external server, cloud upload or second generation implementation.
- Preview defaults on; disabling it permits saving only a successful manually requested episode. Failures preserve the range.
- The third icon exists only at the valid end boundary and never opens the main window. Successful saving clears only that draft's temporary range.
- A full JSON includes inactive descendants, all texts/links/flags, three prompt groups and whitelisted extension settings; no chat messages or API credentials.
- Restore defaults to inactive new records and keeps current global prompts/settings. User can explicitly restore original effective active records after conflict/limit checks.
- Cross-chat source provenance is detached even if message IDs happen to match. Historical ranges remain readable; no foreign Hide, range markers, regeneration or replacement bindings.
- Merge is idempotent by source chat+record ID; collisions from different origins are remapped with all links. Existing conflicting records are retained and reported.
- Validate all structural/configuration data before any writes. One archive replacement, readback verification and safe rollback on failure; never write rollback into another chat.

## Review Focus

- Double taps, preview cancellation, failed save, generation cancellation and late chat changes must not create duplicates or clear a newer selection.
- Foreign sources with matching UUIDs/hashes must never bind to a new chat, including after export/import again.
- Repeat merge, same-ID different origins and independently edited copies must preserve texts/links and not silently overwrite records.
- Invalid nested history, malformed prompt/settings or token overflow must leave archive and global state unchanged.
- Switching chats or closing restore confirmation must never import or roll back into another session; valid whole saves must remain recoverable on readback failure.

### Task 1: Full backup format, provenance and pure restore planning

**Files:** src/backup.js (new), src/core.js, src/order.js, tests/backup.test.js, hierarchy/core tests.
**Interfaces:** createBackup(archive,settings,source), parseBackup(text), planRestore(current,backup,options), validatePromptGroups/validateBackupSettings; preserve legacy archive format support.

- [ ] Observe failing tests for complete UTF-8 roundtrip, missing/malformed fields, three-level relationships, archived entries, idempotent merging, origin collisions and source detachment.
- [ ] Add optional origin/sourceChat/detachedSources/backupActive fields without changing native legacy records on load.
- [ ] Preserve historical source order for detached entries; exclude them from live overlap/source matching.
- [ ] Run the full Node suite and commit.

### Task 2: Verified restore and existing episode generation path

**Files:** src/engine.js, tests/engine.test.js.
**Interfaces:** Engine.restoreBackup(backup,options,session), additive previewEpisodes default; unchanged generateSummary/saveDraft host API.

- [ ] Add failing tests for default-inactive/explicit-active restoration, deduplication/limits, optional globals, failed-save rollback, chat switches and detached source guards.
- [ ] Validate plan and candidate settings before commit, preserve current global object identity, verify archive save and restore previous local state on failure; attempt safe same-session rollback.
- [ ] Refuse foreign-source regeneration/restoration/replacement and block overlapping active episode versions as well as parents.
- [ ] Run all Node tests and commit.

### Task 3: Chat controls, preview setting and backup UI

**Files:** src/ui.js, style.css, browser test scripts.
**Interfaces:** One generating path with inline progress option; preview resolves save/cancel; existing native dialogs/window lifecycle retained.

- [ ] Add browser RED scenario for conditional book-plus action at valid end, no main-window open, preview edit/regenerate/cancel, one save, error/range persistence and automatic save with preview off.
- [ ] Add bronze book-plus SVG and Ravenclaw lower menu/dock styles; preserve neighboring ST controls.
- [ ] Add previewEpisodes toggle and complete-backup block with one export and a validated restore dialog: counts, merge/replace, optional activation, prompts/settings choices and explicit replace warning.
- [ ] Exercise full export/repeated restore/new chat/corrupt file/same UUIDs/chat change on mobile; capture changed views and icons.

### Task 4: Review and authorized publication

**Files:** README.md, docs/ui-1.6.0.md, docs/images, package/manifest/UI_VERSION.

- [ ] Run unit/module checks, existing hierarchy/window regressions and real generation/save/Hide integration.
- [ ] Obtain one independent whole-change review, fix material findings with RED→GREEN and green suite.
- [ ] Publish main and v1.6.0 tag, verify clean public clone and public manifest, provide update instructions and actual screenshots.

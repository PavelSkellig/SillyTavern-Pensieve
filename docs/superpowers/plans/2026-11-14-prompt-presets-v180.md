# Shared three-level prompt presets · v1.8.0

> Execute inline using superpowers:executing-plans; one independent final whole-branch reviewer. Standing user preference: implement/publish without repeated approval.

**Goal:** Implement текст (14).txt on published v1.7.0 without changing memory generation/archive/injection algorithms.
**Architecture:** Keep existing settings.prompts three text/history groups as the single backing store; align preset IDs/names and selected ID across all three. One logical preset owns three records. A focused src/prompt-presets.js validates, migrates legacy independent groups without losing records, and handles shared selection/CRUD/preset JSON/backup merge. Existing Engine.prompt remains the generation entry point. Existing memories and literal generation pipeline untouched.
**Spec:** C:/Users/PavelPC/Downloads/Telegram Desktop/текст (14).txt.
**Tech:** Existing native JS modules, scoped CSS, Node tests, real disposable ST1.19.0 Chromium/WebKit with synthetic replies.

## Constraints / review focus
- Exact canonical Основной texts supplied by user in pensieve-prompt-summary 2.txt, pensieve-prompt-arc 2.txt, pensieve-prompt-volume 2.txt. Preserve every character; independent SHA256 checks pin the generation boundary and restore/export.
- Injection template new default {{memory_echo}}, one-time empty migration only; retain customized nonempty templates and NONE/native placement/role/depth behavior.
- One shared chooser, chapter/part/volume editor tabs retained; drafts per preset+level survive switching, save and previous-version actions operate on the selected record. Builtin default protected from delete/rename/import collisions; restore full original triplet explicitly.
- Legacy independent selections become one saved triplet; preserve every saved legacy record/text/history in migrated bundles, not index zipping. Global presets independent of chat archives.
- JSON pensieve-prompt-preset v1 uses chapter/part/volume, text byte-for-byte; invalid parse atomic; import adds one selected bundle and resolves names uniquely.
- Full backups include all shared bundles; repeat restore idempotent and preserves local/imported distinct content without removing builtin. Keep recovery/rollback safe and verified; old backups still accepted.

## Task1: shared preset data + migration
- [x] RED preset JSON roundtrip, three-level selection/save/history, builtin protection, old selected combinations and unmatched legacy records, collision-safe idempotent merge.
- [x] Add prompt-presets.js and wire settings migration/template default, Engine.prompt selection. Preserve history and memory/archive fields; canonical prompt literals await user input.
- [x] Node suite/check GREEN; commit.

## Task2: existing UI + full backups
- [x] RED backup old/new restore repeated/conflicting IDs and rollback verification. Wire merge at existing globals restore/import boundary, without weakening transactional checks.
- [x] Common chooser + compact Создать/Импорт/Экспорт, three tabs and per-prompt save/version/txt/expand, protected restore-builtin and whole-preset rename/delete. No duplicate listeners or global CSS.
- [x] Native browser import/export file transfer, switch all3, restore builtin, unsaved drafts, mobile320/390, global chat switch and reload, actual generation uses selected triplet literally. Existing archive/Memory Echo regressions.

## Task3: exact builtin + release
- [x] Integrate exact user-provided original three texts unchanged; verify agreed limits/rules. Required before final feature completion/publication.
- [x] Docs/screenshot/version1.8.0, full checks and one fresh independent read-only final review. Fix Critical/Important once via RED→GREEN, no repeated review.
- [ ] Authorized publication main/tag atomic; public manifest + clean clone tests; stop own test server and remove only this plan scratch after path validation.

## Checkpoint 2026-11-14

Data model, UI, template migration and full-backup integration are implemented on codex/pensieve-v1.8.0. Node187/187/check15 and Chromium/WebKit shared-preset scenarios pass; WebKit draft/backup/MemoryEcho regressions pass. Exact full canonical prompt literals remain required from user. No guessed replacement, release/version bump, independent final review or public push has been performed. Resume from work/v180/progress.md after the required texts arrive.

## Resumed with originals

All3originals supplied and integrated exactly. Fresh node189/189/check16; actual builtin generation and shared-preset workflows passed Chromium/WebKit. Final independent branch review and release verification follow.

Final independent review:3Important fixed RED→GREEN in one pass; no Critical. Node192/192/check16, real Chromium/WebKit exact builtin requests, restore UI, CRLF/no-op save and WebKit backup/MemoryEcho regressions passed. Release verification follows.

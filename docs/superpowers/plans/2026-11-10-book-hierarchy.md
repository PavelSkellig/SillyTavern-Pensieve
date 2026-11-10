# Episode → Chapter → Volume implementation plan

> **For agentic workers:** Use superpowers:executing-plans in this session, task by task, with one independent whole-change review. Steps use checkbox syntax for tracking.

**Goal:** Publish v1.5.0 on top of v1.4.0 with three manually generated memory levels and reference bookmark actions.

**Architecture:** Preserve legacy summary/arc IDs, archive records, prompt keys and save/readback/Hide journal. Add volume records with chapterIds; centralize read-only hierarchy traversal and presentation names. Extend existing generation, selection and archive views rather than replacing them.

**Tech Stack:** Native JavaScript/HTML/CSS, Node tests, disposable SillyTavern 1.19.0 and Playwright Chromium/WebKit.

**Spec:** User's Downloads/Telegram Desktop/текст (4).txt, supplied bookmark image, explicit “Внедрить и опубликовать” response on 10 November 2026.

## Global Constraints

- Existing texts, titles, prompt presets/history, flags, links and message ranges are not rewritten on load.
- Summary/arc remain internal legacy keys; visible names are Эпизод/Глава; volume is an additive type with chapterIds.
- All generation is manual, literal user prompts retain the existing host path and durability gate; no new API.
- An active volume suppresses linked chapters and their episodes; activation/deactivation never resurrects children automatically.
- Chronology derives recursively from original message ranges; manual generation order remains possible.
- Preserve Ravenclaw styles, all five tabs, minimize/restore, range persistence and native drawer.
- Two semantic click-only bookmark actions: 18–20px star/check SVG, 32–36px hit area, no oval surround.

## Review Focus

- Legacy archive/prompt loading, repeated loading and mixed imports must not rewrite user data or remap existing IDs.
- Overlapping volumes, missing children and changed descendants must not silently duplicate or corrupt injected memory.
- Cancel, pending-save recovery and chat switches during volume generation must preserve the existing safety gates.
- Disabling/deleting a volume must preserve descendants and avoid automatic activation; linked child deletion must warn and preserve hierarchy.
- Narrow screens must accommodate three archive/prompt segments, source selection, hierarchy navigation and both bookmark actions.

### Task 1: Compatible hierarchy and data projection

**Files:** src/hierarchy.js (new), src/core.js, src/order.js, src/view-state.js, tests/hierarchy.test.js, existing core/order/view tests.

**Interfaces:** childrenIds(entry), hierarchyIndex(entries), level/type labels, display titles; existing memoryEntries/memoryConflicts/validateArchive/mergeArchives APIs retained.

- [x] Write and observe failing tests for volume suppression, volume+new episode, overlapping coverage, recursive chronology, read-only legacy display, transitive review flags, roundtrip/import/merge and invalid child types.
- [x] Add volume validation and remapping without adding fields to old records; retain archive container version and legacy links.
- [x] Extend memory projection and source ordering to all levels; separate effective activation and parent membership.
- [x] Run the complete Node suite and commit the independently tested data layer.

### Task 2: Manual volume generation using the existing engine

**Files:** src/engine.js, tests/engine.test.js or tests/volume-engine.test.js.

**Interfaces:** Engine.generateVolume(chapterIds, options), retained generateArc/generateSummary, additive prompts.volume; saveDraft uses child IDs and sourceVersions.

- [x] Add failing tests for three independent prompts, unchanged old presets, exact selected chapter order, cancel/context limits, chat switch, stale source rejection and pending commit recovery.
- [x] Reuse the existing combined-record path; preserve host.generate, persistence/readback and source Hide behavior.
- [x] On explicit volume activation deactivate covered descendants; on disable never reactivate them. Protect linked-child deletion; propagate review flags without rewriting parents.
- [x] Run the complete Node suite and commit.

### Task 3: Existing interface and bookmark reference

**Files:** src/ui.js, panel.html, style.css, browser regression scripts.

**Interfaces:** Existing UI/window lifecycle and engine APIs; separate source selections for chapters and volumes; hierarchy content dialogs are read-only navigation into existing records.

- [x] Add browser regressions for retained legacy records/prompts, manual generation of every level, three archive/prompt segments and recursive source navigation.
- [x] Rename UI labels with legacy title projection, add home/drawer volume action and compact counts, both selection/order workflows, token totals and actual status/membership links.
- [x] Add contents navigation, linked-deletion warning, three-way prompt import/export compatibility and independent editable volume preset.
- [x] Use the two requested bookmark SVGs, preserve no-auto-open range selection, and notify reversed boundaries.
- [x] Verify phone widths, touch/icon actions and minimize/restore; capture all five real views.

### Task 4: Review and authorized release

**Files:** README.md, docs/ui-1.5.0.md, docs/images, manifest.json, package.json, UI_VERSION.

- [ ] Run complete unit/module checks and relevant browser integration including recovery, data persistence and no source duplication.
- [ ] Obtain independent whole-change review, reproduce/fix material findings and run the green suite.
- [ ] Publish main/tag v1.5.0, verify clean public clone and public manifest, provide screenshots and update instructions.

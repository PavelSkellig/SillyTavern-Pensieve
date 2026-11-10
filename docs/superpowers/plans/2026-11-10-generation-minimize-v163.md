# Generation-window minimization · v1.6.3

> Execute inline with superpowers:executing-plans and one final independent review.

**Goal:** Implement/publish «текст (8).txt» with the supplied progress-window reference, continuing immediate-publication preference.
**Architecture:** Add a UI-only GenerationView controller. Keep Engine/host request, cancellation and persistence paths. One owned job tracks running/ready/error/preview/save, retains the same request/draft while hidden, and exposes a compact in-flow indicator. Capture source parameters/session for retries. Main-window minimization is reused when hiding progress so chat is actually accessible.
**Spec:** Downloads/Telegram Desktop/текст (8).txt and attached reference.

## Constraints/review focus
- Minus hides progress/backdrop without cancellation, persistence or another request. Indicator restores progress or the existing preview, without opening the main window.
- Hidden ready results require manual Save except existing preview-off episode autosave. Chapters/volumes always preview. One UI job prevents duplicate requests/results; cancel really invokes existing stopGeneration.
- Errors remain restorable with explicit retry; save retry reuses the existing draft/commit identity. Closing/canceling and chat-session invalidation must prevent late preview/save.
- Freeze episode bounds/selected children and assert original session/source references on retry. No cross-chat generation/source binding.
- In-flow dock above send_form must not overlay controls; no fake percentage or promise of iOS background execution. Existing ST parallel-generation lock remains.
- No generation/storage/prompt/memory-format rewrite; all source Hide happens only through verified save.

## Task 1
- [x] RED browser case for minus on delayed episode request, then all3 levels/ready hidden/restore/error retry/cancel/preview-off autosave/chat switch and unchanged archive before confirmation.
- [x] Add controller and minimal UI integrations/styles, preserving existing preview. Node checks and Chromium/WebKit actual-ST regressions.
## Task 2
- [x] Independent read-only review; material fixes RED→GREEN, screenshots/docs.
- [x] Version1.6.3 and release verification prepared.
- Release gate: main/tag atomic publication, public manifest and clean clone checks; results recorded in the release session.

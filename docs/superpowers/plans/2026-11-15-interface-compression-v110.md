# Interface and per-record compression · v1.10.0

> Existing dedicated checkout, inline implementation. User explicitly requests no review or tests; do not launch agents, test runners, browser suites or review workflows. Publish under standing authorization.

Spec: текст (20).txt. Header asset: user-provided codex-clipboard-808e4094-bd50-4833-940f-4cc03449a71d.png, copied unchanged.

1. Add a focused compression module and host counting adapter: pin the model/tokenizer recipe for each operation, count actual source/output without generation prompts, persist the immutable source baseline plus output, provide consistent character-based estimates when tokenizer is unavailable. Editing changes only output statistics, preserves baseline and prior-version statistics. Counts are optional metadata and cannot prevent a memory save.
2. Extend archive/history validation and backup merge to preserve optional statistics without migrating or recalculating old records. No changes to IDs, links, generation prompts, source visibility/ownership, active-memory compilation or recovery algorithms.
3. Replace home with two collection actions and actual compiled-memory state. Render existing hierarchy in Memory with small symbols, lazy children, individual stats and whole-block usage. Remove per-card recounts on each render. Move technical tools under closed maintenance; keep prompt editors and existing settings. Default macro-only applies only to new/missing settings.
4. Replace castle decoration with the supplied image using contain sizing. Add scoped responsive styles; preserve mobile tab/editor state and chat range creation. Update version, release notes and publish main/tag. Check publication metadata only, not functional behavior.

Decisions: additive optional compression metadata needs no data migration; existing archives/settings/prompts remain in native storage. Old records do not get fabricated source counts. A tokenizer recipe is retained so edits can use the same method; if it is unavailable, preserve original counts and show a consistently estimated pair separately. Native current-model fallback is marked approximate and model changes cannot silently mix counters. Savings are per record only. No aggregate savings.

Implementation record: optional compression fields and historical snapshots added; saves count only the current operation, edits retain the source baseline, old records remain unmodified, backup merge enriches missing matching metadata only. Home/memory/maintenance and supplied image implemented with scoped responsive CSS. No review, static checks, test runners, browser sessions or functional validation were run, per user instruction. Publication metadata is checked separately.

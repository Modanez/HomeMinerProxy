# ADR-0004: Portuguese-First HTML Source with Deterministic Translation Table (`src/i18n.js`)

**English** · [Português](0004-bilingual-pt-source-with-i18n-table.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The dashboard (`src/painel.js`) is a single-file server with embedded HTML, CSS, and client-side JavaScript. It must support both **Brazilian Portuguese (`pt-BR`)** and **English (`en`)** across all screens, numbers, currencies (`BRL` / `USD`), and narrative text without adding a client-side i18n framework or duplicating the entire HTML template.

## Decision

1. **Portuguese-First Template (`PAGE` in `src/painel.js`)**: The master HTML/JS template in `src/painel.js` is written directly in readable Brazilian Portuguese.
2. **Deterministic Translation Table (`src/i18n.js`)**:
   - `EN_PAIRS` maps every Portuguese phrase/snippet in the template to its English counterpart, sorted longest-first to prevent partial substring collisions.
   - `localizePage(html, lang, currency)` produces and caches the localized HTML per language (`pageCache[lang]`), injecting `LOC` (`pt-BR` or `en-US`) and `CUR` (`BRL` or `USD`).
3. **Automated Completeness Guard (`tests/i18n.test.js`)**:
   - Verifies that every Portuguese key in `EN_PAIRS` exists in `src/painel.js` (catches stale translations when UI text changes).
   - Compiles the extracted `<script>` in both languages using `new vm.Script()` to guarantee valid JS syntax after replacement.
   - Scans the English output for leftover Portuguese words or diacritics.

## Consequences

- **Positive:**
  - Single HTML/JS source of truth in `src/painel.js` with zero runtime client-side translation overhead (pages are translated once and cached in memory).
  - Impossible to ship broken English JS syntax or orphaned translation keys when `npm test` runs.
- **Negative / Trade-offs:**
  - Editing any Portuguese text in `src/painel.js` requires updating the corresponding entry in `src/i18n.js`.


# Outline skeleton + separated read-source — outline redesign

**Status:** implemented

## Problem

First real-world use of `jarpeek outline` exposed three presentation defects:

1. **The table is unreadable at real signature widths.** `render.ts` caps every
   cell at 60 chars and every row at 120, fixed regardless of terminal — on a
   Spring-sized API nearly every signature ends in `…` and the answer looks
   broken. Aligned padding also spends tokens on spaces, the one thing an
   agent-frugal tool should not do.
2. **`outline` and `read-source` print the same output.** `readSource()`
   defaults to mode `outline`, which delegates to `outline()` — so the two
   commands are visually identical. `read-source`'s default answers the wrong
   question for a human ("show me the code" gets a member table).
3. **Nested classes render twice.** `familyRecords` keeps a nested class both
   as the outer class's member row (fqn = outer) and as its own class row
   (fqn = outer.Inner) — the four inner classes of `RestTemplate` each appear
   twice in one outline.

The legacy tool (GH#3) solved presentation better: a Java-shaped skeleton —
package, imports, class header, members as code lines at indentation levels —
with `--minimal`/`--full` truncation levels. That shape is also more frugal:
code-shaped text is what both humans and LLMs read natively. The archived lazy
spec rejected the legacy *CLI surface* (paths, config, pager chrome); this spec
adopts only its outline presentation model.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | `outline` renders a **Java-shaped skeleton** — comment metadata header, package, imports (source provenance), members as signature lines at indentation levels, nested classes with their own members. **No clipping**: one declaration per line, the terminal wraps. The table survives only behind `--table`. |
| 2 | `read-source` **defaults to `full` everywhere** — the core `readSource()` default flips from `outline` to `full`, so CLI and MCP agree by construction. `mode: "outline"` remains an explicit choice. |
| 3 | Section control = **presets + toggles**: `--minimal` / default / `--full` presets, plus `--imports/--no-imports`, `--fields/--no-fields`, `--methods/--no-methods`, `--inner/--no-inner`, `--javadoc/--no-javadoc` pairs that override the preset per-section. |
| 4 | **MCP mirrors CLI exactly**: `outline` gains optional `preset` and `sections` params with toggle-over-preset semantics; one shared resolver (preset + overrides → effective booleans) serves both surfaces. `--table` is the one non-mirrorable flag — pure presentation; MCP always returns data, the same object `--json` prints. |
| 5 | **Javadoc ladder**: `--minimal` → none; default → first sentence of the description (block tags dropped) as one compact line; `--full` → the complete block. Powered by a new additive `Declaration.javadoc` field — the lexers already capture the text (`JavadocInfo.text`) and discard it. Source provenance only; class files and decompiled output carry no javadoc. |
| 6 | Signatures stay **types-only** (no parameter names) — they are the canonical strings `#name(T1,T2)` selectors match against. Re-formatting them would ripple through selector syntax; out of scope. |
| 7 | Rejected: **fork-by-surface defaults** (MCP keeping a frugal `outline` default while CLI goes `full`) — chosen first, then superseded by the uniform-contract decision; **dropping `outline` mode from `read_source`** (breaking for no gain); **toggles-only** and **presets-only** control (can't express both common and specific wants). |

Consequence of #2/#4, accepted with full information: an agent calling
`read_source` without a mode gets the complete file — on a decompiled
3,000-line class that is the context blowout jarpeek exists to prevent. The
mitigation is cheatsheet discipline (outline / `read_member` as the frugal
entry points), not a hidden default.

## Command contracts

### `jarpeek outline <fqn>`

| Flag | Meaning |
|---|---|
| `--kind <k>`, `--visibility <v>` | Row filters, unchanged — applied before rendering |
| `--minimal` | Preset: imports off, fields off, javadoc off |
| `--full` | Preset: everything on, javadoc as complete blocks, elided-body markers |
| (default) | Preset: everything on, javadoc as first-sentence summary |
| `--imports/--no-imports` … `--javadoc/--no-javadoc` | Per-section overrides of the preset |
| `--table` | Legacy tabular view over the same filtered rows; skeleton-only sections (imports, javadoc) do not apply |

### `jarpeek read-source <fqn>`

Default (no flags) = `full` numbered source, the existing full renderer
(header line + numbered lines). `--lines a:b` unchanged. `--full` remains as
an explicit self-documenting form; `--full` + `--lines` stay mutually
exclusive. No CLI flag reaches outline mode — that is `outline`'s job.

### MCP

- `read_source`: `mode` stays optional (`outline` \| `full` \| `lines`),
  default now `full` — flipped in the core, not per-surface.
- `outline`: new optional `preset` (`"minimal"` \| `"outline"` \| `"full"`)
  and optional `sections` (`{ imports?, fields?, methods?, inner?, javadoc? }`,
  booleans). `sections` wins over `preset` per field. Existing `kind` /
`visibility` params unchanged.
- Both surfaces call one shared preset resolver in the core; drift is
  impossible by construction.

## Skeleton format

The same data that produced the broken table renders as:

```java
// org.springframework.web.client.RestTemplate
// org.springframework:spring-web:5.3.22  provenance source
package org.springframework.web.client;

public class RestTemplate {
    private static final boolean shouldIgnoreXml;
    private final List<HttpMessageConverter<?>> messageConverters;

    /** Retrieve a representation by doing a GET on the specified URL. */
    public <T> T getForObject(String, Class<T>, Object...);

    private class AcceptHeaderRequestCallback {
        public void doWithRequest(ClientHttpRequest);
    }
}
```

Rules:

- **Metadata as comments**: fqn, coordinates, provenance, stale flag render as
  leading `//` lines so the body stays copy-pasteable code.
- **Members render from `Declaration.signature` verbatim**, `;`-terminated,
  one per line. Constructors, fields, and all class kinds (interface, enum,
  record, annotation, object) use their signature strings as-is — Kotlin
  included.
- **Indentation by nesting level**: outer members at one level, a nested
  class and its members one deeper. Grouping is by declaring fqn.
- **Imports** render (when the section is on) only for `source` provenance —
  the entry is already read and lexed for declaration parsing; capturing
  import lines during that parse is nearly free. Silently omitted for
  `signature` provenance (class files carry no imports).
- **Javadoc** per the ladder above; a long first sentence is capped with an
  ellipsis rather than wrapped.
- **`--full` body markers**: methods and constructors gain `{ … }` on their
  line, distinguishing "body elided" from abstract methods. Presentation
  only; the data contract is unaffected.
- **No clipping anywhere** in the skeleton — no columns exist to align.

## Data layer

All changes live in the existing one-file parse path; no new I/O.

- `Declaration` gains optional `javadoc?: string` (raw doc body). The Java and
  Kotlin lexers already produce `JavadocInfo.text`; the parse seam threads it
  through instead of discarding it. Binary/classfile parsing never sets it.
- `OutlineResult` gains optional `imports?: string[]` (source provenance
  only), captured by the source lexers in the same pass.
- `familyRecords` keeps **all** family records — nested-class members are
  parsed today and filtered away; the skeleton renders them. Nested class
  rows are deduplicated against the outer class's same-selector member rows,
  so a nested class appears once in `rows` and once in the render.
- `OutlineOptions` gains `preset?` and `sections?`; the shared resolver turns
  them into effective section booleans. `sections.javadoc: false` strips
  javadoc fields from rows at data level (JSON/MCP consumers get the same
  savings); summary-vs-full remains a CLI rendering distinction over rows
  that always carry the full text.
- `readSource()`'s default mode becomes `"full"`.

## What stays untouched

Tables for `find-class` / `search-symbols` (genuinely tabular, short cells),
`--json`/MCP row shapes (additive fields only), `read-member` (its javadoc
slicing already works), the miss protocol, warning budgets, error handling.

## Testing

- Skeleton renderer: preset expansion, each toggle override, grouping and
  indentation by declaring fqn, dedup, imports/javadoc presence by
  provenance, first-sentence extraction and capping, body markers, metadata
  comment header.
- Shared preset resolver: CLI flags and MCP params produce identical section
  booleans (parity test).
- Core: `familyRecords` full-family retention; `Declaration.javadoc` /
  `OutlineResult.imports` population (Java + Kotlin lexers); `readSource`
  default `full`.
- CLI integration: outline output shape (existing table assertions
  rewritten), `--table` still renders the legacy view, read-source default
  full, `--full`/`--lines` exclusivity.
- MCP: existing tool tests stay green; new `preset`/`sections` params;
  `read_source` default flip.

## Docs & version

README (tool table rows for `outline`/`read_source`, CLI examples, provenance
section notes imports/javadoc as source-only), prime cheatsheet
(`src/prime/content.ts`: bare `read_source` returns the whole file — outline
and `read_member` are the frugal entry points), version bump to 0.3.0
(breaking: `read-source` default changes).

## Open questions

None — all decisions resolved in brainstorming.

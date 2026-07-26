# The conversion pipeline

Zotero note HTML ↔ Obsidian Markdown. Runs entirely in the Web Worker, with no
DOM dependency.

> 中文版见 [README.zh.md](./README.zh.md)。The two are equivalent; keep them in
> sync when changing either.

Two formats, neither a superset of the other. Zotero's note schema is a fixed
ProseMirror document model; Obsidian's markdown is CommonMark plus GFM plus a
handful of Obsidian-only forms. Most of the work in this module is deciding, per
syntax, what to do when one side has no way to say what the other just said.

---

## 1. Scope and vocabulary

Every syntax gets one of three strategies. The word appears in each feature
file's header comment, and it is worth being strict about which one applies:

| Strategy | Meaning | Example |
| --- | --- | --- |
| **map** | Both sides have the construct; convert between them. | `<strong>` ↔ `**bold**` |
| **preserve** | One side has no construct, but the other's spelling survives as inert content. Round-trips exactly. | `[[Note]]` is plain text to Zotero |
| **degrade** | Neither representable nor preservable. Information is lost, deliberately and once. | a fence's `` ```python `` info string |

A degradation must be *recorded*, never silent — see `OpaqueReason` in
`model/nodes.ts` and the "Known gaps" section below. The distinction between
"preserve" and "degrade" is the single most useful question to ask when adding
a feature, because preserve is almost always available and almost always
better: Zotero stores unrecognised text verbatim, so anything that survives as
text survives forever.

---

## 2. The two pipelines

`html-to-md.ts` and `md-to-html.ts` are orchestration only — a few hundred
lines between them, down from 1211 before the restructure. They contain no
syntax decisions. Every such decision lives in `features/`, one file per
syntax, both directions in that file.

### html → md (`html2mdWithProcessors`)

```
html string
  │
  ├─ processors.parseHtml                 rehype-parse, fragment mode
  ├─ (wrapper <div data-schema-version> lifted out; see §7)
  │
  ├─ runCleanHast(tree, ctx)              feature stage 1   HAST
  ├─ rehype-remark                        feature stage 2   HAST → mdast
  │      newlines: true
  │      handlers: buildHastHandlers(ctx)
  ├─ runTransformMdastIn(tree, ctx)       feature stage 3   mdast
  ├─ processors.stringifyMarkdown         feature stage 4   mdast → string
  │      handlers: buildStringifyHandlers(ctx)
  ├─ runPostSerializeMd(md, ctx)          feature stage 5   string (last resort)
  │
  └─ prepend `<!-- ZF_NOTE_META … -->`
```

`newlines: true` is load-bearing: it preserves hand-written line breaks inside
a paragraph, so `<p>123\n[[link]]\n123</p>` round-trips as three lines instead
of collapsing to one.

### md → html (`md2htmlWithProcessors`)

```
md string
  │
  ├─ matchLeadingNoteMeta                 strip `ZF_NOTE_META`, keep attrs
  ├─ processors.parseMarkdown             remark-parse + GFM (§6) + math
  │
  ├─ runTransformMdastOut(tree, ctx)      feature stage 1   mdast
  ├─ processors.mdastToHast               feature stage 2   mdast → HAST
  │      remark-rehype, allowDangerousHtml
  ├─ runTransformHast(tree, ctx)          feature stage 2   HAST
  ├─ processors.stringifyHtml             HAST → string
  ├─ runPostSerializeHtml(html, ctx)      feature stage 3   string (last resort)
  │
  └─ wrap in `<div …>` using the lifted attrs
```

**Nothing rewrites the raw markdown string before parsing.** This is a hard
rule, not a preference. micromark resolves block and inline structure first, so
`code` and `inlineCode` become node types the feature passes simply never
visit. A whole-string regex cannot tell prose from the inside of a fence; five
such passes used to exist here, and they corrupted every note that documented
markdown syntax — irreversibly, because the sentinels they injected were
HTML-escaped inside `<pre>` and the restore pass then failed to match them.

The same rule is why `postSerializeMd` / `postSerializeHtml` exist but are
almost unused: they are for things with no AST representation at all (a
serializer escape no handler can reach). Two features use them, both with a
stated reason.

---

## 3. The feature contract

`features/types.ts`. A feature implements only the hooks it needs; the registry
composes them. The axis of change here is the **feature**, not the pipeline
stage — adding Obsidian syntax means answering "how does this go out, and how
does it come back", so those two answers belong in one file. Splitting by stage
is what previously smeared task lists across four call sites in two files,
where changing one and forgetting the others was the default outcome.

The eight hooks, four per direction, one per representation the document passes
through:

```
html → md :  HAST ──→ (handlers) ──→ mdast ──→ markdown string
             cleanHast  hastHandlers   transformMdastIn / stringifyHandlers
                                       postSerializeMd

md → html :  mdast ──→ HAST ──→ html string
             transformMdastOut  transformHast  postSerializeHtml
```

| Hook | Runs on | Use it for |
| --- | --- | --- |
| `cleanHast` | parsed note HAST | normalising Zotero's HTML before anything reads it |
| `hastHandlers` | per HTML tag | what a Zotero element becomes in mdast |
| `transformMdastIn` | mdast (inbound) | anything that needs the tree, not the tag |
| `stringifyHandlers` | per mdast node type | how a node is written as markdown |
| `postSerializeMd` | markdown string | last resort only |
| `transformMdastOut` | mdast (outbound) | markdown-side rewrites before HTML generation |
| `transformHast` | HAST (outbound) | shaping the HTML into Zotero's expected form |
| `postSerializeHtml` | html string | last resort only |

`FeatureContext` is everything a feature may vary on: `annotationImageFolder`,
`strictLineBreaks`, `linkCitationSpans`.

### `PASS`

One HTML tag can carry several unrelated features. A Zotero `<span>` is
variously math, a citation payload, an annotation payload, a highlight, a
strike mark, a colour mark, or just a wrapper. Handlers for the same tag are
therefore chained in registry order, and a handler that does not claim the node
returns `PASS`.

`PASS` is a symbol rather than `undefined` because `hast-util-to-mdast` reads
`undefined` as "this node produces nothing" and would silently delete the
content. If every feature declines, rehype-remark's own default handler runs.

---

## 4. Ordering

`features/index.ts` holds the registry. Order is part of the contract, and the
constraints that actually matter are documented there. Summarised:

| Constraint | Why |
| --- | --- |
| `note-structure` first | everything downstream assumes a cleaned tree |
| `citation-links` before the payload features | the anchors it injects must be inside the spans before those are captured verbatim |
| `math` before `zotero-payloads` / `span-unwrap` | `<span class="math">` would otherwise be swallowed by generic span handling |
| `math` before `code-block` (outbound) | the code flattener would erase `<code class="… math-display">` |
| `zotero-payloads` before `marks` | a span with both an annotation payload and a strike style must keep the payload |
| `span-unwrap` last of the span claimants | it is the unconditional fallback |
| `callout` before `obsidian-syntax` | both rewrite a paragraph's leading text node |

Current order:

```
note-structure → citation-links → math → zotero-payloads → marks →
span-unwrap → annotation-image → table → list → task-list →
callout → obsidian-syntax → code-block → line-breaks → link
```

---

## 5. Custom mdast nodes

`model/nodes.ts`. Markdown has no syntax for several things a Zotero note
contains, and Obsidian has syntax CommonMark does not know about. Both used to
be smuggled through as bare `{ type: "html" }` nodes, which overloaded one node
type with three unrelated jobs — Zotero payload passthrough, escape bypass for
Obsidian syntax, and a carrier whose `value` was actually *markdown*. Nothing
downstream could tell them apart, so a lossy degradation looked identical to a
deliberate one.

| Node | Carries | Owner |
| --- | --- | --- |
| `zoteroOpaqueHtml` | a verbatim run of Zotero HTML, plus an `OpaqueReason` | `zotero-payloads.ts`, `table.ts` |
| `zoteroAnnotationImage` | the original `<img>` tag, the extracted PNG path, the width | `annotation-image.ts` |
| `obsidianRaw` | Obsidian-only inline syntax that must reach the vault unescaped | `obsidian-syntax.ts`, `callout.ts` |
| `u` / `sub` / `sup` (`InlineHtmlMark`) | a phrasing **container**, so nested marks survive | `marks.ts` |

`OpaqueReason` is one of `citation`, `annotation`, `styled-table`,
`colored-text`, `unknown-zotero-node`. It exists so a degradation stays
attributable.

`InlineHtmlMark` being a `Parent` rather than a `Literal` is the point: `<u><a
href>link</a></u>` used to keep only `toText()` and lose the URL.

`inlineMath` / `math` come from `mdast-util-math` and are deliberately not
redeclared.

---

## 6. GFM, composed by hand

`gfm.ts`. `remark-gfm` bundles footnote support with no per-feature toggle, and
ZotFlow must **not** parse footnotes: Zotero's schema has no footnote node, so
`[^1]` would become `<sup><a>` and `[^1]:` a `<section data-footnotes>`,
neither of which `html2md` can reverse.

Composing GFM by hand and simply omitting the footnote extension makes `[^1]`
ordinary text. It then round-trips verbatim with no sentinel, and micromark's
block/inline structure keeps it untouched inside code. Enabled: autolink
literal, strikethrough, table, task-list-item. Omitted: footnote, and
`tagfilter` (which neuters raw HTML, whereas ZotFlow deliberately round-trips
raw Zotero HTML).

The lesson generalises: **parsing something the destination cannot represent is
worse than not parsing it.** The footnote sentinel hack is what corrupted code
fences. Weigh this before reaching for any new micromark extension.

---

## 7. `ZF_NOTE_META`

Zotero note HTML is wrapped in `<div data-schema-version data-citation-items>`.
Markdown cannot express that wrapper, so `html2md` serialises the div's
attributes into a leading HTML comment and `md2html` rebuilds the wrapper from
it.

Handled by the pipeline rather than by a feature, because unwrapping produces a
value the caller has to thread back out.

The marker's single source of truth is `src/utils/note-meta.ts` —
`matchLeadingNoteMeta`, `stripLeadingNoteMeta`, `formatNoteMeta`,
`createNoteMetaScanner`. Four call sites used to carry their own copy of the
regex and had already drifted: the converter accepted two legacy spellings the
two UI matchers did not, so a legacy-format note rendered its meta line as
visible, editable body text.

The match is anchored at offset 0, which is what makes it safe — unlike the
syntax passes, it cannot collide with document content.

---

## 8. The escaping policy

This is the subtlest part of the module and has been the source of five
content-destroying bugs. Read it before writing any handler that emits a
payload verbatim.

`mdast-util-to-markdown` escapes text so it cannot be re-read as markdown.
`state.unsafe` is **not one global list**: each entry names the construct it
applies in, and `safe()` keeps only those in scope for the current
`state.stack`.

`obsidianRaw` exists because Obsidian syntax *must* be re-readable — `[[Note]]`
has to come back as a wikilink, not `\[\[Note]]`. The obvious implementation is
to return `node.value` untouched. That is wrong, and expensively so: it opts
out of every rule, including ones that have nothing to do with brackets.

```
{character: '|',  inConstruct: 'tableCell'}   ← ignoring this tore
                                                `[[Beta|Gamma]]` into two cells
{character: '\n', inConstruct: 'tableCell'}   ← ignoring this split one table
                                                row into two
```

Both were written back to Zotero and kept mutating on every sync. Patching each
rule as it is noticed cannot converge — the set is whatever `state.unsafe`
holds, and extensions add to it.

So the policy is inverted. The handler calls `state.safe()` with `state.unsafe`
filtered by `isContainerScoped`:

- **Content rules** — scoped to `phrasing`, or to no construct at all via
  `atBreak` — guard against a run of text being re-read as markdown. That is
  exactly what these nodes want. **Dropped.**
- **Container rules** — `tableCell`, `titleQuote`, `destinationLiteral`, … —
  guard against breaking out of the surrounding construct. Nothing to do with
  Obsidian syntax, everything to do with not corrupting the document. **Kept.**

Naming characters instead does not work, and the attempt is preserved as a test
case. `[`, `!` and `#` are what the forms are made of, but escaping `&`, `_` or
`~` breaks them just as badly: Obsidian matches a wikilink target literally, so
`[[A\&B]]` does not find the note `A&B`. That list has no natural end. Scoping
has one — `phrasing` is the generic "this is inline text" scope, so a rule
naming only it is a content rule by construction.

`isContainerScoped` and `safeInContainer` live in `features/types.ts` because
three other handlers emit verbatim phrasing content and therefore share the
problem — a payload span, an annotation image and inline math can all land in a
table cell:

| Handler | Payload |
| --- | --- |
| `obsidianRaw` | Obsidian syntax |
| `zoteroOpaqueHtml` | a serialised Zotero element |
| `zoteroAnnotationImage` | an `<img>` tag plus a literal `\|` width separator |
| `inlineMath` | LaTeX — **the exception, see below** |

The first three use `safeInContainer`. Markdown's escaping is reversible for
them: the GFM table parser turns `\|` back into `|` before the inline HTML is
read, so the payload arrives intact.

**Inline math is the exception and is deliberately left unescaped**, even
though `$a|b$` in a cell tears the row apart. The two tokenizers disagree:

```
| `a \| b` |  ->  inlineCode value "a | b"    (unescaped)
| $a \| b$ |  ->  inlineMath value "a \| b"   (backslash kept)
```

remark-math takes `$…$` verbatim, so an escape written into a cell is never
removed and one more backslash appears on every pass. Normalising `\|` back to
`|` on the way in is not available either — `\|` is the LaTeX norm symbol.
Emitting Zotero's `<span class="math">$…$</span>` form instead fails a third
way: the `$…$` inside the raw span is re-parsed as math and wrapped in a second
`<span class="math">`, doubling on every pass. The full analysis is in
`features/math.ts`; the gap is recorded in §12.

### The other shape: transforms that meet raw HTML

`list.ts` shapes `<li>` / `<td>` contents the way Zotero's editor does, wrapping
each text run in a `<span>`. remark does not keep inline HTML as one node —
`<span …>text</span>` arrives as a `raw` open tag, a `text` node and a `raw`
close tag — so the text in the middle is indistinguishable from a bare run by
type alone.

Wrapping it put a `<span>` *inside* the preserved element. The next inbound
pass captured that element verbatim, baking the addition into the payload, and
the pass after that added another: a citation in a Zotero-authored list grew
one nesting level per sync, without bound. `rawNesting` now tracks how many
element levels each raw fragment leaves open, and text at depth > 0 is left
alone.

The general lesson is the same as the escaping one. **A transform that assumes
it is looking at bare content will be wrong wherever an opaque payload is
spliced in**, and the failure is silent until something accumulates.

---

## 9. Feature catalogue

| File | Syntax | Strategy | Hooks |
| --- | --- | --- | --- |
| `note-structure.ts` | document shape: stray `<br>` whitespace, orphaned inline elements at root, empty paragraphs, double-encoded numeric char refs | — | `cleanHast`, `transformHast` |
| `citation-links.ts` | clickable `obsidian://zotflow` anchors around payload spans | display-only | `cleanHast`, `postSerializeHtml` |
| `math.ts` | `<span class="math">` ↔ `$x$`, `<pre class="math">` ↔ `$$x$$` | map | `hastHandlers`, `stringifyHandlers`, `transformHast` |
| `zotero-payloads.ts` | citation / annotation / colour spans | preserve | `hastHandlers`, `stringifyHandlers` |
| `marks.ts` | `<u>`, `<sub>`, `<sup>`, strike | map | `hastHandlers`, `stringifyHandlers`, `transformHast` |
| `annotation-image.ts` | extracted annotation PNGs | preserve (alt-text carrier) | `hastHandlers`, `stringifyHandlers`, `transformMdastOut` |
| `table.ts` | GFM tables; styled tables; headerless tables | map / preserve | `hastHandlers`, `stringifyHandlers` |
| `list.ts` | `<li>` repair, `<li>`/`<td>` span shaping | map | `hastHandlers`, `transformHast` |
| `task-list.ts` | `- [x]` / `- [ ]` | preserve | `transformMdastIn`, `transformMdastOut` |
| `callout.ts` | `> [!note]`, fold markers, nesting | preserve | `transformMdastIn` |
| `obsidian-syntax.ts` | `[[…]]`, `![[…]]`, `[^1]`, `^[…]`, `#tag` | preserve | `transformMdastIn`, `stringifyHandlers` |
| `code-block.ts` | fences and inline code | map (info string degraded) | `stringifyHandlers`, `transformHast` |
| `line-breaks.ts` | `<br>` ↔ newline, per `strictLineBreaks` | map | `hastHandlers`, `transformMdastOut` |
| `link.ts` | literal autolinks, `&` in destinations, `rel` | map | `stringifyHandlers`, `postSerializeMd`, `transformHast` |

`element.ts` is not a feature — it holds typed readers (`classNames`,
`hasClass`, `styleStr`) for hast's loosely-typed `properties`.

Two notes on the trickier entries:

**`table.ts`** serialises through a *nested* `toMarkdown` call, because the GFM
table extension owns the alignment and padding logic and a plain handler cannot
reach it. It passes down the full merged handler set minus `table` itself
(passing `table` would make the nested call re-enter the handler for the node
it was given). This is why `allHandlers` is captured by reference in
`stringifyHandlers` — by serialize time every feature has contributed, so cell
content behaves the same inside a table as anywhere else.

**`obsidian-syntax.ts`** uses a hand-written left-to-right scan rather than one
regex with several alternatives. The forms' bracket rules genuinely differ —
`^[…]` may hold a nested `[[…]]`, the others may hold no bracket at all — and
expressing that in a single pattern needs nested quantifiers whose backtracking
is hard to bound. One pass visits each character once.

---

## 10. Processors

`processors.ts`. `ConvertService` owns the frozen `unified()` instances and
reuses them across every note; the pipelines only need five operations:
`parseHtml`, `parseMarkdown`, `mdastToHast`, `stringifyHtml`,
`stringifyMarkdown`.

Stating those directly, rather than passing `Processor` values around, keeps
the tree types concrete at each step. unified's `Processor` is generic over its
input and output trees, and shared reusable instances must be typed loosely
enough to cover all of them — which erased the tree type at every call site and
forced a cast at each one. Those casts now live in exactly one place,
`ConvertService`'s constructor.

### Types

The module is free of `any`. Two remain, both named and documented:

- `stringifyAs<T>()` in `features/types.ts`, because
  `mdast-util-to-markdown` types a handler's node as `any` (handlers are keyed
  by node type and cannot be narrowed generically). The cast is confined to
  that one helper: callers state the node type they registered under and get a
  checked body.
- `LooseItemChild` in `features/list.ts`, for the intermediate tree
  rehype-remark produces — an `<li>` mixing text with inline math yields
  phrasing content directly under the item, which mdast's published types do
  not model.

`npm run lint:convert` gates this module at `--max-warnings 0` and runs first in
`npm test`. The rest of the repo is at roughly 1174 problems and cannot
realistically reach zero soon, so a repo-wide gate is not an option — but
without one, a module cleaned to zero drifts back. To back it out, drop
`npm run lint:convert && ` from the `test` script.

---

## 11. Tests

| Command | What it asks |
| --- | --- |
| `npm run test:convert` | `test-html-roundtrip.mjs` (66 checks) and `test-md-roundtrip.mjs` (116) — "does feature X behave as designed?" |
| `npm run test:obsidian-syntax` | 183 cases × 2 line-break modes, in both directions — "what happens to syntax nobody considered?" |
| `npm run lint:convert` | zero eslint problems in this module |

All three run in `npm test`.

### The syntax matrix

`scripts/test-obsidian-syntax.mjs` is a survival matrix, not a unit test. Every
syntax Obsidian documents is fed in as an isolated snippet and classified by
what came out. A blank spot there is the point of the test, not an omission
from it.

A case declares its source format, and that picks the direction:

```
md    Obsidian authored it.   md → html → md → html → md
html  Zotero authored it.     html → md → html → md → html
```

Both matter and they are not mirror images. Only the second sees real citation
payloads, annotation spans, styled tables and the wrapper div — and it is where
the span-accumulation and payload-in-a-cell bugs were found. Three round trips
are run rather than two, so a case that canonicalises once and then settles is
distinguished from one that drifts slowly enough for a two-pass check to call
it stable.

Verdicts, worst to best:

| Verdict | Meaning |
| --- | --- |
| `DRIFT` | the round trip is not a fixed point — content keeps mutating on every sync. **Always a failure**, whatever the recorded expectation says |
| `BROKEN` | stable, but a required token is missing or a `\` escape appeared |
| `CANONICAL` | stable and semantically intact, but not byte-identical (`-` bullets became `*`, an entity resolved) |
| `VERBATIM` | byte-identical after trimming trailing whitespace |

Each case records a reviewed `expect`, so the file doubles as a regression
gate: worse than expected is a failure, better than expected prompts an update,
and a case matching `expect: "broken"` is a documented gap. Gaps are further
split by `gap: "by-design" | "bug"` — a schema limit is a fact to record, a
pipeline limit is work.

Both `strictLineBreaks` settings are exercised. The flag mirrors one vault
setting and is threaded into **both** directions from `vaultConfig` in
production, so a mixed pair is not a configuration that can occur. Passing
different values to `md2html` and `html2md` is what previously made `<br>`
handling look broken when it was not.

### Idempotency

The md harness asserts `g(f(g(f(x)))) == g(f(x))`, not `f(g(f(x))) == f(x)`.
The round trip is allowed to canonicalise **once** — bullet markers become `*`,
`&nbsp;` becomes U+00A0 — because a hand-written test input need not already be
in canonical form. What must never happen is *drift*: an escape that grows a
backslash each pass, an entity that re-encodes, a `<span>` that accumulates.
Demanding equality on the first pass conflates the two and fails on inputs that
were simply written by hand.

---

## 12. Known gaps

Kept honest by the matrix; run `npm run test:obsidian-syntax` for the current
list.

**Lost to Zotero's schema — nothing to fix here.**

| Gap | Detail |
| --- | --- |
| fence info string | `codeBlock` in Zotero's schema has attrs `dir` and `indent` only; `parseDOM` reads nothing else and `toDOM` emits `<pre style dir data-indent>`. Confirmed against `note-editor/src/core/schema/nodes.js` |
| ` ```mermaid ` | same cause, visible consequence: without the tag Obsidian renders the source as a plain code block, not a diagram |
| YAML frontmatter | `remark-frontmatter` is not composed in; a Zotero note has nowhere to store it and the vault note's own properties are handled outside the converter |

`<pre class="math">` survives only because `math_display` is a *separate* node
in Zotero's schema with `parseDOM: [{tag: 'pre.math'}]` — ProseMirror picks the
more specific rule. Class does not survive on a bare `<pre>`. A
`<pre data-language>` would survive storage (`data-*` is in the TinyMCE
allowlist) but is dropped the moment the note is edited in Zotero's own editor,
and Zotero's own markdown parser (`fence: { block: 'codeBlock' }`) loses the
language too.

**Decided against.** These are preservable and were turned down, once, with
reasons. They are listed apart from the bugs so a settled decision does not
read as outstanding work; the full reasoning lives in each matrix case.

| Gap | Why not |
| --- | --- |
| `- [/]`, `- [?]` — Tasks-plugin statuses | Plugin syntax rather than Obsidian's own; nothing is destroyed (`\[/]` renders as `[/]`); and unlike the `#tag` exemption it cannot be derived from CommonMark — `[` is escaped everywhere because `[foo]` becomes a link if a definition exists anywhere in the document, which the serializer cannot see. The structurally correct repair, promoting the marker out of the text the way GFM does for `[x]`, needs a `listItem` handler that would shadow the unexported `listItemWithTaskListItem` |
| unreferenced `[label]: url` | Deleted outright, and that is real loss — but a *referenced* definition is lossless (it becomes an inline link with the same target), and a mistyped label keeps its link text while orphaning a reference that was never a link in Obsidian either. That leaves only definitions parked for later. Supporting reference syntax properly would be worse: an unresolved `[text][ref]` reaches Zotero as plain text instead of a working `<a href>` |

**Lost to the pipeline.**

| Gap | Detail |
| --- | --- |
| `[[x*y*z]]` | `md2html` parses `*y*` as emphasis, so the wikilink returns as three siblings — text, `emphasis`, text — and a scan working inside one text node at a time can never reassemble it. Only a real micromark construct for `[[…]]`, out-ranking emphasis at tokenization, addresses this class. Underscores are safe by contrast (`[[a_b_c]]`), because CommonMark does not allow intraword `_` emphasis |
| `$a\|b$` in a table cell | A bare `\|` inside inline math inside a cell tears the row apart and drops the following cell. Reachable only from Zotero — markdown cannot express it, since the pipe would end the cell. Three candidate fixes each trade it for a different corruption; see §8 and `features/math.ts` |

**Behaviour changes** already shipped, listed so a one-time sync diff is not
mistaken for a bug:

- the task marker moved from `<li>[x] <span>text</span>` to
  `<li><span>[x] text</span>`, matching what Zotero's own editor emits;
- `![[…]]` is preserved instead of being expanded to `![](…)`. Notes already
  synced with `![](…)` stay that way.

---

## 13. Adding a feature

1. **Decide the strategy first** — map, preserve, or degrade (§1). Preserve is
   available far more often than it looks, because Zotero stores unrecognised
   text verbatim.
2. **Create one file** under `features/`, holding both directions.
3. **Implement only the hooks you need.** If you find yourself wanting
   `postSerializeMd`, stop and check whether the tree can express it — a string
   pass cannot tell prose from the inside of a code fence.
4. **Register it** in `features/index.ts`. If order matters, say why in the
   comment block; if it does not, say that too.
5. **Add matrix cases** in `scripts/_test-obsidian-syntax-entry.ts`, including
   at least one adversarial case. The `wikilink-punctuation` case exists
   because it rejected a plausible-looking design; the `table-break-plain`
   control exists so a failure can be attributed.
6. **Run `npm test`.** `lint:convert` must stay at zero.

### Invariants

Break these and the module stops being trustworthy:

- No whole-string rewrites of markdown before parsing.
- No new `any`. Two exist, both named and documented.
- `DRIFT` is never acceptable, whatever the expectation says.
- A degradation must record why.
- Do not add a parser extension for something the destination cannot
  represent (§6).
- `strictLineBreaks` is one vault setting — never test or call the two
  directions with different values.

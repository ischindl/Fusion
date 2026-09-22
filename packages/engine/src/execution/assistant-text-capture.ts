import { createStreamingDeltaNormalizer, normalizeStreamingDelta } from "./streaming-delta.js";

type Kind = "text" | "thinking";
type CaptureSinks = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onTextBlockBoundary?: () => void;
};

type EventRecord = Record<string, unknown>;
type PartialShape = { content?: Array<{ type?: string; text?: string; thinking?: string }> } | undefined;

function record(value: unknown): EventRecord | undefined {
  return value !== null && typeof value === "object" ? value as EventRecord : undefined;
}

/*
 * FNXC:AssistantTextCapture 2026-09-13-21:15:
 * RUFU-234 states the contentIndex contract explicitly because both branches used to be silent.
 * An ABSENT contentIndex is un-contradictory and defaults to block 0: real pi streams mix absent and
 * explicit `0` for the same first block, so separating them would re-emit that block. A CONTRADICTORY
 * index (NaN, negative, non-integer) names no resolvable block, so its delta is refused rather than
 * guessed onto a block it may not belong to; pi never emits one. Refusal is asserted by the
 * malformed-blocks case in assistant-text-capture.test.ts. The folding is load-bearing rather than incidental:
 * an absent `text_start` followed by a `text_delta` carrying `contentIndex: 0` on an already-populated first
 * block must emit that block exactly once, which only holds while both events resolve to the same ledger
 * entry. That mixed-index replay is pinned in assistant-text-capture-fidelity.test.ts, so a later losslessness
 * sweep cannot separate the two keys and silently double the first block's text on all four consumer lanes.
 */
function indexOf(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function blockText(partial: unknown, index: number | undefined, kind: Kind): string {
  const content = record(partial)?.content;
  if (!Array.isArray(content) || index === undefined) return "";
  const block = record(content[index]);
  if (block?.type !== kind) return "";
  const value = block[kind === "text" ? "text" : "thinking"];
  return typeof value === "string" ? value : "";
}

/*
 * FNXC:AssistantTextCapture 2026-09-13-22:55:
 * RUFU-234 remediation: whether (partial, index, kind) resolves to a REAL content block decides whether any
 * authoritative text exists for it. An empty-string block text and an unresolvable block are different facts —
 * the first is authority that says "the block holds nothing yet", the second says "nothing here can be
 * cross-checked". The dedup lane is only safe under the first, so the two must not share one return value.
 */
function blockPresent(partial: unknown, index: number | undefined, kind: Kind): boolean {
  const content = record(partial)?.content;
  if (!Array.isArray(content) || index === undefined) return false;
  return record(content[index])?.type === kind;
}

/**
 * Captures every pi assistant block shape while retaining exact-once offsets.
 *
 * FNXC:AssistantTextCapture 2026-09-13-21:15:
 * RUFU-234 byte-fidelity invariant: for one assistant block, the strings handed to the text sink,
 * concatenated, must equal that block's final authoritative text, with whitespace insertion by
 * normalizeStreamingDelta the ONLY permitted difference — nothing dropped, nothing duplicated. Both
 * properties come from one mechanism (never hand out a span the ledger already covers), rather than one
 * bought at the cost of the other.
 *
 * The ledger stores the RAW span already handed to the sink per (kind, block index), so "already
 * delivered?" is answered by containment in delivered content. The replaced guard asked
 * `full.endsWith(update.delta)`, which answers "does the block end with these characters?" — the NORMAL
 * state of the delta that ends the block, not evidence of a redelivery. Because the delta lane pinned that
 * ledger to `full.length` after emitting only a single delta, every later delta coinciding with the block
 * tip was silently returned. Short 1-4 character and lone-space deltas coincide most often, which is why
 * the operator saw scattered loss ("healthy in-review" rendered "healthyin-review", "notes" rendered
 * "otes", a whole trailing run lost between "degrad" and "oval") while the mirror-image timing duplicated
 * text instead ("Hello world world"). Delivering from the authoritative block text makes both shapes
 * structurally impossible at once:
 *
 *  1. No authoritative block resolves for (index, kind) — the partialFree face (a mock runtime that passes the
 *     delta as `partial`, a CLI bridge that omits `partial`) → deliver the raw delta verbatim. With no shared
 *     mutable block nothing can redeliver a chunk, so the dedup would only delete legitimate repeats
 *     ("\n"+"\n", " "+" "), and these lanes emit no terminal event to recover a held span.
 *  2. The delta repeats the unvalidated tail verbatim → the producer is re-delivering its own chunk.
 *  3. Authoritative text extended what was delivered → deliver `authoritative.slice(delivered.length)`.
 *     It cannot skip a character the block holds and cannot re-hand a covered span, so the
 *     producer-mutation race that RUFU-230 patched by coincidence test is now handled by construction.
 *  4. Authoritative text contradicts what the block itself confirmed → the block instance was replaced (the
 *     same `partial` reused across messages with no `message_start`), so the stale span must not slice or
 *     suppress the replacement: restart the ledger and deliver it whole, REGARDLESS OF LENGTH. A length-gated
 *     reset covers only the longer half of that shape; the shorter half matched no branch at all and the
 *     replacement reached no sink — total loss, worse than the head-slice the branch was written to fix.
 *  5. No new authoritative text but a delta carries text the block has not absorbed (FN-9277's populated
 *     start plus a continuation delta) → deliver it as a provisional continuation, deduplicated by
 *     containment in what was already delivered. Deferring it would drop text whose block never catches up.
 *
 * Holding a span at step 5 is safe because pi producers append to the block monotonically and always
 * terminate with `text_end`/`message_end`; that terminal text is authoritative for the block and is the net
 * that catches anything a lagging block had not yet absorbed. Steps 2 and 5 are therefore unreachable — and
 * unsound — wherever no block and no terminal event exist, which is why step 1 short-circuits before them.
 */
export function createAssistantStreamCapture(sinks: CaptureSinks): { handleAgentEvent(event: unknown): void } {
  const normalizer = createStreamingDeltaNormalizer();
  /** Per (kind, block index): the raw text handed to the sink, and how much of it is still unvalidated. */
  const ledger = new Map<Kind, Map<number, { delivered: string; provisional: string; consumed: number }>>();
  let lastTextIndex: number | undefined;
  let sawText = false;
  let pendingBoundary = false;
  /*
  FNXC:AssistantTextCapture 2026-09-16-15:05 (#3620 merge port of upstream FN-431):
  A cross-message boundary is decided by message lifecycle (reset arms `pendingBoundary`) and by
  block restart (advance's replaced-block branch reports `restarted`), NOT by the identity of the
  `partial` object. Providers that hand a COPY of the shared block per event (copied snapshots)
  changed identity on every delta: the old identity test cleared the ledger each event and the
  already-delivered prefix was handed out again — the duplicated-stream-prefix shape FN-431 fixes.
  Reused-partial-across-messages needs no identity test either: that shape is exactly what
  advance's confirmed-prefix comparison detects, content-based and length-independent.
  */
  const reset = () => {
    ledger.clear();
    normalizer.noteBoundary("text"); normalizer.noteBoundary("thinking");
    if (sawText) pendingBoundary = true;
  };
  const handOff = (kind: Kind, text: string, partial: unknown, index: number, restarted = false) => {
    if (!text) return;
    if (kind === "text") {
      if (sawText && (index !== lastTextIndex || pendingBoundary || restarted)) sinks.onTextBlockBoundary?.();
      pendingBoundary = false;
      sinks.onText?.(text);
      sawText = true; lastTextIndex = index;
    } else sinks.onThinking?.(text);
  };
  /**
   * Deliver whatever neither the ledger nor an earlier call has covered yet.
   * `authoritative` is the block's text as known right now: the shared block for streamed events, the
   * longer of block/`text_end.content` for a terminal block, and the terminal message's own block text.
   * Spans cut from it are final, so the normalizer repairs their sentence boundary against the block it
   * was read from; a provisional delta is repaired against the delivered text that precedes it instead.
   */
  const advance = (kind: Kind, partial: unknown, index: number | undefined, authoritative: string, delta?: string, hasBlock = true) => {
    if (index === undefined) return;
    const state = ledger.get(kind)?.get(index) ?? { delivered: "", provisional: "", consumed: 0 };
    const save = () => {
      let byIndex = ledger.get(kind);
      if (!byIndex) { byIndex = new Map(); ledger.set(kind, byIndex); }
      byIndex.set(index, state);
    };
    const blockScoped = partial as PartialShape;

    /*
    FNXC:AssistantTextCapture 2026-09-16-15:05 (#3620 merge port of upstream FN-431):
    Delta accounting is POSITIONAL, mirroring upstream's raw cursors. `consumed` counts only raw
    delta bytes; the snapshot's growth never advances it. A delta whose bytes sit at
    [consumed, consumed + delta.length) inside the block is the delta stream advancing — counted
    once here, wherever it later lands (a growth span that already carries it, or a redelivery
    suppressed below). A delta OUTSIDE that window names text the block never received after
    everything consumed: a new message reusing the block index with IDENTICAL text (upstream's
    "two consecutive Claude responses" shape) lives there, and a content-only `includes` test
    would silently drop it. No `partial` object identity is consulted anywhere — copied-snapshot
    providers change identity every event and must keep one ledger.
    */
    /*
    FNXC:AssistantTextCapture 2026-09-16-15:05 (#3620 merge port of upstream FN-431):
    Delta accounting is POSITIONAL like upstream's raw cursors: `consumed` is the DELTA STREAM's
    declared position — it advances for every delta that matches the window [consumed,
    consumed + delta.length) inside the block, whether or not the bytes are emitted (growth spans
    already carried them). Suppression then compares the window against what was actually handed
    out (`delivered`), not against text content: content `includes` cannot distinguish
    "redelivered chunk" from "a second identical message reusing the block index" — upstream's
    two-consecutive-Claude-responses shape proved those apart only positionally. A delta OUTSIDE
    the window is new text, full stop. No `partial` object identity is consulted anywhere:
    copied-snapshot providers change identity every event and must keep one ledger.
    */
    let outsideWindow = false;
    if (delta !== undefined && hasBlock) {
      const windowMatches = authoritative.length >= state.consumed + delta.length
        && authoritative.slice(state.consumed, state.consumed + delta.length) === delta;
      if (windowMatches) {
        const windowStart = state.consumed;
        state.consumed += delta.length;
        const overlap = Math.min(delta.length, Math.max(0, state.delivered.length - windowStart));
        if (overlap >= delta.length) { save(); return; }
        if (overlap > 0) {
          const tail = delta.slice(overlap);
          state.delivered += tail; state.provisional += tail;
          save();
          handOff(kind, tail, partial, index);
          return;
        }
      } else {
        outsideWindow = true;
      }
    }

    // 1. No authority exists for this block at all — the partialFree face: a mock runtime that passes the
    // delta ITSELF as `partial`, and the plugin/cross-runtime CLI bridge that omits `partial` entirely. There
    // is no shared mutable block, so nothing can redeliver a chunk and every delta is new text; the dedup
    // below would collapse adjacent identical deltas ("\n"+"\n" into one paragraph break, " "+" " into one
    // space) and these lanes never emit `text_end`/`message_end`, so a held span would be lost forever — the
    // exact loss class this seam exists to eliminate. HEAD's guard began with `full &&`, so an absent block
    // short-circuited it and delivered verbatim; that contract is restored explicitly here.
    if (!hasBlock && !authoritative) {
      if (!delta) return;
      const verbatim = normalizeStreamingDelta(state.delivered, delta);
      state.delivered += delta;
      save();
      normalizer.noteEmitted(kind, verbatim, partial, index);
      handOff(kind, verbatim, partial, index);
      return;
    }

    // 2. A delta repeating the unvalidated tail verbatim is the producer redelivering its own chunk.
    if (delta && state.provisional && delta === state.provisional) { state.provisional = ""; save(); return; }

    // 3. Authoritative text grew past what was delivered: hand out the new span from the block. This is
    // the RUFU-230 producer-mutation race too — the block already holds the chunk the delta repeats, so
    // the delta never reaches the sink and no `endsWith` coincidence test is needed to suppress it.
    if (authoritative.startsWith(state.delivered) && authoritative.length > state.delivered.length) {
      const span = authoritative.slice(state.delivered.length);
      state.delivered = authoritative; state.provisional = "";
      save();
      handOff(kind, normalizer.normalize(blockScoped, index, span, kind), partial, index);
      return;
    }

    // 4. Authoritative text contradicts what the BLOCK itself confirmed: the block instance was replaced (the
    // same `partial` reused across messages with no `message_start`). Its head must not be sliced or
    // suppressed by the previous block's span, so restart the ledger and deliver the replacement whole.
    // The reset is length-independent on purpose: the shorter half of that shape (replacement text shorter
    // than the stale span) satisfied a length gate never, and fell through every branch, so the replacement
    // message reached no sink at all. Text still held provisionally is excluded from the comparison — a block
    // merely lagging behind deltas it already received is not a replaced block, and resetting on that would
    // re-hand the whole text and duplicate it.
    const confirmed = state.delivered.slice(0, state.delivered.length - state.provisional.length);
    if (authoritative && !authoritative.startsWith(confirmed)) {
      state.delivered = authoritative; state.provisional = ""; state.consumed = 0;
      save();
      handOff(kind, normalizer.normalize(blockScoped, index, authoritative, kind), partial, index, true);
      return;
    }

    // 5. No new authoritative text. A delta may still carry text the block has not absorbed (FN-9277's
    // populated start plus a continuation delta), so deliver it as a provisional continuation. While a
    // provisional span is outstanding the block is merely behind it, so only a tail repeat is a
    // redelivery; once delivered text is fully block-confirmed, a delta contained in it was necessarily
    // delivered already. Any span wrongly held here is recovered by the terminal block text.
    if (!delta) return;
    /*
    An outside-window delta names text the block never received after everything consumed — a
    replaced block or a new message reusing the index. `normalizeStreamingDelta` content-dedups
    against the delivered text, which would strip such a delta to nothing when the new message is
    IDENTICAL to the previous one (upstream's two-Claude-responses shape). It takes the same
    presentation-repair path growth spans use; the string dedup is reserved for in-stream deltas.
    */
    const span = outsideWindow
      ? normalizer.normalize(blockScoped, index, delta, kind)
      : normalizeStreamingDelta(state.delivered, delta);
    state.delivered += delta; state.provisional += delta;
    save();
    normalizer.noteEmitted(kind, span, partial, index);
    handOff(kind, span, partial, index);
  };
  return {
    handleAgentEvent(event) {
      try {
        const outer = record(event);
        if (!outer) return;
        if (outer.type === "message_start") { reset(); return; }
        if (outer.type === "message_end") {
          const message = record(outer.message);
          const content = message?.content;
          /*
           * FNXC:AssistantTextCapture 2026-09-08-14:31:
           * pi also emits terminal message events for tool results, whose text is tool output rather than assistant prose.
           * Flush terminal blocks only for assistant messages so chat, logs, and verdict parsing retain assistant-only text.
           */
          if (message?.role === "assistant" && Array.isArray(content)) content.forEach((item, index) => {
            const block = record(item);
            // `hasBlock` keeps its default here: the block was just matched by type, so authority exists by construction.
            if (block?.type === "text") advance("text", message, index, blockText(message, index, "text"));
            if (block?.type === "thinking") advance("thinking", message, index, blockText(message, index, "thinking"));
          });
          reset(); return;
        }
        if (outer.type !== "message_update") return;
        const update = record(outer.assistantMessageEvent);
        if (!update) return;
        const partial = update.partial;
        const index = indexOf(update.contentIndex);
        const type = update.type;
        const kind: Kind | undefined = typeof type === "string" && type.startsWith("text_") ? "text" : typeof type === "string" && type.startsWith("thinking_") ? "thinking" : undefined;
        if (!kind) return;
        const hasBlock = blockPresent(partial, index, kind);
        if (type === `${kind}_delta`) {
          if (typeof update.delta !== "string" || index === undefined) return;
          /*
           * FNXC:AssistantTextCapture 2026-09-22-02:30:
           * Provider queues can retain a mutable partial long after a delta was produced. Advance
           * source cursors only from queued deltas so a later-mutated block cannot replay its prefix.
           *
           * FNXC:AssistantTextCapture 2026-09-22-10:10 (#sync-0922 resolution):
           * The ledger's `consumed` cursor in `advance` IS that source cursor: it advances only by a
           * queued delta's length, never by snapshot growth, and suppression compares that window
           * against `delivered` rather than block content. The FN-9356 queued-consumer shape is
           * therefore suppressed positionally without needing a second cursor map.
           */
          advance(kind, partial, index, blockText(partial, index, kind), update.delta, hasBlock);
        } else if (type === `${kind}_start`) {
          /*
           * FNXC:AssistantTextCapture 2026-09-22-02:30 (upstream FN-9356):
           * A mutable partial is not an event-time snapshot: a queued consumer can handle
           * `text_start` after the block already grew past it.
           *
           * FNXC:AssistantTextCapture 2026-09-22-10:10 (#sync-0922 resolution):
           * The start flush stays, because `advance` hands out only the span its ledger has not
           * covered, so an ahead block text cannot replay a delivered prefix, and it is what restores
           * FN-9277's populated-start shape that carries no delta. Terminal events still recover
           * anything the block had not absorbed.
           */
          advance(kind, partial, index, blockText(partial, index, kind), undefined, hasBlock);
        } else if (type === `${kind}_end`) {
          /*
           * FNXC:AssistantTextCapture 2026-09-13-21:15:
           * RUFU-234: `text_end` can carry more than the shared block holds (FN-9277's terminal remainder), so the
           * terminal block text is whichever of the two is longer — both are authoritative for the block, and the
           * ledger still decides which span of it has not been handed out.
           */
          // A `text_end` that carries its own content is authoritative even with no resolvable block, so it
          // must not take the partialFree verbatim face; `advance` treats non-empty authority as such.
          const content = typeof update.content === "string" ? update.content : "";
          const block = blockText(partial, index, kind);
          advance(kind, partial, index, content.length > block.length ? content : block, undefined, hasBlock || content.length > 0);
        }
      } catch { /* Malformed provider events must not break the subscriber. */ }
    },
  };
}

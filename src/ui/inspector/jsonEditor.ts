/**
 * The Density tab's JSON editor (SP3d spec §3.5, D18): a `wrap="off"` textarea over a mirror `<pre>` with the same font,
 * size, line height and padding. The mirror paints the highlighted node range behind the text (a textarea cannot paint a
 * range while unfocused, and focusing it would take the focus from the tree row) and follows the textarea's scroll; a
 * range is scrolled into view by its line index × the line height. Under the text: Apply (and Ctrl/Cmd+Enter), Reset,
 * the status, the "Revert to the current tree" notice of a dirty buffer whose tree changed elsewhere, and the issue lines
 * (a click selects the issue's node and scrolls the text to it). Escape reverts the buffer; the shortcut layer leaves
 * Escape and Ctrl+Z to text entry, so the drawer stays open and Ctrl+Z is the browser's text undo. The buffer, the
 * dirty rule, the debounce and Apply / Reset / Escape are `editorModel.ts`'s, the line arithmetic too; this file only
 * binds a model (one per tree leaf; the tab binds the selected root's) to the DOM. Text only through `textContent`.
 */
import { el } from '../common/dom';
import {
  anchorOfScroll, createScrollKeeper, EDITOR_LINE_PX, editorKeyAction, highlightParts, issueLines, lineIndexAt,
  type EditorModel, type EditorState, type EditorStatus, type ScrollRequest, type ScrollView,
} from './editorModel';
import type { TextRange } from './jsonText';

export interface JsonEditorDeps {
  /** Runs a session call caused by the input event `e` (the page's latency wrapper). */
  edit(e: Event, fn: () => void): void;
  /** After every update of the bound model's state. */
  onState(state: EditorState): void;
  /** The caret moved (typing, a click, a key) and the buffer's ranges are known (clean or parsing, §3.2). */
  onCaret(state: EditorState): void;
  /** An issue line was clicked: the issue's node path inside the leaf. */
  onIssue(state: EditorState, path: string): void;
}

export interface JsonEditorView {
  readonly element: HTMLElement;
  /** Binds the editor to a leaf's model (the selected root's), showing its buffer, caret and scroll. */
  bind(model: EditorModel): void;
  readonly model: EditorModel | null;
  /** The range the mirror paints (null: none); with `scroll`, the text scrolls to show its first line. */
  highlight(range: TextRange | null, scroll: boolean): void;
  /**
   * The text is about to be hidden (the drawer tab, the JSON sub-tab or a layout change): its scroll offsets are kept,
   * unless a scroll is owed (§3.1).
   */
  saveScroll(): void;
  /**
   * The text may be shown again: the scroll owed is written — a node selected, an issue clicked or a re-print made
   * while it was hidden (written then, a hidden textarea ignores it), else the offsets kept when it was hidden.
   */
  restoreScroll(): void;
  dispose(): void;
}

const STATUS_TEXT: Readonly<Record<EditorStatus, string>> = Object.freeze({
  clean: 'the current tree',
  pending: 'checking…',
  valid: 'valid: Apply to use it',
  invalid: 'not valid',
  syntax: 'not JSON',
  tooLarge: 'too large',
});

export function createJsonEditor(deps: JsonEditorDeps): JsonEditorView {
  let model: EditorModel | null = null;
  let unsubscribe: (() => void) | null = null;
  let revision = -1;
  let range: TextRange | null = null;
  let mirrorKey = '';
  let issuesKey = '';
  /** A caret event happened; reported once the buffer's ranges are known. */
  let caretMoved = false;
  /** The scroll owed to the text while it is not displayed (`editorModel.ts`'s keeper). */
  const keeper = createScrollKeeper();

  const element = el('div', 'je');
  const box = el('div', 'je-box');
  const mirror = el('pre', 'je-mirror');
  mirror.setAttribute('aria-hidden', 'true');
  const before = el('span');
  const mark = el('mark', 'je-mark');
  const after = el('span');
  mirror.append(before, mark, after);
  const text = el('textarea', 'je-text');
  text.wrap = 'off';
  text.spellcheck = false;
  text.autocomplete = 'off';
  text.setAttribute('autocapitalize', 'off');
  text.setAttribute('aria-label', 'Tree as JSON');
  box.append(mirror, text);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { syncGutters(); });
  resizeObserver?.observe(text);

  const bar = el('div', 'je-bar');
  const button = (label: string, tip: string, run: (e: MouseEvent) => void): HTMLButtonElement => {
    const b = el('button', '', label);
    b.type = 'button';
    b.title = tip;
    b.addEventListener('click', run);
    return b;
  };
  const apply = button('Apply', 'Use the typed tree (Ctrl+Enter); an invalid tree is never sent', (e) => {
    if (model !== null) deps.edit(e, () => { model!.apply(); });
  });
  const reset = button('Reset', "Reset the tree to the profile's", (e) => {
    if (model !== null) deps.edit(e, () => { model!.reset(); });
  });
  const status = el('span', 'je-status');
  bar.append(apply, reset, status);
  const stale = el('div', 'je-stale');
  stale.append(el('span', '', 'The tree changed elsewhere. '), button('Revert to the current tree', 'Replace the typed text by the current tree', () => model?.revert()));
  const issues = el('div', 'je-issues');
  element.append(box, bar, stale, issues);

  /**
   * The textarea's scrollbars take room from its client box and the mirror (overflow hidden) has none, so at the scroll
   * extremes the textarea could scroll further than the mirror and the highlight would drift. The mirror's box is
   * shrunk by the same gutters, so both have the same client size and the same scroll range.
   */
  let gutterKey = '';
  const syncGutters = (): void => {
    const right = Math.max(0, text.offsetWidth - text.clientWidth);
    const bottom = Math.max(0, text.offsetHeight - text.clientHeight);
    const key = `${String(right)}|${String(bottom)}`;
    if (key === gutterKey) return;
    gutterKey = key;
    mirror.style.right = `${String(right)}px`;
    mirror.style.bottom = `${String(bottom)}px`;
  };

  const paintMirror = (s: EditorState): void => {
    syncGutters();
    const key = `${String(s.revision)}|${s.text.length}|${range === null ? '' : `${String(range.start)}-${String(range.end)}`}|${s.text}`;
    if (key === mirrorKey) return;
    mirrorKey = key;
    const [a, m, b] = highlightParts(s.text, range);
    before.textContent = a;
    mark.textContent = m;
    // The trailing newline keeps the mirror's last line as tall as the textarea's.
    after.textContent = `${b}\n`;
  };

  const viewOf = (): ScrollView => ({ height: text.clientHeight, top: text.scrollTop, left: text.scrollLeft });
  const write = (to: { top: number; left: number } | null): void => {
    if (to === null) return;
    text.scrollTop = to.top;
    text.scrollLeft = to.left;
    syncGutters();
    mirror.scrollTop = text.scrollTop;
    mirror.scrollLeft = text.scrollLeft;
  };
  /** Scrolls now, or owes it until the text is shown (a hidden textarea ignores scroll writes). */
  const scrollTo = (req: ScrollRequest): void => { write(keeper.request(req, text.value, viewOf())); };
  const scrollToLine = (line: number): void => { scrollTo({ kind: 'line', line }); };

  const renderIssues = (s: EditorState): void => {
    const lines = issueLines(s);
    const key = `${s.status}|${lines.join('\n')}`;
    if (key === issuesKey) return;
    issuesKey = key;
    issues.replaceChildren(...lines.map((line, i) => {
      const issue = s.syntax === null && s.status !== 'tooLarge' ? s.issues[i] : undefined;
      if (issue === undefined && s.syntax === null) return el('div', 'je-issue', line);
      const b = el('button', 'je-issue', line);
      b.type = 'button';
      b.title = issue === undefined ? 'Show the error in the text' : 'Select the node and show it in the text';
      b.addEventListener('click', () => {
        const st = model?.state;
        if (st === undefined) return;
        if (issue !== undefined) { deps.onIssue(st, issue.path); return; }
        if (st.syntax !== null) {
          text.focus();
          text.setSelectionRange(st.syntax.offset, st.syntax.offset);
          scrollToLine(lineIndexAt(st.text, st.syntax.offset));
        }
      });
      return b;
    }));
  };

  const render = (s: EditorState): void => {
    if (s.revision !== revision) {
      revision = s.revision;
      // A re-print (or a newly bound model): the text, then the caret and the scroll the model mapped by node path.
      if (text.value !== s.text) text.value = s.text;
      const focused = document.activeElement === text;
      if (focused) text.setSelectionRange(s.caret, s.caret);
      scrollTo({ kind: 'anchor', anchor: s.scrollAnchor });
    }
    paintMirror(s);
    status.textContent = STATUS_TEXT[s.status];
    status.dataset['status'] = s.status;
    apply.disabled = s.clean;
    stale.hidden = !s.stale;
    text.classList.toggle('je-dirty', !s.clean);
    renderIssues(s);
    deps.onState(s);
    if (caretMoved && s.ranges !== null) {
      caretMoved = false;
      deps.onCaret(s);
    }
  };

  const reportCaret = (): void => {
    if (model === null) return;
    caretMoved = true;
    model.setCaret(text.selectionStart, anchorOfScroll(text.value, text.scrollTop, EDITOR_LINE_PX));
  };

  text.addEventListener('input', () => {
    if (model === null) return;
    caretMoved = true;
    model.edit(text.value, text.selectionStart);
  });
  text.addEventListener('click', reportCaret);
  text.addEventListener('keyup', (e) => {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') reportCaret();
  });
  text.addEventListener('scroll', () => {
    syncGutters();
    mirror.scrollTop = text.scrollTop;
    mirror.scrollLeft = text.scrollLeft;
    model?.setCaret(text.selectionStart, anchorOfScroll(text.value, text.scrollTop, EDITOR_LINE_PX));
  });
  text.addEventListener('keydown', (e) => {
    const action = editorKeyAction(e);
    if (action === null || model === null) return;
    e.preventDefault();
    if (action === 'apply') deps.edit(e, () => { model!.apply(); });
    else model.revert();
  });

  return {
    element,
    get model() { return model; },
    bind(m) {
      if (m === model) return;
      unsubscribe?.();
      model = m;
      revision = -1;
      mirrorKey = '';
      issuesKey = '';
      caretMoved = false;
      unsubscribe = m.subscribe(render);
      render(m.state);
    },
    highlight(r, scroll) {
      range = r;
      if (model !== null) paintMirror(model.state);
      if (scroll && r !== null && model !== null) scrollToLine(lineIndexAt(model.state.text, r.start));
    },
    saveScroll() {
      keeper.hidden(viewOf());
    },
    restoreScroll() {
      write(keeper.shown(text.value, viewOf()));
    },
    dispose() {
      resizeObserver?.disconnect();
      unsubscribe?.();
      unsubscribe = null;
      model = null;
    },
  };
}

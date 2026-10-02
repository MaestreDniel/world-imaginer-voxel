/**
 * The Presets tab (SP2b spec §3.4): export the draft to a `.wi10-preset.json` file under a name checked inline,
 * import such a file (its issues listed with their paths; one undo step; the seed is kept) and, under Advanced,
 * the JSON patch box showing the draft's minimal patch, whose Apply replaces the patch. DOM only: the rules are in
 * presetFile.ts.
 */
import './presets.css';
import type { SessionState, WorldSession } from '../../engine/session';
import { el } from '../common/dom';
import { downloadText, readTextFile } from '../common/files';
import type { Notices } from '../common/notice';
import { applyPatchText, exportDraft, loadedNotice, loadPresetText, patchBoxText, presetNameHint, type PatchApply } from './presetFile';

export interface PresetsDeps {
  readonly session: WorldSession;
  readonly notices: Notices;
  /** Runs a control's session call for its input event (the page times the preview from the event, §2.8). */
  edit(e: Event, fn: () => void): void;
}

export interface PresetsTab {
  readonly element: HTMLElement;
  dispose(): void;
}

/** How long "loaded preset NAME" (with its Undo) stays, as "profile switched" does. */
const LOADED_NOTICE_MS = 5000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createPresetsTab(host: HTMLElement, deps: PresetsDeps): PresetsTab {
  const { session, notices } = deps;
  const root = el('div', 'pt');
  const button = (id: string, text: string, tip: string): HTMLButtonElement => {
    const b = el('button', '', text);
    b.type = 'button';
    b.id = id;
    b.title = tip;
    return b;
  };
  const setMessage = (box: HTMLElement, text: string, kind: 'info' | 'error') => {
    box.textContent = text;
    box.dataset['kind'] = kind;
  };
  const setIssues = (list: HTMLElement, lines: readonly string[]) => {
    list.replaceChildren(...lines.map((line) => el('li', '', line)));
  };

  // ---------------------------------------------------------------- export
  const nameLabel = el('label', 'pt-label', 'Name');
  nameLabel.htmlFor = 'pt-name';
  const nameInput = el('input', 'pt-field pt-name');
  nameInput.type = 'text';
  nameInput.id = 'pt-name';
  nameInput.placeholder = 'preset name';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  const exportBtn = button('pt-export', 'Export', 'Download the draft as a .wi10-preset.json file (Enter in the name field)');
  const exportRow = el('div', 'pt-row');
  exportRow.append(nameLabel, nameInput, exportBtn);
  const nameHint = el('div', 'pt-hint');
  nameHint.id = 'pt-name-hint';
  nameHint.setAttribute('aria-live', 'polite');
  nameInput.setAttribute('aria-describedby', nameHint.id);
  const exportMsg = el('div', 'pt-msg');
  exportMsg.id = 'pt-export-msg';
  root.append(
    el('h3', '', 'Export'),
    el('p', 'pt-doc', 'Saves the profile and the modified parameters of the draft (not the seed) as a file.'),
    exportRow, nameHint, exportMsg,
  );

  const renderName = () => {
    const h = presetNameHint(nameInput.value);
    nameHint.textContent = h.text;
    nameHint.dataset['kind'] = h.kind;
    nameInput.classList.toggle('pt-invalid', h.kind === 'problem');
    nameInput.setAttribute('aria-invalid', String(h.kind === 'problem'));
    exportBtn.disabled = h.kind !== 'ok';
  };
  const runExport = () => {
    const r = exportDraft(nameInput.value, session);
    if (!r.ok) {
      renderName();
      return;
    }
    downloadText(r.fileName, r.text);
    setMessage(exportMsg, `exported ${r.fileName}`, 'info');
  };
  nameInput.addEventListener('input', () => {
    renderName();
    exportMsg.textContent = '';
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    runExport();
  });
  exportBtn.addEventListener('click', runExport);
  renderName();

  // ---------------------------------------------------------------- import
  const fileInput = el('input', 'pt-file');
  fileInput.type = 'file';
  fileInput.id = 'pt-file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  const importBtn = button('pt-import', 'Import preset…', 'Load a .wi10-preset.json file: its profile and parameters replace the draft (one undo step); the seed is kept');
  importBtn.addEventListener('click', () => fileInput.click());
  const importRow = el('div', 'pt-row');
  importRow.append(importBtn, fileInput);
  const importMsg = el('div', 'pt-msg');
  importMsg.id = 'pt-import-msg';
  const importIssues = el('ul', 'pt-issues');
  importIssues.id = 'pt-import-issues';
  root.append(
    el('h3', '', 'Import'),
    el('p', 'pt-doc', 'Loads a preset file: its profile and parameters replace the draft as one undo step; the seed is kept.'),
    importRow, importMsg, importIssues,
  );

  // The input is cleared once the read is over, so that choosing the same file again fires `change`.
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    setMessage(importMsg, `reading ${file.name} …`, 'info');
    setIssues(importIssues, []);
    void readTextFile(file).then((text) => {
      const r = loadPresetText(session, text);
      if (!r.ok) {
        setMessage(importMsg, `${file.name} was not imported:`, 'error');
        setIssues(importIssues, r.issues);
        return;
      }
      nameInput.value = r.name;
      renderName();
      exportMsg.textContent = '';
      setMessage(importMsg, r.changed ? `imported ${file.name}` : `imported ${file.name}: the draft already matched it`, 'info');
      const loaded = session.state;
      notices.show(loadedNotice(r.name), {
        timeoutMs: LOADED_NOTICE_MS,
        actions: r.changed ? [{ label: 'Undo', run: () => { if (session.state === loaded) session.undo(); } }] : [],
      });
    }, (err: unknown) => {
      setMessage(importMsg, `${file.name} could not be read: ${messageOf(err)}`, 'error');
    }).finally(() => { fileInput.value = ''; });
  });

  // ---------------------------------------------------------------- advanced: the JSON patch box
  const patchDoc = el('p', 'pt-doc');
  const patchBox = el('textarea', 'pt-field pt-patch');
  patchBox.id = 'pt-patch';
  patchBox.rows = 6;
  patchBox.spellcheck = false;
  patchBox.autocomplete = 'off';
  patchBox.setAttribute('aria-label', 'Patch JSON');
  const applyBtn = button('pt-apply', 'Apply patch', 'Replace the draft\'s patch with this JSON (one undo step; Ctrl+Enter)');
  const revertBtn = button('pt-revert', 'Revert', 'Show the draft\'s patch again (Escape)');
  const patchRow = el('div', 'pt-row');
  patchRow.append(applyBtn, revertBtn);
  const patchIssues = el('ul', 'pt-issues');
  patchIssues.id = 'pt-patch-issues';
  root.append(el('h3', '', 'Advanced: JSON patch'), patchDoc, patchBox, patchRow, patchIssues);

  /** The draft's patch text last put in the box: typed text stays until the draft's patch changes. */
  let shown: string | null = null;
  const renderPatchButtons = () => {
    const edited = patchBox.value !== shown;
    applyBtn.disabled = !edited;
    revertBtn.disabled = !edited && !patchBox.classList.contains('pt-invalid');
  };
  const showDraftPatch = (text: string) => {
    shown = text;
    patchBox.value = text;
    patchBox.classList.remove('pt-invalid');
    patchBox.removeAttribute('aria-invalid');
    setIssues(patchIssues, []);
    renderPatchButtons();
  };
  const applyPatch = (e: Event) => {
    let r!: PatchApply;
    deps.edit(e, () => { r = applyPatchText(session, patchBox.value); });
    if (r.ok) {
      showDraftPatch(patchBoxText(session.state.patch));
      return;
    }
    patchBox.classList.add('pt-invalid');
    patchBox.setAttribute('aria-invalid', 'true');
    setIssues(patchIssues, r.issues);
    renderPatchButtons();
  };
  const revertPatch = () => showDraftPatch(patchBoxText(session.state.patch));
  applyBtn.addEventListener('click', applyPatch);
  revertBtn.addEventListener('click', revertPatch);
  patchBox.addEventListener('input', renderPatchButtons);
  patchBox.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      applyPatch(e);
    } else if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      revertPatch();
    }
  });

  const sync = (s: SessionState) => {
    patchDoc.textContent = `The draft's minimal patch over the profile ${s.profile}, as canonical JSON. Apply replaces the whole patch as one undo step and keeps the seed; Escape or Revert shows the draft's patch again.`;
    const text = patchBoxText(s.patch);
    if (text !== shown) showDraftPatch(text);
  };
  sync(session.state);
  const unsubscribe = session.subscribe((s) => sync(s));

  host.append(root);
  return {
    element: root,
    dispose() {
      unsubscribe();
      root.remove();
    },
  };
}

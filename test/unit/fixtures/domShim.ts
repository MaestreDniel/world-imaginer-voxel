/**
 * A minimal DOM for unit tests of `src/ui` (SP4a ruling P43): vitest runs in Node and the project has no DOM library,
 * so this shim models only the members `src/ui` uses. Code under `src/ui` uses nothing beyond them; a later task that
 * needs more adds it here, never through a DOM library. Tests pass elements as `as unknown as HTMLElement`, fire
 * events with `dispatchEvent(new Event(…))`, and call `vi.unstubAllGlobals()` in `afterEach`.
 */
import { vi } from 'vitest';

type Child = FakeElement | FakeText;

/** A text node: what `append('text')` and `createTextNode` make. */
export class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(v: string) {
    this.data = String(v);
  }

  remove(): void {
    this.parentElement?.detach(this);
  }
}

/** An element: tree, text, the common properties, attributes, `click()` and a '#id' / tag-name `querySelector`. */
export class FakeElement extends EventTarget {
  readonly nodeType = 1;
  readonly tagName: string;
  id = '';
  className = '';
  hidden = false;
  disabled = false;
  href = '';
  title = '';
  type = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  /** The DOM's `onclick` property: called after the 'click' listeners when the element is clicked. */
  onclick: ((e: Event) => unknown) | null = null;
  parentElement: FakeElement | null = null;
  readonly childNodes: Child[] = [];
  private readonly attrs = new Map<string, string>();
  private ownValue: string | null = null;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  /** The element children (text nodes excluded), as the DOM's `children`. */
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  /** The text of every descendant text node in order; setting it replaces the children with one text node. */
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(v: string) {
    this.clear();
    const text = String(v);
    if (text !== '') this.adopt(new FakeText(text));
  }

  /**
   * A select's value is its chosen option's (the first option until one is chosen; '' when none matches); an option's
   * defaults to its text; any other element's is a plain string.
   */
  get value(): string {
    if (this.tagName === 'SELECT') {
      const opts = this.options;
      if (this.ownValue !== null && opts.some((o) => o.value === this.ownValue)) return this.ownValue;
      return this.ownValue === null && opts.length > 0 ? opts[0]!.value : '';
    }
    if (this.tagName === 'OPTION' && this.ownValue === null) return this.textContent;
    return this.ownValue ?? '';
  }

  set value(v: string) {
    this.ownValue = String(v);
  }

  /** A select's options, in tree order. */
  get options(): FakeElement[] {
    return this.querySelectorAll('option');
  }

  append(...nodes: (Child | string)[]): void {
    for (const n of nodes) this.adopt(typeof n === 'string' ? new FakeText(n) : n);
  }

  appendChild<T extends Child>(node: T): T {
    this.adopt(node);
    return node;
  }

  replaceChildren(...nodes: (Child | string)[]): void {
    this.clear();
    this.append(...nodes);
  }

  remove(): void {
    this.parentElement?.detach(this);
  }

  setAttribute(name: string, value: string): void {
    if (name === 'id') this.id = String(value);
    else if (name === 'class') this.className = String(value);
    else this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id === '' ? null : this.id;
    if (name === 'class') return this.className === '' ? null : this.className;
    return this.attrs.get(name) ?? null;
  }

  /** Dispatches 'click' (then calls `onclick`) unless the element is disabled. */
  click(): void {
    if (this.disabled) return;
    const e = new Event('click', { cancelable: true });
    this.dispatchEvent(e);
    this.onclick?.(e);
  }

  /** The first descendant matching '#id' or a tag name, depth-first. */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Every descendant matching '#id' or a tag name, depth-first. */
  querySelectorAll(selector: string): FakeElement[] {
    const match = selectorMatcher(selector);
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** Removes `child` from this element (used by `remove()`). */
  detach(child: Child): void {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentElement = null;
  }

  private adopt(node: Child): void {
    node.parentElement?.detach(node);
    node.parentElement = this;
    this.childNodes.push(node);
  }

  private clear(): void {
    for (const c of this.childNodes) c.parentElement = null;
    this.childNodes.length = 0;
  }
}

function selectorMatcher(selector: string): (e: FakeElement) => boolean {
  const s = selector.trim();
  if (s.startsWith('#')) {
    const id = s.slice(1);
    return (e) => e.id === id;
  }
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) {
    const tag = s.toUpperCase();
    return (e) => e.tagName === tag;
  }
  throw new Error(`domShim: unsupported selector '${selector}' (only '#id' and tag names)`);
}

/** The document: element factories, lookups over `body`, settable `hidden` and `visibilityState`, and events. */
export class FakeDocument extends EventTarget {
  readonly body = new FakeElement('body');
  hidden = false;
  visibilityState: 'visible' | 'hidden' = 'visible';

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

/**
 * Installs a fresh document as the global `document` (`vi.stubGlobal`). `el(id)` returns the element with that id under
 * `body` and throws when there is none.
 */
export function installDom(): { document: FakeDocument; body: FakeElement; el(id: string): FakeElement } {
  const document = new FakeDocument();
  vi.stubGlobal('document', document);
  return {
    document,
    body: document.body,
    el(id: string): FakeElement {
      const e = document.getElementById(id);
      if (e === null) throw new Error(`domShim: no element #${id}`);
      return e;
    },
  };
}

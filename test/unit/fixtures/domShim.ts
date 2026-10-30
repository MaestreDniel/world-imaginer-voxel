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
  /** An image's source (its `decode()` asks the owner document's `decodeImage`). */
  src = '';
  title = '';
  type = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  /** The DOM's `onclick` property: called after the 'click' listeners when the element is clicked. */
  onclick: ((e: Event) => unknown) | null = null;
  parentElement: FakeElement | null = null;
  /** The document that created the element (null for one built with `new`). */
  ownerDocument: FakeDocument | null = null;
  /** What `getBoundingClientRect()` reports (SP5b: a spline plot's size and a press's position); a test sets it. */
  rect = { left: 0, top: 0, width: 0, height: 0 };
  readonly childNodes: Child[] = [];
  private readonly attrs = new Map<string, string>();
  private ownValue: string | null = null;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  /** The DOM's `classList`: add, remove, toggle and contains over the space-separated `className`. */
  readonly classList = {
    add: (...tokens: string[]): void => { this.setClasses([...new Set([...this.classes(), ...tokens])]); },
    remove: (...tokens: string[]): void => { this.setClasses(this.classes().filter((c) => !tokens.includes(c))); },
    toggle: (token: string, force?: boolean): boolean => {
      const on = force ?? !this.classes().includes(token);
      if (on) this.classList.add(token);
      else this.classList.remove(token);
      return on;
    },
    contains: (token: string): boolean => this.classes().includes(token),
  };

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

  /** Inserts the nodes before the first child, in order, as the DOM's `prepend`. */
  prepend(...nodes: (Child | string)[]): void {
    const first = this.childNodes[0] ?? null;
    for (const n of nodes) this.insertBefore(typeof n === 'string' ? new FakeText(n) : n, first);
  }

  /** The last child node, or null. */
  get lastChild(): Child | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  /** Inserts `node` before `ref` (appends it when `ref` is null), as the DOM's `insertBefore`. */
  insertBefore<T extends Child>(node: T, ref: Child | null): T {
    if (ref === null) return this.appendChild(node);
    node.parentElement?.detach(node);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('domShim: insertBefore\'s reference is not a child');
    node.parentElement = this;
    this.childNodes.splice(i, 0, node);
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

  removeAttribute(name: string): void {
    if (name === 'id') this.id = '';
    else if (name === 'class') this.className = '';
    else if (name === 'href') this.href = '';
    this.attrs.delete(name);
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id === '' ? null : this.id;
    if (name === 'class') return this.className === '' ? null : this.className;
    return this.attrs.get(name) ?? null;
  }

  /** Makes the element the owner document's `activeElement` (SP4c: a focused seed field). */
  focus(): void {
    if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
  }

  /** Whether `other` is this element or one of its descendants, as the DOM's `contains`. */
  contains(other: FakeElement | null): boolean {
    for (let e = other; e !== null && e !== undefined; e = e.parentElement) if (e === this) return true;
    return false;
  }

  /** The element's `rect`, with `right`, `bottom`, `x` and `y` as the DOM's `DOMRect` has them. */
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } {
    const r = this.rect;
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }

  /** The pointer ids captured by `setPointerCapture` (a bar's or a plot's drag, SP5b). */
  readonly captured = new Set<number>();

  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
  }

  /** Gives the focus back to the owner document's body when the element has it. */
  blur(): void {
    if (this.ownerDocument !== null && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  /**
   * Takes the pointer lock at once: the owner document's `pointerLockElement` becomes the element and 'pointerlockchange'
   * is dispatched on the document (a browser does both asynchronously, after the click).
   */
  requestPointerLock(): Promise<void> {
    if (this.ownerDocument !== null) this.ownerDocument.setPointerLock(this);
    return Promise.resolve();
  }

  /** Dispatches 'click' (then calls `onclick`) unless the element is disabled. */
  click(): void {
    if (this.disabled) return;
    const e = new Event('click', { cancelable: true });
    this.dispatchEvent(e);
    this.onclick?.(e);
  }

  /** An image's `decode()`: the owner document's `decodeImage(src)` (resolves when there is no owner). */
  decode(): Promise<void> {
    return this.ownerDocument === null ? Promise.resolve() : this.ownerDocument.decodeImage(this.src);
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

  private classes(): string[] {
    return this.className.split(/\s+/).filter((c) => c !== '');
  }

  private setClasses(list: string[]): void {
    this.className = list.join(' ');
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

/**
 * The document: element factories, lookups over `body`, settable `hidden` and `visibilityState`, events, and
 * `decodeImage`, which every image's `decode()` calls (a test replaces it to make a decode fail or wait).
 */
export class FakeDocument extends EventTarget {
  readonly body = new FakeElement('body');
  /** The focused element: the body until an element's `focus()` (SP4c spec §2.2). */
  activeElement: FakeElement = this.body;
  /** The element holding the pointer lock, or null (SP4c spec §2.3). */
  pointerLockElement: FakeElement | null = null;
  /** How many times `exitPointerLock` was called. */
  exitPointerLockCalls = 0;
  hidden = false;
  visibilityState: 'visible' | 'hidden' = 'visible';
  decodeImage: (src: string) => Promise<void> = () => Promise.resolve();

  /** Releases the pointer lock at once: `pointerLockElement` null and 'pointerlockchange' dispatched when it was held. */
  exitPointerLock(): void {
    this.exitPointerLockCalls++;
    this.setPointerLock(null);
  }

  /** Sets `pointerLockElement` and dispatches 'pointerlockchange' when it changed (the browser's lock taken or lost). */
  setPointerLock(e: FakeElement | null): void {
    if (this.pointerLockElement === e) return;
    this.pointerLockElement = e;
    this.dispatchEvent(new Event('pointerlockchange'));
  }

  createElement(tag: string): FakeElement {
    const e = new FakeElement(tag);
    e.ownerDocument = this;
    return e;
  }

  /** An element in a namespace (the spline plot's SVG): a plain element of that tag here. */
  createElementNS(_ns: string, tag: string): FakeElement {
    return this.createElement(tag);
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

/** The DOM's `new Option(text, value)` (the toolbar's selects): an 'option' element of `document`, its value `value` when given. */
function optionClass(document: FakeDocument): new (text?: string, value?: string) => FakeElement {
  return class FakeOption extends FakeElement {
    constructor(text = '', value?: string) {
      super('option');
      this.ownerDocument = document;
      this.textContent = text;
      if (value !== undefined) this.value = value;
    }
  };
}

/**
 * Installs a fresh document as the global `document` and its `Option` constructor (`vi.stubGlobal`). `el(id)` returns
 * the element with that id under `body` and throws when there is none.
 */
export function installDom(): { document: FakeDocument; body: FakeElement; el(id: string): FakeElement } {
  const document = new FakeDocument();
  vi.stubGlobal('document', document);
  vi.stubGlobal('Option', optionClass(document));
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

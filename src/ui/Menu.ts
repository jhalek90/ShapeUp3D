export type MenuItem =
  | { label: string; shortcut?: string; run: () => void; checked?: () => boolean }
  | { separator: true };

/** A toolbar button that opens a dropdown list of commands. */
export class Menu {
  readonly button: HTMLButtonElement;
  private readonly popup: HTMLDivElement;
  private readonly checks: { mark: HTMLElement; checked: () => boolean }[] = [];

  constructor(label: string, items: MenuItem[], align: 'left' | 'right' = 'right') {
    this.button = document.createElement('button');
    this.button.className = 'tool-btn menu-btn';
    this.button.textContent = `${label} ▾`;
    this.button.setAttribute('aria-haspopup', 'menu');

    this.popup = document.createElement('div');
    this.popup.className = `menu-popup align-${align}`;
    this.popup.setAttribute('role', 'menu');
    this.popup.hidden = true;
    for (const item of items) this.popup.append(this.buildItem(item));

    this.button.addEventListener('click', () => (this.popup.hidden ? this.open() : this.close()));
  }

  /** Wraps the button and popup in a positioned container for the toolbar. */
  get element(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'menu-wrap';
    wrap.append(this.button, this.popup);
    return wrap;
  }

  private buildItem(item: MenuItem): HTMLElement {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      return sep;
    }
    const row = document.createElement('button');
    row.className = 'menu-item';
    row.setAttribute('role', 'menuitem');
    const mark = document.createElement('span');
    mark.className = 'menu-check';
    const text = document.createElement('span');
    text.textContent = item.label;
    const key = document.createElement('span');
    key.className = 'menu-key';
    key.textContent = item.shortcut ?? '';
    row.append(mark, text, key);
    if (item.checked) this.checks.push({ mark, checked: item.checked });
    row.addEventListener('click', () => {
      this.close();
      item.run();
    });
    return row;
  }

  private open(): void {
    for (const { mark, checked } of this.checks) mark.textContent = checked() ? '✓' : '';
    this.popup.hidden = false;
    this.button.classList.add('active');
    // Defer so the opening click doesn't immediately close it.
    setTimeout(() => {
      window.addEventListener('mousedown', this.onOutside);
      window.addEventListener('keydown', this.onKey, true);
    });
  }

  private close(): void {
    this.popup.hidden = true;
    this.button.classList.remove('active');
    this.button.blur();
    window.removeEventListener('mousedown', this.onOutside);
    window.removeEventListener('keydown', this.onKey, true);
  }

  private onOutside = (e: MouseEvent): void => {
    if (!(e.target instanceof Node) || (!this.popup.contains(e.target) && !this.button.contains(e.target))) this.close();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    }
  };
}

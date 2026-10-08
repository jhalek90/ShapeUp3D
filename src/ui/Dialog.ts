export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

/**
 * A simple modal dialog. Resolves with the clicked button's value, or null if the
 * dialog is dismissed (Esc or clicking outside). `body` can be updated while open.
 */
export function showDialog<T>(title: string, body: HTMLElement, buttons: DialogButton<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    const box = document.createElement('div');
    box.className = 'dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.textContent = title;
    const footer = document.createElement('div');
    footer.className = 'dialog-buttons';
    box.append(h, body, footer);
    backdrop.append(box);

    const close = (value: T | null) => {
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(primary.value);
        }
      }
      // Keep keystrokes in the dialog from reaching the modeling shortcuts.
      e.stopPropagation();
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.className = b.primary ? 'dialog-btn primary' : 'dialog-btn';
      btn.addEventListener('click', () => close(b.value));
      footer.append(btn);
    }
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });
    window.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    (footer.querySelector('.primary') as HTMLElement | null)?.focus();
  });
}

/** A labelled <select> row for dialogs. */
export function selectRow<T extends string>(label: string, options: { value: T; label: string }[], value: T): { row: HTMLElement; select: HTMLSelectElement } {
  const row = document.createElement('label');
  row.className = 'dialog-row';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  for (const o of options) select.add(new Option(o.label, o.value));
  select.value = value;
  row.append(span, select);
  return { row, select };
}

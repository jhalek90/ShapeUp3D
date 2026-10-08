import type { ToolManager } from '../tools/ToolManager';
import type { Menu } from './Menu';

export type ToolbarItem =
  | { type: 'tool'; id: string }
  | { type: 'command'; label: string; title: string; run: () => void; active?: () => boolean }
  /** A tool that isn't implemented yet; shown disabled. */
  | { type: 'soon'; label: string; shortcut?: string }
  | { type: 'menu'; menu: Menu }
  | { type: 'separator' }
  | { type: 'spacer' };

export class Toolbar {
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly toggles: { button: HTMLButtonElement; active: () => boolean }[] = [];

  constructor(
    root: HTMLElement,
    items: ToolbarItem[],
    private readonly tools: ToolManager,
  ) {
    for (const item of items) root.append(this.build(item));
    tools.onChange(() => this.refresh());
    this.refresh();
  }

  /** Updates highlighted state (active tool, toggled commands). */
  refresh(): void {
    const activeId = this.tools.active?.id;
    for (const [id, button] of this.toolButtons) button.classList.toggle('active', id === activeId);
    for (const { button, active } of this.toggles) button.classList.toggle('active', active());
  }

  private build(item: ToolbarItem): HTMLElement {
    switch (item.type) {
      case 'separator':
        return el('span', 'tool-sep');
      case 'spacer':
        return el('span', 'tool-spacer');
      case 'menu':
        return item.menu.element;
      case 'soon': {
        const button = el('button', 'tool-btn');
        button.textContent = item.label;
        button.title = `${item.label}${item.shortcut ? ` (${item.shortcut})` : ''} — coming soon`;
        button.disabled = true;
        return button;
      }
      case 'tool': {
        const tool = this.tools.get(item.id);
        if (!tool) throw new Error(`Toolbar references unknown tool: ${item.id}`);
        const button = el('button', 'tool-btn');
        button.textContent = tool.name;
        button.title = tool.shortcut ? `${tool.name} (${tool.shortcut})` : tool.name;
        button.addEventListener('click', () => {
          button.blur(); // keep keyboard shortcuts going to the app
          this.tools.activate(tool.id);
        });
        this.toolButtons.set(tool.id, button);
        return button;
      }
      case 'command': {
        const button = el('button', 'tool-btn');
        button.textContent = item.label;
        button.title = item.title;
        button.addEventListener('click', () => {
          button.blur();
          item.run();
          this.refresh();
        });
        if (item.active) this.toggles.push({ button, active: item.active });
        return button;
      }
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

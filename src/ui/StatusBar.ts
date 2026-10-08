import { LENGTH_UNITS, type LengthUnit } from '../units/length';

const UNIT_LABELS: Record<LengthUnit, string> = {
  mm: 'Millimetres',
  cm: 'Centimetres',
  m: 'Metres',
  in: 'Inches',
  ft: 'Feet & inches',
};

/** Status hint, units picker and the Measurements box (SketchUp's "VCB"). */
export class StatusBar {
  onSubmit: (text: string) => void = () => {};
  onEscape: () => void = () => {};
  onUnitsChange: (unit: LengthUnit) => void = () => {};

  private readonly hint = byId('status-hint');
  private readonly vcbName = byId('vcb-name');
  private readonly vcb = byId<HTMLInputElement>('vcb');
  private readonly units = byId<HTMLSelectElement>('units-select');
  /** Value last set by the tool, restored if typing is abandoned. */
  private toolValue = '';

  constructor(unit: LengthUnit) {
    for (const u of LENGTH_UNITS) this.units.add(new Option(UNIT_LABELS[u], u));
    this.units.value = unit;
    this.units.addEventListener('change', () => {
      this.onUnitsChange(this.units.value as LengthUnit);
      this.units.blur();
    });

    this.vcb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.vcb.value.trim();
        this.vcb.blur();
        if (text) this.onSubmit(text);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.vcb.value = this.toolValue;
        this.vcb.blur();
        this.onEscape();
      }
    });
  }

  /** Shows a unit in the picker (e.g. after opening a file). */
  setUnit(unit: LengthUnit): void {
    this.units.value = unit;
  }

  setHint(text: string): void {
    this.hint.textContent = text;
  }

  setMeasurement(label: string, value = ''): void {
    this.vcbName.textContent = label || 'Measurements';
    this.toolValue = value;
    if (!this.isTyping) this.vcb.value = value;
  }

  get isTyping(): boolean {
    return document.activeElement === this.vcb;
  }

  /** Starts a fresh entry; the key that triggered it lands in the box. */
  startTyping(): void {
    this.vcb.value = '';
    this.vcb.focus();
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

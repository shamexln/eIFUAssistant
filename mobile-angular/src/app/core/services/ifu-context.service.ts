import { Injectable, signal } from '@angular/core';

export interface IfuSelection {
  model?: string;
  ifuPath?: string; // e.g., ifus/Vista_300.pdf
}

@Injectable({ providedIn: 'root' })
export class IfuContextService {
  readonly selection = signal<IfuSelection | null>(null);

  setSelection(sel: IfuSelection | null) {
    this.selection.set(sel);
  }

  clear() {
    this.selection.set(null);
  }
}

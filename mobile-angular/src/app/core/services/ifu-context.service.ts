import { Injectable, signal } from '@angular/core';

export interface IfuSelection {
  model?: string;
  assistantid?: string; // e.g., ifus/Vista_300.pdf
  containerid?: string;
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

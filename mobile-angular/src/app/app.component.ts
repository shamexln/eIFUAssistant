import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { NgIf } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, NgIf, MatToolbarModule, MatButtonModule],
  template: `
    <mat-toolbar color="primary" class="app-toolbar">
      <span class="brand">eIFU Mobile</span>
      <span class="spacer"></span>
      <a class="toolbar-link" [routerLink]="['/scan']" style="margin-right:12px;">扫码</a>
      <a class="toolbar-link" [routerLink]="['/search']">检索</a>
    </mat-toolbar>
    <main class="app-main">
      <router-outlet></router-outlet>
    </main>
  `,
  styles: [`
    :host { display: block; height: 100dvh; }
    .app-toolbar { position: sticky; top: 0; z-index: 10; }
    .brand { font-weight: 600; }
    .spacer { flex: 1 1 auto; }
    .toolbar-link { color: inherit; text-decoration: none; font-size: 14px; }
    .app-main {
      padding: clamp(8px, 2.5vw, 20px);
      padding-left: max(clamp(8px, 2.5vw, 20px), env(safe-area-inset-left));
      padding-right: max(clamp(8px, 2.5vw, 20px), env(safe-area-inset-right));
      padding-bottom: max(clamp(10px, 3vw, 24px), env(safe-area-inset-bottom));
    }
    @media (min-width: 768px) {
      .app-main { display: grid; place-items: start center; }
    }
  `]
})
export class AppComponent { }

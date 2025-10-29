import { Routes } from '@angular/router';
import { ChatComponent } from './features/chat/chat.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'chat' },
  { path: 'chat', component: ChatComponent },
  { path: 'scan', loadComponent: () => import('./features/scan/scan.component').then(m => m.ScanComponent) },
  // future: { path: 'ifu', loadComponent: () => import('./features/ifu/ifu.component').then(m => m.IfuComponent) },
  { path: '**', redirectTo: 'chat' }
];

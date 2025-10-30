import { Routes } from '@angular/router';
import { ChatComponent } from './features/chat/chat.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'chat' },
  { path: 'chat', component: ChatComponent },
  { path: 'scan', loadComponent: () => import('./features/scan/scan.component').then(m => m.ScanComponent) },
  { path: 'search', loadComponent: () => import('./features/search/search.component').then(m => m.SearchComponent) },
  // future: { path: 'ifu', loadComponent: () => import('./features/ifu/ifu.component').then(m => m.IfuComponent) },
  { path: '**', redirectTo: 'chat' }
];

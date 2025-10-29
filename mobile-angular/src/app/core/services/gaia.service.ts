import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface GaiaRequest {
  text: string;
  system_prompt?: string | null;
}

export interface GaiaResponse {
  content: string;
}

@Injectable({ providedIn: 'root' })
export class GaiaService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.backendBaseUrl.replace(/\/$/, '');

  callGaia(req: GaiaRequest): Observable<string> {
    return this.http
      .post<GaiaResponse>(`${this.base}/api/gaia`, req)
      .pipe(map((r) => r.content));
  }
}

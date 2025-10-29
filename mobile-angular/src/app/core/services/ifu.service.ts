import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface GetIfuResponse {
  ifuPath: string;
}

export interface SearchIfuResult {
  doc: string;
  page: number;
  snippet?: string;
}

export interface SearchIfuResponse {
  results: SearchIfuResult[];
}

export interface GetContentResponse {
  content: string;
  images: string[];
}

@Injectable({ providedIn: 'root' })
export class IfuService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.backendBaseUrl.replace(/\/$/, '');

  getIfu(model: string): Observable<GetIfuResponse> {
    const params = new HttpParams().set('model', model);
    return this.http.get<GetIfuResponse>(`${this.base}/get_ifu`, { params });
  }

  searchIfu(keyword: string, ifuPath?: string): Observable<SearchIfuResponse> {
    let params = new HttpParams().set('keyword', keyword);
    if (ifuPath) params = params.set('ifu_path', ifuPath);
    return this.http.get<SearchIfuResponse>(`${this.base}/search_ifu`, { params });
  }

  getContent(docPath: string, page?: number): Observable<GetContentResponse> {
    let params = new HttpParams().set('doc_path', docPath);
    if (page && page > 0) params = params.set('page', String(page));
    return this.http.get<GetContentResponse>(`${this.base}/get_content`, { params });
  }
}

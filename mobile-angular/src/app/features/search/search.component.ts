import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MarkdownModule } from 'ngx-markdown';
import { IfuService, SearchIfuResult } from '../../core/services/ifu.service';
import { IfuContextService } from '../../core/services/ifu-context.service';
import { Router } from '@angular/router';
import { UnescapeNewlinesPipe } from './unescape-newlines.pipe';

@Component({
  selector: 'app-ifu-search',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatListModule,
    MatProgressBarModule,
    MarkdownModule,
    UnescapeNewlinesPipe
  ],
  template: `
    <div class="container">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>说明书检索</mat-card-title>
          <mat-card-subtitle>
            已选 IFU 上下文：
            <ng-container *ngIf="ctx.selection(); else noCtx">
              {{ ctx.selection()?.model || '—' }}
              {{ ctx.selection()?.ifuPath ? '(' + ctx.selection()?.ifuPath + ')' : '' }}
            </ng-container>
            <ng-template #noCtx>无（可先前往“扫码”定位）</ng-template>
          </mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="form" (ngSubmit)="onSearch()" class="form-grid" autocomplete="off" novalidate>
            <mat-form-field appearance="outline" class="field">
              <mat-label>关键词</mat-label>
              <input matInput formControlName="keyword" placeholder="请输入关键词，如：报警、安装、维护" />
              <mat-error *ngIf="form.controls.keyword.hasError('required')">请输入关键词</mat-error>
            </mat-form-field>
            <div class="actions">
              <button mat-raised-button color="primary" type="submit" [disabled]="loading() || form.invalid">搜索</button>
              <button mat-button type="button" (click)="goScan()">去扫码</button>
            </div>
          </form>

          <mat-progress-bar *ngIf="loading()" mode="indeterminate" color="primary"></mat-progress-bar>

          <div class="result" *ngIf="results().length || searched()">
            <h3>搜索结果（{{ results().length }}）</h3>
            <div class="empty" *ngIf="!results().length">未找到相关内容</div>
            <mat-nav-list *ngIf="results().length" class="result-list">
              <mat-list-item *ngFor="let r of results(); let i = index" >
                <span matListItemTitle>{{ r.doc }}</span>
                <span matListItemLine>第 {{ r.page }} 页</span>
                <!-- 使用 div 替代 markdown，按原样显示文本并保留换行 -->
                <div matListItemLine class="snippet" *ngIf="r.snippet" [innerText]="r.snippet | unescapeNewlines"></div>
              </mat-list-item>
            </mat-nav-list>
          </div>

        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .container { width: 100%; }
    .form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .field { width: 100%; }
    .actions { display: flex; gap: 12px; align-items: center; }
    .result { margin-top: 12px; }
    /* Results container: scroll vertically, no horizontal scroll */
    .result-list { max-height: 60vh; overflow-y: auto; overflow-x: hidden; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; }
    /* Let list items grow to fit their content (disable fixed MDC heights) */
    .result-list .mat-mdc-list-item { height: auto; align-items: flex-start; }
    .result-list .mdc-list-item { height: auto; align-items: flex-start; 
      --mdc-list-list-item-one-line-container-height: auto; 
      --mdc-list-list-item-two-line-container-height: auto; 
      --mdc-list-list-item-three-line-container-height: auto; }
    .result-list .mdc-list-item__primary-text { white-space: normal; overflow: visible; text-overflow: unset; }
    /* Wrap long titles and secondary lines */
    .result-list .mat-mdc-list-item-title, .result-list .mat-mdc-list-item-line { white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    .snippet { color: rgba(0,0,0,0.75); font-size: 12px; display: block; overflow-wrap: anywhere; word-break: break-word; white-space: pre-line; }
    /* 纯文本渲染，无需 Markdown 内部样式 */
  `]
})
export class SearchComponent {
  loading = signal(false);
  searched = signal(false);
  results = signal<SearchIfuResult[]>([]);

  form = this.fb.group({
    keyword: this.fb.control<string>('', { nonNullable: true, validators: [Validators.required] }),
  });

  constructor(
    private readonly fb: FormBuilder,
    private readonly ifu: IfuService,
    public readonly ctx: IfuContextService,
    private readonly router: Router
  ) {}

  onSearch() {
    if (this.form.invalid) return;
    const kw = this.form.getRawValue().keyword.trim();
    if (!kw) return;
    const assistantid = this.ctx.selection()?.assistantid || undefined;
    const containerid = this.ctx.selection()?.containerid || undefined;

    this.loading.set(true);
    this.results.set([]);
    this.searched.set(true);

    this.ifu.searchIfu(kw, assistantid, containerid).subscribe({
      next: (res) => {
        this.results.set(res?.results || []);
      },
      error: (err) => {
        console.error('searchIfu error', err);
        this.results.set([]);
      },
      complete: () => this.loading.set(false)
    });
  }


  goScan() {
    this.router.navigate(['/scan']);
  }
}

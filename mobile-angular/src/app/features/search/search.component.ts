import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { IfuService, SearchIfuResult } from '../../core/services/ifu.service';
import { IfuContextService } from '../../core/services/ifu-context.service';
import { Router } from '@angular/router';

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
    MatProgressBarModule
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
            <mat-nav-list *ngIf="results().length">
              <a mat-list-item *ngFor="let r of results(); let i = index" (click)="onViewDetail(r)" [attr.data-index]="i">
                <span matListItemTitle>{{ r.doc }}</span>
                <span matListItemLine>第 {{ r.page }} 页</span>
                <span class="snippet" *ngIf="r.snippet">{{ r.snippet }}</span>
              </a>
            </mat-nav-list>
          </div>

          <div class="detail" *ngIf="detailContent()">
            <h3>详情</h3>
            <pre>{{ detailContent() }}</pre>
            <div class="actions">
              <button mat-button color="primary" (click)="clearDetail()">关闭</button>
            </div>
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
    .snippet { color: rgba(0,0,0,0.6); font-size: 12px; display: block; }
    pre { white-space: pre-wrap; background: #fff; border: 1px solid rgba(0,0,0,0.12); padding: 8px; border-radius: 6px; max-height: 50vh; overflow: auto; }
  `]
})
export class SearchComponent {
  loading = signal(false);
  searched = signal(false);
  results = signal<SearchIfuResult[]>([]);
  detailContent = signal<string>('');

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
    const ifuPath = this.ctx.selection()?.ifuPath || undefined;

    this.loading.set(true);
    this.results.set([]);
    this.searched.set(true);
    this.detailContent.set('');

    this.ifu.searchIfu(kw, ifuPath).subscribe({
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

  onViewDetail(item: SearchIfuResult) {
    if (!item?.doc || !item?.page) return;
    this.loading.set(true);
    this.detailContent.set('');
    this.ifu.getContent(item.doc, item.page).subscribe({
      next: (res) => {
        this.detailContent.set(res?.content || '');
      },
      error: (err) => {
        console.error('getContent error', err);
        this.detailContent.set('获取详情失败');
      },
      complete: () => this.loading.set(false)
    });
  }

  clearDetail() {
    this.detailContent.set('');
  }

  goScan() {
    this.router.navigate(['/scan']);
  }
}

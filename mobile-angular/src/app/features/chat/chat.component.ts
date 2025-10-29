import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { GaiaService } from '../../core/services/gaia.service';
import { IfuContextService } from '../../core/services/ifu-context.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatCardModule,
    MatProgressBarModule
  ],
  template: `
    <div class="container chat-container">
      <mat-card appearance="outlined" class="chat-card">
        <mat-card-header>
          <mat-card-title>聊天（Gaia）</mat-card-title>
          <mat-card-subtitle>系统提示词可选，不填则使用后端默认</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="ifu-block" *ngIf="ctx.selection(); else noIfu">
            <div class="ifu-line">
              <span class="label">当前 IFU 上下文：</span>
              <span class="val">{{ ctx.selection()?.model || '—' }} {{ ctx.selection()?.ifuPath ? '(' + ctx.selection()?.ifuPath + ')' : '' }}</span>
              <span class="spacer"></span>
              <button mat-button color="primary" (click)="goScan()">重新扫码</button>
              <button mat-button color="warn" (click)="clearIfu()">清除</button>
            </div>
          </div>
          <ng-template #noIfu>
            <div class="ifu-block muted">未选择 IFU，上方导航可“扫码”定位</div>
          </ng-template>

          <form [formGroup]="form" (ngSubmit)="onSend()" class="form-grid" autocomplete="off" novalidate>
            <mat-form-field appearance="outline" class="field">
              <mat-label>系统提示词（可选）</mat-label>
              <textarea matInput formControlName="system_prompt" rows="2" placeholder="例如：你是一个有帮助的助手"></textarea>
            </mat-form-field>

            <mat-form-field appearance="outline" class="field">
              <mat-label>问题</mat-label>
              <textarea matInput formControlName="text" rows="4" required placeholder="请输入要提问的内容"></textarea>
              <mat-error *ngIf="form.controls.text.hasError('required')">问题不能为空</mat-error>
            </mat-form-field>

            <div class="actions">
              <button mat-raised-button color="primary" type="submit" [disabled]="loading() || form.invalid">发送</button>
              <button mat-button type="button" (click)="onClear()" [disabled]="loading()">清空</button>
            </div>
          </form>

          <mat-progress-bar *ngIf="loading()" mode="indeterminate" color="primary"></mat-progress-bar>

          <div class="result" *ngIf="result() || error()">
            <h3 class="result-title" [class.error]="!!error()">{{ error() ? '错误' : '结果' }}</h3>
            <pre class="result-content" [class.error]="!!error()">{{ error() || result() }}</pre>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .chat-container { padding-top: clamp(8px, 2vw, 16px); }
    .chat-card { width: 100%; }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: clamp(10px, 2.5vw, 16px);
    }
    .field { width: 100%; }
    .actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }

    .result { margin-top: clamp(12px, 3vw, 20px); }
    .result-title { margin: 0 0 8px; font-size: clamp(16px, 2.5vw, 20px); }
    .result-title.error { color: #b00020; }
    .result-content {
      white-space: pre-wrap;
      background: #fff;
      border-radius: 8px;
      border: 1px solid rgba(0,0,0,0.12);
      padding: clamp(10px, 2.5vw, 16px);
      font-size: clamp(14px, 2.2vw, 16px);
      line-height: 1.6;
      max-height: 50vh;
      overflow: auto;
    }
    .result-content.error { background: #fff5f5; border-color: #ffcdd2; }

    /* Tablet */
    @media (min-width: 768px) {
      .chat-card { max-width: 800px; margin: 0 auto; }
    }

    /* Landscape compact */
    @media (orientation: landscape) and (max-height: 480px) {
      .result-content { max-height: 40vh; }
    }
  `]
})
export class ChatComponent {
  loading = signal(false);
  result = signal<string>('');
  error = signal<string>('');

  form = this.fb.group({
    system_prompt: this.fb.control<string | null>(''),
    text: this.fb.control<string>('', { nonNullable: true, validators: [Validators.required] }),
  });

  constructor(
    private readonly fb: FormBuilder,
    private readonly gaia: GaiaService,
    public readonly ctx: IfuContextService,
    private readonly router: Router
  ) {
    // 若有 IFU 上下文且系统提示词为空，则给出一个温和的默认提示，用户可自行编辑
    const sel = this.ctx.selection();
    if (sel && !this.form?.value?.system_prompt) {
      const hintParts: string[] = [];
      if (sel.model) hintParts.push(`设备型号为：${sel.model}`);
      if (sel.ifuPath) hintParts.push(`相关 IFU：${sel.ifuPath}`);
      const defaultPrompt = `请结合以下上下文回答并尽量引用原文：\n${hintParts.join('\n')}`;
      this.form.patchValue({ system_prompt: defaultPrompt });
    }
  }

  goScan() {
    this.router.navigate(['/scan']);
  }

  clearIfu() {
    this.ctx.clear();
  }

  onSend() {
    if (this.form.invalid || this.loading()) return;
    const { text, system_prompt } = this.form.getRawValue();
    this.loading.set(true);
    this.error.set('');
    this.result.set('');
    this.gaia.callGaia({ text: text!, system_prompt: (system_prompt || undefined) })
      .subscribe({
        next: (content) => { this.result.set(content || ''); },
        error: (err) => { this.error.set(this.friendlyError(err)); },
        complete: () => { this.loading.set(false); }
      });
  }

  onClear() {
    this.form.reset({ system_prompt: '', text: '' });
    this.result.set('');
    this.error.set('');
  }

  private friendlyError(err: any): string {
    if (err?.status === 0) return '无法连接服务器，请检查后端地址与网络';
    if (err?.error?.detail) return String(err.error.detail);
    return err?.message ? String(err.message) : '发生未知错误';
  }
}

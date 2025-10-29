import { Component, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { IfuService } from '../../core/services/ifu.service';
import { IfuContextService } from '../../core/services/ifu-context.service';
import { Router } from '@angular/router';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { Result } from '@zxing/library';

@Component({
  selector: 'app-scan',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="container">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>扫描二维码</mat-card-title>
          <mat-card-subtitle>扫描包含型号或文档路径的二维码，自动定位 IFU</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="video-wrap">
            <video #preview id="preview" playsinline></video>
          </div>
          <div class="hint">
            如设备不支持摄像头或在 HTTP 下受限，可点击下方按钮选择图片进行识别。
          </div>
          <div class="actions">
            <button mat-raised-button color="primary" (click)="start()" [disabled]="scanning()">开始扫描</button>
            <button mat-button (click)="stop()" [disabled]="!scanning()">停止</button>
            <input type="file" accept="image/*" (change)="onPick($event)" />
          </div>

          <div class="result" *ngIf="scanText()">
            <h3>二维码内容</h3>
            <pre>{{ scanText() }}</pre>
          </div>

          <div class="resolve" *ngIf="model() || ifuPath()">
            <h3>识别结果</h3>
            <div *ngIf="model()">型号：{{ model() }}</div>
            <div *ngIf="ifuPath()">IFU：{{ ifuPath() }}</div>
          </div>
        </mat-card-content>
        <mat-card-actions>
          <button mat-raised-button color="accent" (click)="goChat()" [disabled]="!ifuPath() && !model()">去聊天</button>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: [`
    .video-wrap { position: relative; width: 100%; aspect-ratio: 3/4; background: #000; border-radius: 8px; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: cover; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
    .hint { color: rgba(0,0,0,0.6); font-size: 13px; margin: 8px 0 4px; }
    .result, .resolve { margin-top: 12px; }
    pre { white-space: pre-wrap; background: #f6f6f6; padding: 8px; border-radius: 6px; }
  `]
})
export class ScanComponent implements OnDestroy {
  scanning = signal(false);
  scanText = signal<string>('');
  model = signal<string>('');
  ifuPath = signal<string>('');

  private codeReader = new BrowserMultiFormatReader();
  private controls: IScannerControls | null = null;

  constructor(
    private readonly ifu: IfuService,
    private readonly ctx: IfuContextService,
    private readonly router: Router
  ) {}

  async start() {
    try {
      this.scanning.set(true);
      const videoEl = document.getElementById('preview') as HTMLVideoElement;
      const controls = await this.codeReader.decodeFromVideoDevice(undefined, videoEl, (result, _err, _ctrl) => {
        if (result) {
          this.onDecoded(result);
        }
      });
      // keep controls for stop later
      this.controls = controls;
    } catch (e) {
      this.scanning.set(false);
      console.error(e);
      alert('无法启动摄像头。请确认已授权摄像头权限，并在 HTTPS 或本地主机下访问。');
    }
  }

  stop() {
    try { this.controls?.stop(); } catch {}
    this.controls = null;
    this.scanning.set(false);
  }

  ngOnDestroy() { this.stop(); }

  private onDecoded(result: Result) {
    this.stop();
    const text = result.getText();
    this.scanText.set(text);
    this.handleText(text);
  }

  onPick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const img = new Image();
        img.src = String(reader.result);
        await img.decode();
        const res = await this.codeReader.decodeFromImageElement(img);
        this.onDecoded(res);
      } catch (e) {
        console.error(e);
        alert('未能从图片识别二维码');
      }
    };
    reader.readAsDataURL(file);
  }

  private async handleText(text: string) {
    // 支持几种常见形式：
    // 1) 纯型号，如 "Vista 300"
    // 2) 带参数，如 "https://xx?q=...&model=Vista%20300" 或 "model=Vista 300"
    // 3) 直接给出文档路径，如 "ifus/Vista_300.pdf" 或 "doc_path=ifus/Vista_300.pdf"
    const urlMatch = /model=([^&]+)/i.exec(text);
    const docMatch = /(?:ifu_path|doc_path)=([^&]+)/i.exec(text);

    let model = '';
    let ifuPath = '';

    if (docMatch) {
      ifuPath = decodeURIComponent(docMatch[1]);
    }
    if (urlMatch) {
      model = decodeURIComponent(urlMatch[1]);
    }

    if (!model && !ifuPath) {
      if (/\.pdf$/i.test(text) || text.startsWith('ifus/')) {
        ifuPath = text.trim();
      } else {
        model = text.trim();
      }
    }

    this.model.set(model);
    this.ifuPath.set(ifuPath);

    // 若只有型号，调后端定位 IFU
    if (model && !ifuPath) {
      try {
        const r = await this.ifu.getIfu(model).toPromise();
        ifuPath = r?.ifuPath || '';
        this.ifuPath.set(ifuPath);
      } catch (e) {
        console.error(e);
      }
    }

    this.ctx.setSelection({ model, ifuPath });
  }

  goChat() {
    this.router.navigate(['/chat']);
  }
}

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
                  <div class="video-wrap" [class.compact]="hasResult()">
                      <video #preview id="preview" playsinline></video>
                  </div>
                  <div class="hint">
                      如设备不支持摄像头或在 HTTP 下受限，可点击下方按钮选择图片进行识别。
                  </div>
                  <div class="actions">
                      <button mat-raised-button color="primary" (click)="start()" [disabled]="scanning()">开始扫描
                      </button>
                      <button mat-button (click)="stop()" [disabled]="!scanning()">停止</button>
                      <input type="file" accept="image/*" (change)="onPick($event)"/>
                  </div>

                  <div class="result" *ngIf="scanAssistantidText()">
                      <h3>二维码内容</h3>
                      <pre>{{ scanAssistantidText() }}</pre>
                  </div>

                  <div class="resolve" *ngIf="model() || assistantid()">
                      <h3>识别结果</h3>
                      <div *ngIf="model()">型号：{{ model() }}</div>
                      <div *ngIf="assistantid()">assistantid：{{ assistantid() }}</div>
                      <div *ngIf="containerid()">containerid：{{ containerid() }}</div>
                  </div>

                  <div class="qr-holder" *ngIf="qrImageUrl()">
                      <h3>已识别的二维码</h3>
                      <img [src]="qrImageUrl()" alt="已识别的二维码"/>
                  </div>
              </mat-card-content>
              <mat-card-actions>
                  <button mat-raised-button color="primary" (click)="goSearch()"
                          [disabled]="!containerid() && !assistantid() && !model()">去检索
                  </button>
              </mat-card-actions>
          </mat-card>
      </div>
  `,
  styles: [`
    .container { padding: 8px; }
    .video-wrap { position: relative; width: 50%; margin: 0 auto; aspect-ratio: 3/4; background: #000; border-radius: 8px; overflow: hidden; max-height: 50vh; }
    /* 当已有识别结果时，进一步压缩预览区高度，避免出现滚动条 */
    .video-wrap.compact { max-height: 38vh; }
    video { width: 100%; height: 100%; object-fit: contain; }
    .actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .hint { color: rgba(0,0,0,0.6); font-size: 12px; margin: 6px 0 2px; }
    .result, .resolve { margin-top: 8px; }
    .result h3, .resolve h3 { margin: 6px 0; font-size: 14px; }
    pre { white-space: pre-wrap; background: #f6f6f6; padding: 6px; border-radius: 6px; font-size: 12px; }
    .qr-holder { margin-top: 8px; text-align: center; }
    .qr-holder img { width: 200px; max-width: 80%; height: auto; display: block; margin: 4px auto; }

    /* Mobile fine-tuning to fit one screen on iPhone */
    @media (max-width: 430px) {
      mat-card-header, mat-card-content, mat-card-actions { padding: 8px !important; }
      .video-wrap { width: 80%; margin: 0 auto; aspect-ratio: 1/1; max-height: 44vh; }
      .video-wrap.compact { max-height: 34vh; }
      .actions button { padding: 6px 10px; min-width: 0; }
      .hint { font-size: 11px; }
    }
  `]
})
export class ScanComponent implements OnDestroy {
  scanning = signal(false);
  scanAssistantidText = signal<string>('');
  model = signal<string>('');
  assistantid = signal<string>('');
  containerid= signal<string>('');
  qrImageUrl = signal<string>('');
  private codeReader = new BrowserMultiFormatReader();
  private controls: IScannerControls | null = null;
  private navTimer: any = null;

  constructor(
    private readonly ifu: IfuService,
    private readonly ctx: IfuContextService,
    private readonly router: Router
  ) {}

  async start() {
    try {
      // reset previous state
      this.qrImageUrl.set('');
      this.scanAssistantidText.set('');
      this.model.set('');
      this.assistantid.set('');
      this.containerid.set('');
      if (this.navTimer) { clearTimeout(this.navTimer); this.navTimer = null; }

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

  ngOnDestroy() {
    this.stop();
    if (this.navTimer) { clearTimeout(this.navTimer); this.navTimer = null; }
  }

  private onDecoded(result: Result) {
    this.stop();
    const text = result.getText();
    this.scanAssistantidText.set(text);
    // 生成一个可显示的二维码图片（基于原始扫描文本）
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
    this.qrImageUrl.set(qrUrl);
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
    // 2) JSON 字符串，如 '{"model":"Vista 300"}'
    // 3) value比如"Vista 300"去后端从_IFU_MAP获取对应的value，比如"Vista 300": "41f4f2b3-4ae1-42f3-b824-b7430ffb45c5", 中的"41f4f2b3-4ae1-42f3-b824-b7430ffb45c5"
    // 4) 之后都是用"41f4f2b3-4ae1-42f3-b824-b7430ffb45c5" 这个值作为ifu_path的值返回

    let model = '';
    let assistantid = '';
    let containerid = '';

    // 优先尝试解析 JSON（二维码中常见这种结构）
    try {
      const maybeJson = JSON.parse(text);
      if (maybeJson && typeof maybeJson === 'object') {
        const obj = maybeJson as any;
          assistantid = String(obj.ifu_path || obj.doc_path || '').trim();
        model = String(obj.model || '').trim();
      }
    } catch {
      // 非 JSON，继续走下方的 URL/纯文本推断
    }

    // 若仍未解析到，再从 URL/参数中提取
    if (!model || !assistantid) {
      const urlMatch = /model=([^&]+)/i.exec(text);
      const docMatch = /(?:ifu_path|doc_path)=([^&]+)/i.exec(text);
      if (!assistantid && docMatch) {
          assistantid = decodeURIComponent(docMatch[1]);
      }
      if (!model && urlMatch) {
        model = decodeURIComponent(urlMatch[1]);
      }
    }

    // 若还是都没有，从原始文本判断是型号还是文档路径
    if (!model && !assistantid) {
      if (/\.pdf$/i.test(text) || text.startsWith('ifus/')) {
          assistantid = text.trim();
      } else {
        model = text.trim();
      }
    }

    this.model.set(model);
    this.assistantid.set(assistantid);
    this.containerid.set(containerid);

    // 若只有型号，调后端定位 IFU，并将返回的 GUID 用作 ifu_path
    if (model && !assistantid) {
      try {
        const r = await this.ifu.getIfu(model).toPromise();
          assistantid = (r?.assistantid || '').trim();
        this.assistantid.set(assistantid);
          containerid = (r?.containerid || '').trim();
        this.containerid.set(containerid);
        // 显示最终用于检索的 ifu_path（例如 GUID），以符合“之后都用该值”的语义
        if (assistantid) {
          this.scanAssistantidText.set(JSON.stringify({ assistantid, containerid }));
        }
      } catch (e) {
        console.error(e);
      }
    }

    this.ctx.setSelection({ model, assistantid, containerid });

    // 如果成功拿到 assistantid 与 containerid，延迟跳转到检索页，给用户短暂时间查看二维码
    if (assistantid && containerid) {
      if (this.navTimer) { clearTimeout(this.navTimer); }
      const delayMs = 1200; // 1.2s 延迟
      this.navTimer = setTimeout(() => {
        this.router.navigate(['/search']);
        this.navTimer = null;
      }, delayMs);
    }
  }

  goSearch() {
    this.router.navigate(['/search']);
  }

  // 聊天页面已移除

  // 是否已有识别结果，用于触发紧凑布局，压缩视频预览高度
  hasResult(): boolean {
    return !!(this.scanAssistantidText() || this.model() || this.assistantid() || this.containerid());
  }
}

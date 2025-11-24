# 微信小程序 + 后端（FastAPI）示例

这个项目包含：
- 一个最小可用的后端（Python FastAPI），提供 /api/gaia 接口，将前端输入转发到 Gaia 接口（或兼容的 OpenAI 风格接口），并返回文本结果。
- 增加了 IFU 说明书流程专用接口：/get_ifu、/search_ifu、/get_content。
- 一个最小可用的微信小程序，提供输入框把文本发到后端，并显示返回结果；并新增扫码定位设备说明书、关键词搜索及内容详情查看功能。

## 目录结构

```
backend/                # Python 后端
  gaia_client.py        # 调用上游 Gaia 的客户端封装（含重试、令牌估算等）
  main.py               # FastAPI 应用，提供 /api/gaia
  requirements.txt      # 依赖
miniprogram/            # 小程序代码
  app.json/app.js       # 小程序全局配置
  config.js             # 后端 baseUrl 配置（请改为你自己的后端地址）
  pages/index/*         # 主页：输入、发送、显示结果
```

## 后端运行

1. 准备 Python 3.10+ 环境。
2. 安装依赖：
   ```bash
   pip install -r backend/requirements.txt
   ```
3. 设置环境变量（可选）：
   - GAIA_BASE_URL：上游接口地址，默认 `http://localhost:8001/v1/chat/completions`
   - GAIA_MODEL：模型名，默认 `gpt-4o-mini`
   - GAIA_TIMEOUT：请求超时秒数，默认 `30`
   - GAIA_MAX_RETRY：最大重试次数，默认 `3`
   - GAIA_BACKOFF_BASE：重试退避基数，默认 `1.5`
   - GAIA_SESSION_TOKEN_LIMIT：session token 预算上限，默认 `120000`
   - GAIA_MAX_RESPONSE_TOKENS：期望最大回复 tokens，默认 `1024`
   - GAIA_PLACEHOLDER：失败时返回给前端的占位文案
   - DEFAULT_SYSTEM_PROMPT：默认的系统提示词
   - CORS_ORIGINS：CORS 允许的来源，默认 `*`
4. 启动服务：
   ```bash
   # Windows 推荐使用（绑定 0.0.0.0 以便局域网访问）：
   python -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 9000
   # 若你的 Python 启动器为 py，可用：
   # py -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 9000
   # 如果已正确激活虚拟环境且 uvicorn 在 PATH 中，也可以：
   # uvicorn backend.main:app --reload --host 0.0.0.0 --port 9000
   # 启动后，用同一局域网的设备访问： http://<你的机器IP>:9000/health 例如 http://192.168.4.168:9000/health
   # 如访问失败，请检查 Windows 防火墙是否允许 Python/uvicorn 入站，或临时开放 9000 端口。
   ```
5. 健康检查：http://localhost:9000/health
6. 接口说明：
   - 路径：POST /api/gaia
   - 请求体：`{"text": "用户输入", "system_prompt": "可选"}`
   - 响应体：`{"content": "上游返回的文本"}`

### IFU 说明书接口
- GET /get_ifu?model=设备型号
  - 入参：model（必填）
  - 出参：`{"ifuPath": "ifus/Vista_300.pdf"}` 如未找到返回空字符串
- GET /search_ifu?keyword=关键词&ifu_path=说明书路径
  - 入参：keyword（必填），ifu_path（可选，若提供则只在该文档内搜索）
  - 出参：`{"results":[{"doc":"ifus/Vista_300.pdf","page":2,"snippet":"..."}]}`
- GET /get_content?doc_path=文档路径&page=页码
  - 入参：doc_path（必填），page（从1开始，默认1）
  - 出参：`{"content":"完整原文","images":[]}`

> 说明：当前为演示用途，后端使用内置内存数据进行匹配与搜索，便于联调。你可以后续替换为真实的文档索引/检索逻辑。

> 说明：`gaia_client.call_gaia(text, system_prompt)` 实现了你提供的伪代码逻辑：
> - 估算 tokens，达到阈值自动重置 session。
> - 带指数退避的重试。
> - 兼容两种上游返回格式：有 `content` 字段，或 OpenAI 风格 `choices[0].message.content`。

## 微信小程序运行

1. 打开「微信开发者工具」，选择导入项目，目录选择 `miniprogram`。
2. 编辑 `miniprogram/config.js`，将 `baseUrl` 改成你的后端地址（例如内网 IP：`http://192.168.1.100:9000`）。
3. 预览或真机调试。

页面功能：
- 上方输入可选的系统提示词（不填则使用后端默认）。
- 下方输入问题，点击“发送”。
- 页面底部显示后端返回的文本结果。

## 注意事项
- 若部署到 HTTPS 域名，需要在小程序「开发管理」里配置合法的 request 合法域名（业务域名）。
- 本示例未包含鉴权，请在生产环境中补充鉴权/配额等安全措施。
- 如果你的上游 Gaia 接口需要鉴权，请在 `backend/gaia_client.py` 中自行添加 Header（例如 Authorization）。

## 自定义
- 你可以在 `backend/gaia_client.py` 中调整重试次数、退避策略、token 估算方法等。
- 前端可增加流式显示、历史记录、复制按钮等功能。


## 编译/构建环境与步骤（新增加的 Angular 移动端 + 现有后端/小程序）

本项目包含三个部分：
- 后端：Python FastAPI（目录 `backend/`）
- 微信小程序：`miniprogram/`
- 移动端 Web 前端（新增 Angular 18 + Angular Material）：`mobile-angular/`

### 一、编译/构建环境
- 操作系统：Windows 10/11、macOS、或任意常见 Linux 发行版。
- 后端（FastAPI）：
  - Python 3.10 及以上
  - pip / venv（或 conda）
- 微信小程序：
  - 微信开发者工具（最新稳定版）
- 移动 Web（Angular 18）：
  - Node.js ≥ 20（建议使用 LTS）
  - pnpm ≥ 9（推荐，`package.json` 中已声明 engines）
  - 浏览器：Chrome / Edge / Safari（用于开发与验证）

#### 未安装 Node/pnpm/Angular CLI？快速准备（Windows）
- 安装 Node.js 20 LTS（64 位）：https://nodejs.org ；或用 nvm-windows 管理版本：https://github.com/coreybutler/nvm-windows
- 安装/升级完成后，请关闭并重新打开 PowerShell 让 PATH 生效。
- 启用 Corepack 并激活 pnpm（推荐方式）：
  ```powershell
  node -v
  npm -v
  corepack enable
  corepack prepare pnpm@latest --activate
  pnpm -v
  ```
- 如果 Corepack 不可用（Node 太旧或被禁用），使用 npm 全局安装 pnpm：
  ```powershell
  npm i -g pnpm
  # 当前会话确保全局 npm bin 在 PATH（可选）
  $env:PATH += ";$env:APPDATA\\npm"
  pnpm -v
  ```
- 我需要安装 Angular 吗？说明：不需要全局安装 Angular CLI。项目已包含本地 CLI（在 devDependencies）。你可以直接使用本地 CLI：
  ```powershell
  pnpm ng version        # 通过本地 CLI 查看版本
  pnpm start             # 等同 ng serve -o
  pnpm build             # 等同 ng build
  ```
  - 临时使用最新 CLI（无需安装）：
    ```powershell
    pnpm dlx @angular/cli@latest ng version
    ```
  - 若你更习惯全局安装（可选）：
    ```powershell
    npm i -g @angular/cli
    ng version
    ```
- macOS/Linux 提示：流程基本一致，用 `zsh/bash` 执行 `corepack enable && corepack prepare pnpm@latest --activate` 即可。

### 二、构建步骤速览
- 后端：无需编译，安装依赖并运行即可（见下文“后端运行”章节）。
- 微信小程序：在微信开发者工具中打开即可预览/真机调试。
- 移动 Web（Angular）：
  1) 进入目录：`cd mobile-angular`
  2) 安装依赖：`pnpm install`
  3) 生产构建：`pnpm build`
     - 构建产物输出到：`mobile-angular/dist/eifu-mobile-angular/`

> 提示：如需在同一局域网手机上联调，请在 `src/environments/environment.ts` 中把 `backendBaseUrl` 设置为你电脑的局域网 IP，例如 `http://192.168.1.100:9000`。

## 调试环境与步骤

### 1) 后端（FastAPI）本地调试
- 准备 Python 环境与依赖：
  ```bash
  pip install -r backend/requirements.txt
  ```
- 可选环境变量（节选）：
  - `CORS_ORIGINS`：默认 `*`，本地联调足够使用。
  - `GAIA_LOG_PAYLOADS`：是否打印请求负载，默认 `true`。
- 启动（自动热重载）：
  ```bash
  python -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 9000
  ```
- 健康检查：`http://localhost:9000/health`
- 如需在生产前测试更接近真实部署，可以暂时关闭 `--reload` 并仅监听本机或指定网卡。

### 2) 移动 Web（Angular）本地调试
- 第一次：
  ```bash
  cd mobile-angular
  pnpm install
  ```
- 开发服务器（自动刷新）：
  - 仅本机浏览器：
    ```bash
    pnpm start    # 等同 ng serve -o
    # 打开 http://localhost:4200
    ```
  - 手机/平板联调（同一局域网访问）：
    ```bash
    pnpm serve -- --host 0.0.0.0
    # 在手机浏览器访问： http://<你的电脑IP>:4200
    ```
- 后端地址：开发时默认从 `src/environments/environment.ts` 读取 `backendBaseUrl`。
  - 如通过 Nginx 反代为同域，也可将其设为相对路径 `/`（见部署部分）。

### 3) 微信小程序调试
- 打开「微信开发者工具」，选择导入 `miniprogram` 目录。
- 将 `miniprogram/config.js` 的 `baseUrl` 改为你的后端地址（例如 `http://192.168.1.100:9000`）。
- 预览或真机调试，必要时在“开发管理”配置 request 合法域名。

## 部署环境与步骤（推荐 Nginx + 同域反向代理）

目标：将 Angular 前端作为纯静态站点部署，通过 Nginx 反向代理把 `/api/*` 及其它接口转发到后端 FastAPI，从而实现同域（可减少/避免 CORS 问题）。

### 部署环境建议
- Linux 服务器（Ubuntu 20.04/22.04 或同级别）
- Nginx ≥ 1.20
- Python 3.10+（虚拟环境）
- Node.js 仅用于构建（服务器无需常驻 Node 进程）

### 步骤 A：构建前端（Angular）
1. 配置生产环境后端地址：`mobile-angular/src/environments/environment.prod.ts`
   - 若使用同域反代（推荐），可将 `backendBaseUrl` 设为相对路径（如 `/` 或 `/api`），前端请求直接走同域路径。
2. 运行构建（默认生产配置）：
   ```bash
   cd mobile-angular
   pnpm install
   pnpm build         # 等价于：ng build -c production（会使用 environment.prod.ts）
   ```
   - 如需开发构建（不会替换 environment.ts，体积更大，保留 sourceMap），可显式指定：
     ```bash
     ng build -c development
     # 或本地调试：ng serve -c development
     ```
3. 将 `mobile-angular/dist/eifu-mobile-angular/` 整个目录上传至服务器（例如 `/var/www/eifu-mobile-angular/dist/eifu-mobile-angular`）。

### 步骤 B：部署后端（FastAPI）
- 方式一（简单）：临时用 uvicorn 直接起服务（不建议长期生产使用）：
  ```bash
  uvicorn backend.main:app --host 127.0.0.1 --port 9000
  ```
- 方式二（推荐）：`gunicorn` + `uvicorn` workers + systemd
  ```bash
  pip install gunicorn uvicorn
  # 启动命令示例（调试用）：
  gunicorn backend.main:app -k uvicorn.workers.UvicornWorker -b 10.0.4.17:9000 -w 2
  ```
- 可选：配置 systemd 服务（示例）
  ```ini
  [Unit]
  Description=eIFUAssistant FastAPI
  After=network.target

  [Service]
  User=www-data
  WorkingDirectory=/opt/eIFUAssistant
  ExecStart=/opt/venv/bin/gunicorn backend.main:app -k uvicorn.workers.UvicornWorker -b 127.0.0.1:9000 -w 2
  Restart=always
  Environment=CORS_ORIGINS=*

  [Install]
  WantedBy=multi-user.target
  ```

### 步骤 C：配置 Nginx（静态站点 + 反向代理）

```nginx
server {
  listen 80;
  server_name your-domain.example.com;

  root /var/www/eifu-mobile-angular/dist/eifu-mobile-angular;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html; # Angular SPA 回退
  }

  # 反向代理到 FastAPI（按你的后端监听地址调整）
  location /api/ {
    proxy_pass http://127.0.0.1:9000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /get_ifu {
    proxy_pass http://127.0.0.1:9000/get_ifu;
  }
  location /search_ifu {
    proxy_pass http://127.0.0.1:9000/search_ifu;
  }
  location /get_content {
    proxy_pass http://127.0.0.1:9000/get_content;
  }
}
```

- 若需 HTTPS，请配置证书（或使用 Certbot 自动签发）。
- 如使用同域反代，前端可将 `backendBaseUrl` 设为同域路径，避免跨域。

## 常见问题（FAQ）
- 前端手机无法访问开发服务器：
  - 确认使用 `pnpm serve -- --host 0.0.0.0` 启动。
  - Windows 防火墙放行 4200 端口；浏览器需在同一局域网。
- CORS 报错：
  - 开发阶段：`CORS_ORIGINS=*`；或通过 Nginx 同域反代。
  - 生产阶段：优先推荐同域反代；如直连后端，按需设置 `CORS_ORIGINS`。
- Angular 构建产物路径：`mobile-angular/dist/eifu-mobile-angular/`
- 切换后端地址：
  - 开发环境：`mobile-angular/src/environments/environment.ts`
  - 生产环境：`mobile-angular/src/environments/environment.prod.ts`
- 如果eIFU是中文， 在GAIA上的system prompt最好用中文描述 + GAIA自动生成的描述
## 使用deos vista300 support EAP-TLS?来测试多行
Structured Output Schema on GAIA
{
"type": "object",
"properties": {
"results": {
"type": "array",
"description": "Document search results",
"items": {
"type": "object",
"properties": {
"doc": {
"type": "string",
"description": "Source document path or name"
},
"page": {
"type": "integer",
"description": "Page number in the source document"
},
"refId": {
"type": "string",
"description": "GAIA refId for citation"
},
"score": {
"type": "number",
"description": "Relevance score of this hit"
},
"snippet": {
"type": "string",
"description": "Original text snippet from the document"
}
},
"required": ["doc", "page", "refId", "snippet"]
}
}
},
"required": ["results"]
}
#############

{
"type": "object",
"properties": {
"results": {
"type": "array",
"description": "Document search results",
"items": {
"type": "object",
"properties": {
"doc": { "type": "string", "description": "Source document path or name" },
"page": { "type": "integer", "description": "Page number in the source document" },
"refId": { "type": "string", "description": "GAIA refId for citation" },
"score": { "type": "number", "description": "Relevance score of this hit" },
"snippet": { "type": "string", "description": "Original text snippet from the document" }
},
"required": ["doc", "page", "refId", "snippet"]
}
}
},
"required": ["results"]
}

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

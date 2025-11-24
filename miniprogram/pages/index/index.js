const { baseUrl } = require('../../config.js')

// 解析二维码文本，尽量与 mobile-angular 的 handleText 行为一致
function parseScanText(text) {
  let model = ''
  let assistantid = ''
  let containerid = ''

  if (!text || typeof text !== 'string') return { model, assistantid, containerid }

  // 1) 尝试 JSON
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object') {
      assistantid = String(obj.ifu_path || obj.doc_path || obj.assistantid || '').trim()
      containerid = String(obj.containerid || '').trim()
      model = String(obj.model || '').trim()
    }
  } catch (e) {
    // ignore
  }

  // 2) URL/参数提取
  if (!model || !assistantid) {
    const urlMatch = /model=([^&]+)/i.exec(text)
    const docMatch = /(?:ifu_path|doc_path|assistantid)=([^&]+)/i.exec(text)
    const containerMatch = /(?:containerid)=([^&]+)/i.exec(text)
    if (!assistantid && docMatch) assistantid = decodeURIComponent(docMatch[1])
    if (!containerid && containerMatch) containerid = decodeURIComponent(containerMatch[1])
    if (!model && urlMatch) model = decodeURIComponent(urlMatch[1])
  }

  // 3) 纯文本：判断像路径还是型号
  if (!model && !assistantid) {
    if (/\.pdf$/i.test(text) || text.startsWith('ifus/')) {
      assistantid = text.trim()
    } else {
      model = text.trim()
    }
  }

  return { model, assistantid, containerid }
}

// 格式化文档标题：移除前缀的 containerid（UUID 形式），例如：
// "e05d7522-891a-416a-8bed-cbefc0c64209_A1xx_..." => "A1xx_..."
function formatDoc(doc) {
  const s = String(doc || '')
  // 匹配开头 UUID (8-4-4-4-12) 后面紧跟下划线、空格、破折号或斜杠
  const m = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ _\/-]+/i
  return s.replace(m, '')
}

// 语音识别（WechatSI 插件）
let _siManager = null

Page({
  data: {
    // Gaia demo
    text: '',
    systemPrompt: '',
    response: '',
    loading: false,

    // IFU flow (对齐 Angular ScanComponent)
    scanRawText: '',
    model: '',
    assistantid: '',
    containerid: '',

    keyword: '',
    results: [],

    // 详情浮层（直接展示 snippet，不再请求 /get_content）
    detailContent: '',
    showDetail: false,

    // 底部投票显示的默认值
    votes: { up: 0, down: 0 },
    voteBusy: false,

    // 语音输入
    recording: false,
    voiceSupported: false
  },

  // ===== Gaia demo events =====
  onTextInput(e) {
    this.setData({ text: e.detail.value })
  },

  onSystemPromptInput(e) {
    this.setData({ systemPrompt: e.detail.value })
  },

  onSubmit() {
    const text = (this.data.text || '').trim()
    if (!text) {
      wx.showToast({ title: '请输入文本', icon: 'none' })
      return
    }
    const payload = { text }
    const sp = (this.data.systemPrompt || '').trim()
    if (sp) payload.system_prompt = sp

    this.setData({ loading: true, response: '' })

    wx.request({
      url: `${baseUrl}/api/gaia`,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          const content = res.data.content || ''
          this.setData({ response: content })
        } else {
          const msg = (res.data && (res.data.detail || res.data.message)) || `错误 ${res.statusCode}`
          wx.showToast({ title: String(msg), icon: 'none' })
        }
      },
      fail: (err) => {
        wx.showToast({ title: '网络错误，请检查后端地址', icon: 'none' })
        console.error('request fail', err)
      },
      complete: () => {
        this.setData({ loading: false })
      }
    })
  },

  // ===== IFU flow events =====
  onScan() {
    wx.scanCode({
      onlyFromCamera: false, // 允许相册
      success: (res) => {
        const raw = String(res.result || '')
        if (!raw) {
          wx.showToast({ title: '未识别到二维码内容', icon: 'none' })
          return
        }
        const { model, assistantid, containerid } = parseScanText(raw)
        this.setData({ scanRawText: raw, model, assistantid, containerid })

        // 若只有型号没有 assistantid，调用后端进行定位
        if (model && !assistantid) {
          wx.showLoading({ title: '正在定位说明书...', mask: true })
          wx.request({
            url: `${baseUrl}/api/get_ifu?model=${encodeURIComponent(model)}`,
            method: 'GET',
            success: (ret) => {
              const a = (ret.data && ret.data.assistantid) || ''
              const c = (ret.data && ret.data.containerid) || ''
              this.setData({ assistantid: a, containerid: c })
              if (a && c) {
                wx.showToast({ title: '已定位说明书', icon: 'success' })
              } else {
                wx.showToast({ title: '未找到匹配说明书', icon: 'none' })
              }
            },
            fail: () => wx.showToast({ title: '请求失败', icon: 'none' }),
            complete: () => {
              try { wx.hideLoading() } catch (e) {}
            }
          })
        }
      },
      fail: () => wx.showToast({ title: '扫码失败', icon: 'none' })
    })
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  // 统一的 IFU 搜索请求方法，支持两种模式：'search' 与 'ask'
  requestIfuSearch(mode) {
    const kw = (this.data.keyword || '').trim()
    if (!kw) {
      wx.showToast({ title: '请输入关键词', icon: 'none' })
      return
    }

    // 与 Angular 行为对齐：assistantid/containerid 若存在则传，否则仅用关键词也可搜索
    const params = [
      `keyword=${encodeURIComponent(kw)}`,
      `mode=${encodeURIComponent(mode)}`
    ]
    if (this.data.assistantid) params.push(`assistantid=${encodeURIComponent(this.data.assistantid)}`)
    if (this.data.containerid) params.push(`containerid=${encodeURIComponent(this.data.containerid)}`)

    const url = `${baseUrl}/api/search_ifu?${params.join('&')}`

    const loadingTitle = mode === 'ask' ? '正在向AI提问...' : '正在搜索...'
    wx.showLoading({ title: loadingTitle, mask: true })
    wx.request({
      url,
      method: 'GET',
      success: (res) => {
        const raw = (res.data && res.data.results) || []
        const results = raw.map(r => ({
          ...r,
          docDisplay: formatDoc(r && r.doc)
        }))
        this.setData({ results })
        if (!results.length) {
          const emptyMsg = mode === 'ask' ? 'AI 暂无答案' : '未找到相关内容'
          wx.showToast({ title: emptyMsg, icon: 'none' })
        }
      },
      fail: () => wx.showToast({ title: (mode === 'ask' ? '提问失败' : '搜索失败'), icon: 'none' }),
      complete: () => {
        try { wx.hideLoading() } catch (e) {}
      }
    })
  },

  onSearchIFU() {
    // 传统检索模式
    this.requestIfuSearch('search')
  },

  // 新增：AI 问答模式，与 Angular 的 onAsk() 对齐
  onAskIFU() {
    this.requestIfuSearch('ask')
  },

  // 点击结果项，直接用 snippet 作为详情展示
  onViewDetail(e) {
    const snippet = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.snippet) || ''
    this.setData({ detailContent: snippet || '', showDetail: true })
  },

  closeDetail() {
    this.setData({ showDetail: false, detailContent: '' })
  },

  // 分包示例跳转
  goToPkgDemo() {
    wx.navigateTo({ url: '/packageA/pages/demo/index' })
  },

  // ===== 语音输入（按住说话） =====
  initVoice() {
    try {
      const si = requirePlugin && requirePlugin('WechatSI')
      if (!si || !si.getRecordRecognitionManager) {
        this.setData({ voiceSupported: false })
        return
      }
      _siManager = si.getRecordRecognitionManager()
      if (!_siManager) {
        this.setData({ voiceSupported: false })
        return
      }

      this.setData({ voiceSupported: true })

      _siManager.onStart = () => {
        // 已开始录音
      }

      _siManager.onRecognize = (res) => {
        // 实时结果（部分机型/版本支持）
        const t = (res && (res.result || res.result || res.msg)) || ''
        if (t) this.setData({ keyword: t })
      }

      _siManager.onStop = (res) => {
        const text = (res && res.result) || ''
        if (!this._voiceCancelled && text) {
          this.setData({ keyword: text })
        }
        this._voiceCancelled = false
        this.setData({ recording: false })
      }

      _siManager.onError = (err) => {
        this.setData({ recording: false })
        wx.showToast({ title: '语音识别失败', icon: 'none' })
        console.error('WechatSI error', err)
      }
    } catch (e) {
      this.setData({ voiceSupported: false })
      console.warn('WechatSI 初始化失败', e)
    }
  },

  _ensureRecordAuth(cb) {
    wx.getSetting({
      success: (st) => {
        const authed = st && st.authSetting && st.authSetting['scope.record']
        if (authed) {
          cb && cb()
        } else {
          wx.authorize({
            scope: 'scope.record',
            success: () => cb && cb(),
            fail: () => {
              wx.showModal({
                title: '需要麦克风权限',
                content: '请在设置中允许使用麦克风以启用语音输入',
                confirmText: '去设置',
                success: (r) => {
                  if (r.confirm) wx.openSetting({})
                }
              })
            }
          })
        }
      },
      fail: () => cb && cb()
    })
  },

  startVoice() {
    if (!this.data.voiceSupported || !_siManager) {
      wx.showToast({ title: '当前环境不支持语音', icon: 'none' })
      return
    }
    this._ensureRecordAuth(() => {
      try {
        this._voiceCancelled = false
        this.setData({ recording: true })
        _siManager.start({ lang: 'zh_CN' })
      } catch (e) {
        this.setData({ recording: false })
        wx.showToast({ title: '启动录音失败', icon: 'none' })
      }
    })
  },

  stopVoice() {
    if (!this.data.recording || !_siManager) return
    try { _siManager.stop() } catch (e) {
      this.setData({ recording: false })
    }
  },

  cancelVoice() {
    this._voiceCancelled = true
    if (this.data.recording && _siManager) {
      try { _siManager.stop() } catch (e) {}
    }
  },

  // ===== 投票功能 =====
  fetchVotes() {
    wx.request({
      url: `${baseUrl}/api/vote`,
      method: 'GET',
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          const up = Number(res.data.up || 0)
          const down = Number(res.data.down || 0)
          this.setData({ votes: { up, down } })
        }
      }
    })
  },

  onVoteUp() { this._postVote('up') },
  onVoteDown() { this._postVote('down') },

  _postVote(type) {
    if (this.data.voteBusy) return
    this.setData({ voteBusy: true })
    wx.request({
      url: `${baseUrl}/api/vote`,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: { type },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          const up = Number(res.data.up || 0)
          const down = Number(res.data.down || 0)
          this.setData({ votes: { up, down } })
        } else {
          wx.showToast({ title: '投票失败', icon: 'none' })
        }
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => this.setData({ voteBusy: false })
    })
  },

  onLoad() {
    // 初始化语音
    this.initVoice()
  },

  onShow() {
    // 每次显示页面时刷新投票数
    try { this.fetchVotes() } catch (e) {}
  }
})

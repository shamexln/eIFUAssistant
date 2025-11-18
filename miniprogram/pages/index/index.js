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
  // 匹配开头 UUID (8-4-4-4-12) 后面紧跟下划线或空格或破折号
  const m = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ _-/]+/i
  return s.replace(m, '')
}

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
    showDetail: false
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

  onSearchIFU() {
    const kw = (this.data.keyword || '').trim()
    if (!kw) {
      wx.showToast({ title: '请输入关键词', icon: 'none' })
      return
    }
    if (!this.data.assistantid) {
      wx.showToast({ title: '请先扫码或选择设备以定位说明书', icon: 'none' })
      return
    }
    const url = `${baseUrl}/api/search_ifu?keyword=${encodeURIComponent(kw)}&assistantid=${encodeURIComponent(this.data.assistantid)}&containerid=${encodeURIComponent(this.data.containerid || '')}`
    wx.showLoading({ title: '正在搜索...', mask: true })
    wx.request({
      url,
      method: 'GET',
      success: (res) => {
        const raw = (res.data && res.data.results) || []
        // 移除 doc 前的 containerid（若存在）后再显示
        const results = raw.map(r => ({
          ...r,
          docDisplay: formatDoc(r && r.doc)
        }))
        this.setData({ results })
        if (!results.length) {
          wx.showToast({ title: '未找到相关内容', icon: 'none' })
        }
      },
      fail: () => wx.showToast({ title: '搜索失败', icon: 'none' }),
      complete: () => {
        try { wx.hideLoading() } catch (e) {}
      }
    })
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

  onShow() {
    // 每次显示页面时刷新投票数
    try { this.fetchVotes() } catch (e) {}
  }
})

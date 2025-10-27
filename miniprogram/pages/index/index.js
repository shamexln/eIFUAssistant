const { baseUrl } = require('../../config.js')

Page({
  data: {
    // Gaia demo
    text: '',
    systemPrompt: '',
    response: '',
    loading: false,
    // IFU flow
    deviceModel: '',
    ifuPath: '',
    keyword: '',
    results: [],
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
      success: (res) => {
        try {
          const info = JSON.parse(res.result || '{}')
          const model = info.model || ''
          if (!model) {
            wx.showToast({ title: '二维码缺少型号信息', icon: 'none' })
            return
          }
          wx.request({
            url: `${baseUrl}/get_ifu?model=${encodeURIComponent(model)}`,
            method: 'GET',
            success: (ret) => {
              const ifuPath = (ret.data && ret.data.ifuPath) || ''
              this.setData({ deviceModel: model, ifuPath })
              if (ifuPath) {
                wx.showToast({ title: '设备说明书已定位！', icon: 'success' })
              } else {
                wx.showToast({ title: '未找到匹配说明书', icon: 'none' })
              }
            },
            fail: () => wx.showToast({ title: '请求失败', icon: 'none' })
          })
        } catch (e) {
          wx.showToast({ title: '二维码内容无效', icon: 'none' })
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
    const url = `${baseUrl}/search_ifu?keyword=${encodeURIComponent(kw)}&ifu_path=${encodeURIComponent(this.data.ifuPath || '')}`
    wx.request({
      url,
      method: 'GET',
      success: (res) => {
        const results = (res.data && res.data.results) || []
        this.setData({ results })
        if (!results.length) {
          wx.showToast({ title: '未找到相关内容', icon: 'none' })
        }
      },
      fail: () => wx.showToast({ title: '搜索失败', icon: 'none' })
    })
  },

  onViewDetail(e) {
    const { doc, page } = e.currentTarget.dataset
    if (!doc || !page) return
    const url = `${baseUrl}/get_content?doc_path=${encodeURIComponent(doc)}&page=${page}`
    wx.request({
      url,
      method: 'GET',
      success: (res) => {
        const content = (res.data && res.data.content) || ''
        this.setData({ detailContent: content, showDetail: true })
      },
      fail: () => wx.showToast({ title: '获取详情失败', icon: 'none' })
    })
  },

  closeDetail() {
    this.setData({ showDetail: false, detailContent: '' })
  }
})

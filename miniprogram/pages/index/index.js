const { baseUrl } = require('../../config.js')

// 解析二维码文本，尽量与 mobile-angular 的 handleText 行为一致
function parseScanText(text) {
  let model = ''
  let assistantid = ''
  let containerid = ''
  let type = ''

  if (!text || typeof text !== 'string') return { model, assistantid, containerid, type }

  // 1) 尝试 JSON
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object') {
      assistantid = String(obj.ifu_path || obj.doc_path || obj.assistantid || '').trim()
      containerid = String(obj.containerid || '').trim()
      model = String(obj.model || '').trim()
      type = String(obj.type || obj.deviceType || '').trim()
    }
  } catch (e) {
    // ignore
  }

  // 2) URL/参数提取
  if (!model || !assistantid || !type) {
    const urlMatch = /model=([^&]+)/i.exec(text)
    const docMatch = /(?:ifu_path|doc_path|assistantid)=([^&]+)/i.exec(text)
    const containerMatch = /(?:containerid)=([^&]+)/i.exec(text)
    const typeMatch = /(?:type|deviceType)=([^&]+)/i.exec(text)
    if (!assistantid && docMatch) assistantid = decodeURIComponent(docMatch[1])
    if (!containerid && containerMatch) containerid = decodeURIComponent(containerMatch[1])
    if (!model && urlMatch) model = decodeURIComponent(urlMatch[1])
    if (!type && typeMatch) type = decodeURIComponent(typeMatch[1])
  }

  // 3) 纯文本：判断像路径还是型号
  if (!model && !assistantid) {
    if (/\.pdf$/i.test(text) || text.startsWith('ifus/')) {
      assistantid = text.trim()
    } else {
      model = text.trim()
    }
  }

  return { model, assistantid, containerid, type }
}

// 统一的错误提示：引导用户查看“帮助”或稍后再试
function showErrorSuggestHelp(title, detail) {
  const t = title || '请求失败'
  const c = (detail ? String(detail) + '\n\n' : '') + '请稍后再试，或前往“帮助”查看常见问题。'
  try {
    wx.showModal({
      title: t,
      content: c,
      showCancel: true,
      cancelText: '稍后再试',
      confirmText: '查看帮助',
      success: (r) => {
        if (r && r.confirm) {
          // 跳转到帮助页
          wx.navigateTo({ url: '/pages/help/index' })
        }
      }
    })
  } catch (e) {
    // 回退到 toast
    wx.showToast({ title: t, icon: 'none' })
  }
}

// 统一的成功提示：简洁地告诉用户操作已完成
function showSuccess(title) {
  const t = title || '已完成'
  try {
    wx.showToast({ title: t, icon: 'success' })
  } catch (e) {
    // 降级为无图标 toast
    wx.showToast({ title: t, icon: 'none' })
  }
}

function handleRequestFail(err, context) {
  const em = (err && err.errMsg) || ''
  const isTimeout = /timeout/i.test(em)
  const detail = isTimeout ? '请求超时' : (em || '网络异常')
  showErrorSuggestHelp(context || '服务不可用', detail)
  console.error('[request fail]', context, err)
}

function handleHttpNon2xx(res, context) {
  const msg = (res && res.data && (res.data.detail || res.data.message)) || `错误 ${res && res.statusCode}`
  showErrorSuggestHelp(context || '请求失败', msg)
}

// 格式化文档标题：移除前缀的 containerid（UUID 形式），例如：
// "e05d7522-891a-416a-8bed-cbefc0c64209_A1xx_..." => "A1xx_..."
function formatDoc(doc) {
  const s = String(doc || '')
  // 匹配开头 UUID (8-4-4-4-12) 后面紧跟下划线、空格、破折号或斜杠
  const m = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ _\/-]+/i
  return s.replace(m, '')
}

// 根据设备类型选择图标：为兼容小程序，优先使用 webp 资源
function getTypeIcon(type) {
  const t = String(type || '').toLowerCase()
  // 目前项目提供了 webp 与 svg 两种格式，选择 webp 更适配微信小程序
  const base = '../../icon/default.png'
  const anes = '../../icon/anes.png'
  const vent = '../../icon/vent.png'
  const vista = '../../icon/vista.png'
  // 暂无更多类型区分时，均返回相同设备图标；后续可在此扩展映射
  switch (t) {
    case 'anes':
      return anes
    case 'vent':
      return vent
    case 'monitor':
      return vista
    default:
      return base
  }
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
    type: '',
    typeIcon: '',

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
      timeout: 35000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          const content = res.data.content || ''
          this.setData({ response: content })
          // 成功提示：告知用户已拿到回复
          showSuccess('已获取回复')
        } else {
          handleHttpNon2xx(res, 'Gaia 服务')
        }
      },
      fail: (err) => {
        handleRequestFail(err, 'Gaia 服务')
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
        const { model, assistantid, containerid, type } = parseScanText(raw)
        const typeIcon = type ? getTypeIcon(type) : ''
        this.setData({ scanRawText: raw, model, assistantid, containerid, type, typeIcon })

        // 若只有型号没有 assistantid，调用后端进行定位
        if (model && !assistantid) {
          wx.showLoading({ title: '正在定位说明书...', mask: true })
          wx.request({
            url: `${baseUrl}/api/get_ifu?model=${encodeURIComponent(model)}`,
            method: 'GET',
            timeout: 35000,
            success: (ret) => {
              if (ret.statusCode >= 200 && ret.statusCode < 300) {
                const a = (ret.data && ret.data.assistantid) || ''
                const c = (ret.data && ret.data.containerid) || ''
                this.setData({ assistantid: a, containerid: c })
                if (a && c) {
                  wx.showToast({ title: '已定位说明书', icon: 'success' })
                } else {
                  wx.showToast({ title: '未找到匹配说明书', icon: 'none' })
                }
              } else {
                handleHttpNon2xx(ret, '定位说明书')
              }
            },
            fail: (e) => handleRequestFail(e, '定位说明书'),
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
      timeout: 35000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const raw = (res.data && res.data.results) || []
          const results = raw.map(r => ({
            ...r,
            docDisplay: formatDoc(r && r.doc)
          }))
          this.setData({ results })
          if (!results.length) {
            const emptyMsg = mode === 'ask' ? 'AI 暂无答案' : '未找到相关内容'
            wx.showToast({ title: emptyMsg, icon: 'none' })
          } else {
            // 成功提示：有结果时提示成功
            showSuccess(mode === 'ask' ? '已获取AI答案' : '找到相关内容')
          }
        } else {
          handleHttpNon2xx(res, mode === 'ask' ? 'AI 提问' : 'IFU 搜索')
        }
      },
      fail: (e) => handleRequestFail(e, mode === 'ask' ? 'AI 提问' : 'IFU 搜索'),
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
      timeout: 20000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          const up = Number(res.data.up || 0)
          const down = Number(res.data.down || 0)
          this.setData({ votes: { up, down } })
        } else {
          // 投票统计失败不打断用户，但仍输出日志
          console.warn('获取投票统计失败', res)
        }
      },
      fail: (e) => {
        console.warn('获取投票统计网络异常', e)
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
      timeout: 20000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          const up = Number(res.data.up || 0)
          const down = Number(res.data.down || 0)
          this.setData({ votes: { up, down } })
          // 成功提示：投票已生效
          showSuccess('投票成功')
        } else {
          handleHttpNon2xx(res, '投票')
        }
      },
      fail: (e) => handleRequestFail(e, '投票'),
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

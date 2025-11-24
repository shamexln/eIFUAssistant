// 帮助页逻辑：展示使用指引与当前小程序版本号
Page({
  data: {
    // 初始为空，实际版本在 onLoad 中通过全局/环境检测写入
    version: ''
  },

  onLoad() {
    try {
      const app = getApp && getApp()
      const v = app && app.globalData && app.globalData.version
      let version = v || ''
      let envLabel = ''
      // 若全局未写入，尝试直接从基础库读取
      if (!version && typeof wx !== 'undefined') {
        try {
          const acc = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null
          if (acc && acc.miniProgram && acc.miniProgram.version) {
            version = acc.miniProgram.version
          }
          // 兜底：开发/体验态下 version 可能为空，使用 envVersion 提示
          if (!version && acc && acc.miniProgram && acc.miniProgram.envVersion) {
            const env = String(acc.miniProgram.envVersion || '').toLowerCase()
            envLabel = env === 'develop' ? '开发版' : env === 'trial' ? '体验版' : env === 'release' ? '正式版' : (acc.miniProgram.envVersion || '')
          }
        } catch (e) {}
        if (!version && wx.getAppBaseInfo) {
          try {
            const base = wx.getAppBaseInfo()
            if (base && base.appVersion) version = base.appVersion
            if (!version && base && base.envVersion) {
              const env = String(base.envVersion || '').toLowerCase()
              envLabel = envLabel || (env === 'develop' ? '开发版' : env === 'trial' ? '体验版' : env === 'release' ? '正式版' : (base.envVersion || ''))
            }
          } catch (e) {}
        }
      }
      this.setData({ version: version || envLabel || '' })
    } catch (e) {
      // ignore
    }
  }
})

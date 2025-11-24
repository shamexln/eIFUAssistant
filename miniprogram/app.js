App({
  onLaunch() {
    // 尝试从运行环境获取小程序版本号
    let version = ''
    let envLabel = ''
    try {
      const acc = (typeof wx !== 'undefined' && wx.getAccountInfoSync) ? wx.getAccountInfoSync() : null
      if (acc && acc.miniProgram && acc.miniProgram.version) {
        version = acc.miniProgram.version
      }
      // 兜底：开发/体验态下 version 可能为空，尝试读取 envVersion
      if (!version && acc && acc.miniProgram && acc.miniProgram.envVersion) {
        const env = String(acc.miniProgram.envVersion || '').toLowerCase()
        envLabel = env === 'develop' ? '开发版' : env === 'trial' ? '体验版' : env === 'release' ? '正式版' : (acc.miniProgram.envVersion || '')
      }
    } catch (e) {
      // ignore
    }
    // 新版基础库可用 getAppBaseInfo 读取 appVersion
    if (!version) {
      try {
        const base = (typeof wx !== 'undefined' && wx.getAppBaseInfo) ? wx.getAppBaseInfo() : null
        if (base && base.appVersion) version = base.appVersion
        // 同样尝试从基础信息中读取 envVersion
        if (!version && base && base.envVersion) {
          const env = String(base.envVersion || '').toLowerCase()
          envLabel = envLabel || (env === 'develop' ? '开发版' : env === 'trial' ? '体验版' : env === 'release' ? '正式版' : (base.envVersion || ''))
        }
      } catch (e) {
        // ignore
      }
    }
    // 兜底：若运行环境不可用，仍设置占位，避免页面渲染异常
    this.globalData.version = version || envLabel || ''
  },
  globalData: {
    // 可在这里配置后端地址，或使用 config.js 覆盖
    baseUrl: 'https://eifu.art',
    // 运行时写入，帮助页读取展示
    version: ''
  }
})

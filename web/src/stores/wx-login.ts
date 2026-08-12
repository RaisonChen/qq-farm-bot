import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useUserStore } from './user'

export interface WxLoginConfig {
  enabled: boolean
  appId: string
  autoAddAccount: boolean
  userIsolation: boolean
}

export const useWxLoginStore = defineStore('wx-login', () => {
  const defaultConfig: WxLoginConfig = {
    enabled: true,
    appId: 'wx5306c5978fdb76e4',
    autoAddAccount: true,
    userIsolation: true,
  }
  const userStore = useUserStore()
  const currentUserId = computed(() => userStore.username || 'default')
  const rawConfig = ref<WxLoginConfig>({ ...defaultConfig })
  const config = computed<WxLoginConfig>(() => ({ ...defaultConfig, ...rawConfig.value }))
  const isLoading = ref(false)
  const qrCode = ref<string | null>(null)
  const qrCreatedAt = ref(0)
  const uuid = ref('')
  const wxid = ref('')
  const taskId = ref('')
  const nickname = ref('')
  const avatar = ref('')
  const status = ref<'idle' | 'qr_loading' | 'qr_ready' | 'scanning' | 'confirming' | 'code_loading' | 'success' | 'error'>('idle')
  const statusMessage = ref('')
  const errorMessage = ref('')
  const qrEndpoint = 'tasks'
  let qrObjectUrl = ''

  async function loadConfig() {
    try {
      const { data } = await api.get('/api/user/wxlogin-config', { skipErrorToast: true } as any)
      if (data?.ok && data.config) {
        rawConfig.value = { ...defaultConfig, ...data.config }
      }
      else {
        rawConfig.value = { ...defaultConfig }
      }
    }
    catch {
      // 拉取失败时回退默认值，后端仍有 enabled 守卫兜底
      rawConfig.value = { ...defaultConfig }
    }
  }

  async function disposeTask() {
    const id = taskId.value
    taskId.value = ''
    if (id) await api.delete(`/api/wx-login/tasks/${id}`, { skipErrorToast: true } as any).catch(() => undefined)
  }

  function resetState() {
    void disposeTask()
    if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl)
    qrObjectUrl = ''
    qrCode.value = null
    qrCreatedAt.value = 0
    uuid.value = ''
    wxid.value = ''
    nickname.value = ''
    avatar.value = ''
    status.value = 'idle'
    statusMessage.value = ''
    errorMessage.value = ''
  }

  async function getQRCode(): Promise<boolean> {
    resetState()
    isLoading.value = true
    status.value = 'qr_loading'
    statusMessage.value = '正在获取二维码...'
    try {
      const created = await api.post('/api/wx-login/tasks', { app_id: config.value.appId })
      const task = created.data?.data
      const id = String(task?.task_id || '')
      if (!id || !task?.qr_url) throw new Error('未创建登录任务')
      taskId.value = id
      uuid.value = id
      const image = await api.get(task.qr_url, { responseType: 'blob' })
      qrObjectUrl = URL.createObjectURL(image.data)
      qrCode.value = qrObjectUrl
      qrCreatedAt.value = Date.now()
      status.value = 'qr_ready'
      statusMessage.value = '请使用微信扫码登录'
      return true
    }
    catch (error: any) {
      status.value = 'error'
      errorMessage.value = error.response?.data?.error || error.message || '获取二维码失败'
      return false
    }
    finally {
      isLoading.value = false
    }
  }

  async function checkLogin(): Promise<{ success: boolean, wxid?: string, nickname?: string, avatar?: string }> {
    if (!taskId.value) return { success: false }
    status.value = 'scanning'
    statusMessage.value = '正在检查登录状态...'
    try {
      const result = await api.get(`/api/wx-login/tasks/${taskId.value}/status`, { timeout: 40000 })
      const taskStatus = result.data?.data?.status
      if (taskStatus === 'waiting') {
        status.value = 'qr_ready'
        statusMessage.value = '等待扫码中'
        return { success: false }
      }
      if (taskStatus === 'scanned') {
        status.value = 'confirming'
        statusMessage.value = '已扫码，请在手机确认登录'
        return { success: false }
      }
      if (taskStatus !== 'authorized') throw new Error('二维码已失效，请重新获取')
      status.value = 'confirming'
      statusMessage.value = '正在建立登录会话...'
      const confirmed = await api.post(`/api/wx-login/tasks/${taskId.value}/confirm`)
      const identity = String(confirmed.data?.data?.openid || confirmed.data?.data?.wxid || '')
      wxid.value = identity
      nickname.value = identity || '微信用户'
      avatar.value = ''
      status.value = 'success'
      statusMessage.value = '登录成功，正在获取农场 Code...'
      return { success: true, wxid: wxid.value, nickname: nickname.value, avatar: avatar.value }
    }
    catch (error: any) {
      status.value = 'error'
      errorMessage.value = error.response?.data?.error || error.message || '登录状态检查失败'
      return { success: false }
    }
  }

  async function getFarmCode(wxidParam?: string): Promise<{ success: boolean, code?: string, wxid?: string, nickname?: string, avatar?: string }> {
    if (!taskId.value) return { success: false }
    isLoading.value = true
    status.value = 'code_loading'
    statusMessage.value = '正在获取QQ农场Code...'
    errorMessage.value = ''
    try {
      const result = await api.post(`/api/wx-login/tasks/${taskId.value}/code`)
      const data = result.data?.data || {}
      const code = String(data.code || '').trim()
      if (!code) throw new Error('未获取到登录 Code')
      wxid.value = String(data.wxid || data.openid || wxidParam || wxid.value)
      nickname.value = nickname.value || wxid.value || '微信用户'
      taskId.value = ''
      status.value = 'success'
      statusMessage.value = '已获取QQ农场Code'
      return { success: true, code, wxid: wxid.value, nickname: nickname.value, avatar: avatar.value }
    }
    catch (error: any) {
      status.value = 'error'
      errorMessage.value = error.response?.data?.error || error.message || '获取Code失败'
      return { success: false }
    }
    finally {
      isLoading.value = false
    }
  }

  loadConfig()

  return { config, isLoading, qrCode, qrCreatedAt, uuid, wxid, taskId, nickname, avatar, status, statusMessage, errorMessage, qrEndpoint, currentUserId, useProxyMode: computed(() => false), resetState, getQRCode, checkLogin, getFarmCode, loadConfigFromServer: loadConfig }
})

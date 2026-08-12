<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { useWxLoginStore } from '@/stores/wx-login'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const CODE_QUERY_RE = /[?&]code=([^&]+)/i
const QR_AUTO_REFRESH_MS = 110_000
const CAPTURE_SUCCESS_STORAGE_KEY = 'capture_login_succeeded'
// 农场 VPN 代理安装包放在 web/public 下，Vite 会以根路径直接提供下载。
const FARM_VPN_APK_URL = '/农场VPN.apk'

// 抓包任务按“客户端”隔离：同一后台登录在不同设备/标签页各持一个稳定 clientId，
// 这样彼此不会互相顶掉，只清理自己遗留的任务；多端并发时在 capture 层自动排队。
const CAPTURE_CLIENT_ID_KEY = 'capture_client_id'
function resolveCaptureClientId(): string {
  try {
    let id = localStorage.getItem(CAPTURE_CLIENT_ID_KEY)
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(CAPTURE_CLIENT_ID_KEY, id)
    }
    return id
  }
  catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}
const captureClientId = resolveCaptureClientId()
const captureClientHeaders = { 'x-capture-client-id': captureClientId }

const wxLoginStore = useWxLoginStore()

interface CaptureFlowState {
  id: string
  platform: 'qq'
  codeCaptured: boolean
  accountGid: string
  friendCount: number
  captureStatus: string
  queue: {
    queued: boolean
    position: number
    queueLength: number
    maxHoldSec: number
    maxHoldRemainingSec: number
  }
  proxy: {
    running: boolean
    status: string
    error: string
  }
  publicInfo: {
    remainingSec: number
  }
}

const activeTab = ref<'wx' | 'capture' | 'manual'>('manual')
const loading = ref(false)
const wxChecking = ref(false)
const errorMessage = ref('')
const wxAccountName = ref('')
const captureEnabled = ref(false)
const captureLoading = ref(false)
const captureChecking = ref(false)
const captureCompleting = ref(false)
const captureError = ref('')
const captureAccountName = ref('')
const showCaptureHelp = ref(false)
const captureHelpMode = ref<'first' | 'daily'>('first')
const captureFlow = ref<CaptureFlowState | null>(null)

const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

const captureHelpSteps = computed(() => captureHelpMode.value === 'first'
  ? [
      '下载并安装「农场VPN.apk」（Android 代理应用）',
      '点击开始抓取，创建本次抓取任务',
      '打开安装好的农场代理，启动代理开关',
      '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
      '打开 QQ 农场，等待抓取完成',
      'Code 获取后账号会立即添加，随后自动释放代理',
    ]
  : [
      '点击开始抓取，创建本次抓取任务',
      '打开农场代理，启动代理开关',
      '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
      '打开 QQ 农场，等待抓取完成',
      'Code 获取后账号会立即添加，随后自动释放代理',
      '账号添加后，在农场代理中关闭代理开关',
    ])

const captureQueued = computed(() => captureFlow.value?.queue?.queued === true)
const captureQueuePosition = computed(() => captureFlow.value?.queue?.position || 0)
const captureAheadCount = computed(() => Math.max(0, captureQueuePosition.value - 1))
// 剩余时间：持有端口时显示“最长占用倒计时”（到时会被强制释放切给下一位）；
// capture 未配置占用上限时回退到自动停止倒计时。
const captureRemainingSec = computed(() => {
  const hold = captureFlow.value?.queue?.maxHoldRemainingSec || 0
  if (hold > 0)
    return hold
  return captureFlow.value?.publicInfo?.remainingSec || 0
})

const captureCurrentStep = computed(() => {
  if (!captureFlow.value)
    return '开始新的抓取任务'
  if (captureQueued.value)
    return captureAheadCount.value > 0 ? `排队中，前面还有 ${captureAheadCount.value} 人` : '排队中，即将轮到你'
  if (!captureFlow.value.codeCaptured)
    return '启动农场代理并打开 QQ 农场'
  return '已获取 Code，正在立即完成账号操作'
})

const captureNextStep = computed(() => {
  if (!captureFlow.value)
    return '开始后打开农场代理并启动代理开关'
  if (captureQueued.value)
    return '等待端口释放，轮到你会自动开始，请勿关闭本窗口'
  if (!captureFlow.value.codeCaptured)
    return '打开 QQ 农场，并保持农场页面打开'
  return `即将自动${props.editData ? '更新' : '添加'}账号`
})

const { pause: stopWxCheck, resume: startWxCheck } = useIntervalFn(async () => {
  if (activeTab.value !== 'wx' || wxLoginStore.isLoading || wxChecking.value)
    return
  if (shouldRefreshWxQr()) {
    await loadWxQRCode()
    return
  }
  if (wxLoginStore.status !== 'qr_ready' && wxLoginStore.status !== 'confirming')
    return

  wxChecking.value = true
  try {
    const result = await wxLoginStore.checkLogin()
    if (result.success && result.wxid) {
      stopWxCheck()
      const codeResult = await wxLoginStore.getFarmCode(result.wxid)
      if (codeResult.success && codeResult.code) {
        const name = wxAccountName.value.trim() || result.nickname || `微信账号${Date.now()}`
        if (wxLoginStore.config.autoAddAccount) {
          await addAccount({
            id: props.editData?.id,
            name: props.editData ? (props.editData.name || name) : name,
            code: codeResult.code,
            platform: 'wx',
            loginType: 'wx_qr',
            wxid: result.wxid,
            avatar: result.avatar,
          })
        }
        else {
          form.code = codeResult.code
          form.platform = 'wx'
          activeTab.value = 'manual'
        }
      }
    }
  }
  finally {
    wxChecking.value = false
  }
}, 2000, { immediate: false })

const { pause: stopCaptureCheck, resume: startCaptureCheck } = useIntervalFn(async () => {
  if (activeTab.value !== 'capture' || !captureFlow.value || captureCompleting.value || captureChecking.value)
    return
  // 记录本轮轮询针对的会话 id：请求飞行途中若用户点了“取消抓取”，
  // captureFlow 会被清空/替换，回来后不能再把旧数据写回，否则界面会“复活”回抓取态。
  const polledFlowId = captureFlow.value.id
  captureChecking.value = true
  try {
    const { data } = await api.get(`/api/capture/sessions/${polledFlowId}`, { timeout: 20000, headers: captureClientHeaders })
    // 会话已被取消（置空）或已切换到另一个会话：丢弃这次过期的响应。
    if (!captureFlow.value || captureFlow.value.id !== polledFlowId)
      return
    if (!data?.ok || !data.data)
      return
    captureFlow.value = data.data
    captureError.value = data.data.proxy?.error || ''
    if (data.data.codeCaptured)
      await completeCaptureAccount()
  }
  catch (e: any) {
    // 同样：取消后到达的错误不应再显示，避免“已取消却仍报错/停留”。
    if (captureFlow.value && captureFlow.value.id === polledFlowId)
      captureError.value = e.response?.data?.error || e.message || '查询抓取状态失败'
  }
  finally {
    captureChecking.value = false
  }
}, 1500, { immediate: false })

async function loadCaptureConfig() {
  try {
    const { data } = await api.get('/api/capture/config')
    captureEnabled.value = data?.ok && data.data?.enabled === true
  }
  catch {
    captureEnabled.value = false
  }
}

async function cancelCaptureSession() {
  stopCaptureCheck()
  const flowId = captureFlow.value?.id
  // 立即回到初始态：清空会话与错误提示，避免取消后界面仍停留在抓取/报错状态。
  captureFlow.value = null
  captureError.value = ''
  if (flowId) {
    try {
      await api.delete(`/api/capture/sessions/${flowId}`, { headers: captureClientHeaders })
    }
    catch {}
  }
}

async function startCaptureSession() {
  captureLoading.value = true
  captureError.value = ''
  await cancelCaptureSession()
  try {
    const { data } = await api.post('/api/capture/sessions', {
      platform: 'qq',
      accountId: props.editData?.id || '',
    }, { timeout: 35000, headers: captureClientHeaders })
    if (!data?.ok || !data.data)
      throw new Error(data?.error || '启动抓取失败')
    captureFlow.value = data.data
    startCaptureCheck()
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '启动抓取失败'
  }
  finally {
    captureLoading.value = false
  }
}

async function completeCaptureAccount() {
  if (!captureFlow.value || captureCompleting.value)
    return
  captureCompleting.value = true
  captureError.value = ''
  try {
    const { data } = await api.post(`/api/capture/sessions/${captureFlow.value.id}/complete`, {
      name: captureAccountName.value.trim(),
    }, { timeout: 35000, headers: captureClientHeaders })
    if (!data?.ok)
      throw new Error(data?.error || (props.editData ? '更新账号失败' : '添加账号失败'))
    localStorage.setItem(CAPTURE_SUCCESS_STORAGE_KEY, '1')
    stopCaptureCheck()
    captureFlow.value = null
    emit('saved')
    close()
  }
  catch (e: any) {
    if (e.response?.data?.code === 'DUPLICATE_CAPTURE_ACCOUNT') {
      stopCaptureCheck()
      captureFlow.value = null
    }
    captureError.value = e.response?.data?.error || e.message || (props.editData ? '更新账号失败' : '添加账号失败')
  }
  finally {
    captureCompleting.value = false
  }
}

function openCaptureHelp() {
  captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
  showCaptureHelp.value = true
}

function shouldRefreshWxQr() {
  return !!wxLoginStore.qrCreatedAt
    && (wxLoginStore.status === 'qr_ready' || wxLoginStore.status === 'confirming')
    && Date.now() - wxLoginStore.qrCreatedAt > QR_AUTO_REFRESH_MS
}

async function loadWxQRCode() {
  if (activeTab.value !== 'wx')
    return
  stopWxCheck()
  wxLoginStore.resetState()
  const success = await wxLoginStore.getQRCode()
  if (success)
    startWxCheck()
}

async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入 Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(CODE_QUERY_RE)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

// 后端返回的是二维码 JPEG 二进制，store 通过 URL.createObjectURL 生成 blob: 链接，
// 可直接作为 <img src> 使用；此处仅做透传，避免误判为 base64。
const wxQrImageSrc = computed(() => wxLoginStore.qrCode || '')

function close() {
  stopWxCheck()
  stopCaptureCheck()
  void cancelCaptureSession()
  wxLoginStore.resetState()
  showCaptureHelp.value = false
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    captureError.value = ''
    captureAccountName.value = props.editData?.name || ''
    captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
    void loadCaptureConfig()
    void wxLoginStore.loadConfigFromServer()
    if (props.editData) {
      activeTab.value = 'manual'
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
      wxAccountName.value = props.editData.name || ''
    }
    else {
      activeTab.value = 'manual'
      form.name = ''
      form.code = ''
      form.platform = 'qq'
      wxAccountName.value = ''
    }
  }
  else {
    stopWxCheck()
    stopCaptureCheck()
    void cancelCaptureSession()
    wxLoginStore.resetState()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'wx')
    loadWxQRCode()
  if (tab !== 'capture')
    void cancelCaptureSession()
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-lg shadow-xl" :style="{ background: 'var(--theme-bg)' }">
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <div class="mb-4 flex border-b" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            手动填码
          </button>
          <button
            v-if="wxLoginStore.config.enabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'wx' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'wx' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'wx'"
          >
            微信扫码
          </button>
          <button
            v-if="captureEnabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'capture' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'capture' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'capture'"
          >
            QQ抓包登录
          </button>
        </div>

        <div v-if="activeTab === 'wx'" class="space-y-4">
          <BaseInput
            v-model="wxAccountName"
            label="账号备注（可选）"
            placeholder="留空则使用微信昵称"
          />

          <div class="flex flex-col items-center justify-center py-4 space-y-4">
            <div
              v-if="wxQrImageSrc"
              class="border rounded-lg p-2"
              :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 20%, transparent)', background: '#fff' }"
            >
              <img :src="wxQrImageSrc" class="h-48 w-48">
            </div>
            <div
              v-else
              class="h-48 w-48 flex items-center justify-center rounded-lg"
              :style="{ background: 'color-mix(in srgb, var(--theme-bg) 90%, var(--theme-text))' }"
            >
              <div v-if="wxLoginStore.isLoading" i-svg-spinners-90-ring-with-bg class="text-3xl" :style="{ color: 'var(--theme-primary)' }" />
              <span v-else class="text-sm" :style="{ color: 'var(--theme-text)' }">点击获取二维码</span>
            </div>

            <p class="text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxLoginStore.statusMessage }}
            </p>

            <p v-if="wxLoginStore.errorMessage" class="text-center text-sm text-red-600">
              {{ wxLoginStore.errorMessage }}
            </p>

            <BaseButton variant="secondary" size="sm" :loading="wxLoginStore.isLoading" @click="loadWxQRCode">
              刷新二维码
            </BaseButton>
          </div>

          <div class="text-center text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            使用微信扫描二维码登录，成功后会自动添加账号
          </div>
        </div>

        <div v-if="activeTab === 'capture'" class="space-y-4">
          <BaseInput
            v-model="captureAccountName"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
            :disabled="!!captureFlow"
          />

          <a
            v-if="!captureFlow"
            :href="FARM_VPN_APK_URL"
            download
            class="h-11 w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 text-left text-sm dark:border-gray-700"
            :style="{ color: 'var(--theme-text)' }"
          >
            <span class="flex items-center gap-2">
              <span class="i-carbon-download" :style="{ color: 'var(--theme-primary)' }" />
              下载农场VPN.apk
            </span>
            <span class="i-carbon-chevron-right opacity-60" />
          </a>

          <button
            v-if="!captureFlow"
            type="button"
            class="h-11 w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 text-left text-sm dark:border-gray-700"
            :style="{ color: 'var(--theme-text)' }"
            @click="openCaptureHelp"
          >
            <span class="flex items-center gap-2">
              <span class="i-carbon-help" :style="{ color: 'var(--theme-primary)' }" />
              使用说明
            </span>
            <span class="i-carbon-chevron-right opacity-60" />
          </button>

          <div v-if="captureError" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
            {{ captureError }}
          </div>

          <div v-if="!captureFlow" class="flex flex-col items-center gap-3 py-4">
            <div class="h-16 w-16 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <div class="i-carbon-data-connected text-3xl" :style="{ color: 'var(--theme-primary)' }" />
            </div>
            <BaseButton variant="primary" :loading="captureLoading" @click="startCaptureSession">
              开始抓取
            </BaseButton>
          </div>

          <template v-else>
            <div
              v-if="captureQueued"
              class="flex items-center gap-3 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
            >
              <span class="i-carbon-time flex-none text-lg" />
              <div class="min-w-0">
                <div class="font-semibold">
                  {{ captureAheadCount > 0 ? `排队中，前面还有 ${captureAheadCount} 人` : '排队中，即将轮到你' }}
                </div>
                <div class="mt-0.5 text-xs opacity-80">
                  正在等待端口释放，轮到你会自动开始，请勿关闭本窗口。
                </div>
              </div>
            </div>

            <div class="rounded-lg px-3 py-3 text-sm" style="background-color: color-mix(in srgb, var(--theme-primary) 10%, transparent); color: var(--theme-text);">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-xs opacity-60">
                    当前步骤
                  </div>
                  <div class="mt-1 break-words font-semibold">
                    {{ captureCurrentStep }}
                  </div>
                  <div class="mt-1 break-words text-xs opacity-70">
                    下一步：{{ captureNextStep }}
                  </div>
                </div>
                <button
                  type="button"
                  class="h-8 w-8 flex flex-none items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
                  title="使用说明"
                  @click="openCaptureHelp"
                >
                  <span class="i-carbon-help text-lg" />
                </button>
              </div>
            </div>

            <div class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800">
              <div v-if="captureQueued" class="flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">排队人数</span>
                <span :style="{ color: 'var(--theme-primary)' }">{{ captureFlow.queue.queueLength }} 人（第 {{ captureQueuePosition }} 位）</span>
              </div>
              <template v-else>
                <div class="flex items-center justify-between gap-3">
                  <span :style="{ color: 'var(--theme-text)' }">Code</span>
                  <span :class="captureFlow.codeCaptured ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
                    {{ captureFlow.codeCaptured ? '已获取' : '等待中' }}
                  </span>
                </div>
                <div class="mt-2 flex items-center justify-between gap-3">
                  <span :style="{ color: 'var(--theme-text)' }">剩余时间</span>
                  <span :style="{ color: 'var(--theme-text)' }">{{ captureRemainingSec }} 秒</span>
                </div>
              </template>
            </div>

            <div class="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-t border-gray-200 px-4 py-3 -mx-4 dark:border-gray-700" :style="{ background: 'var(--theme-bg)' }">
              <BaseButton variant="outline" size="sm" @click="cancelCaptureSession">
                取消抓取
              </BaseButton>
              <BaseButton
                v-if="captureFlow.codeCaptured"
                variant="primary"
                size="sm"
                :loading="captureCompleting"
                @click="completeCaptureAccount"
              >
                {{ editData ? '立即更新' : '立即添加' }}
              </BaseButton>
            </div>
          </template>
        </div>

        <div v-if="activeTab === 'manual'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
          />

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ 小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="showCaptureHelp"
      class="fixed inset-0 z-[10001] flex items-end justify-center bg-black/50 md:items-center"
      @click.self="showCaptureHelp = false"
    >
      <div class="max-h-[78vh] max-w-md w-full flex flex-col overflow-hidden rounded-t-lg shadow-2xl md:rounded-lg" :style="{ background: 'var(--theme-bg)' }">
        <div class="h-14 flex flex-none items-center justify-between border-b border-gray-200 px-4 dark:border-gray-700">
          <h4 class="text-base font-semibold" :style="{ color: 'var(--theme-text)' }">
            QQ抓包登录使用说明
          </h4>
          <BaseButton variant="ghost" class="!h-9 !w-9 !p-0" title="关闭使用说明" @click="showCaptureHelp = false">
            <span class="i-carbon-close text-lg" />
          </BaseButton>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm transition-colors"
              :class="captureHelpMode === 'first' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
              :style="captureHelpMode === 'first' ? { background: 'var(--theme-gradient)' } : {}"
              @click="captureHelpMode = 'first'"
            >
              首次使用
            </button>
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm transition-colors"
              :class="captureHelpMode === 'daily' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
              :style="captureHelpMode === 'daily' ? { background: 'var(--theme-gradient)' } : {}"
              @click="captureHelpMode = 'daily'"
            >
              已装代理
            </button>
          </div>

          <div class="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
            <div v-for="(step, index) in captureHelpSteps" :key="step" class="flex items-start gap-3 py-3 first:pt-0">
              <span class="h-6 w-6 flex flex-none items-center justify-center rounded-full text-xs text-white font-semibold" :style="{ background: 'var(--theme-primary)' }">
                {{ index + 1 }}
              </span>
              <span class="min-w-0 break-words text-sm leading-6" :style="{ color: 'var(--theme-text)' }">
                {{ step }}
              </span>
            </div>
          </div>

          <div class="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-xs text-amber-800 leading-5 dark:bg-amber-900/20 dark:text-amber-200">
            <div>农场代理需要保持开启，直到账号添加完成。</div>
            <div class="mt-1">
              服务端会自动释放代理，但账号完成后仍需在农场代理中手动关闭代理开关。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

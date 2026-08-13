<script setup lang="ts">
import type { ActivityLabels, ActivitySection, ActivitySectionKey } from '@/components/activity/types'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import HeluExchangePanel from '@/components/activity/HeluExchangePanel.vue'
import HeluPassportPanel from '@/components/activity/HeluPassportPanel.vue'
import HeluSolarTermsPanel from '@/components/activity/HeluSolarTermsPanel.vue'
import StarRecordPanel from '@/components/activity/StarRecordPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { useToastStore } from '@/stores/toast'

const L: ActivityLabels = {
  title: '活动中心',
  currentAccount: '当前账号',
  none: '未选择',
  needAccount: '请先选择账号，再查看活动数据。',
  refresh: '刷新',
  loading: '正在加载活动数据...',
  empty: '暂无数据',
  warningTitle: '活动提示',
  heluTitle: '心许千灯星垂野',
  giftLotusTab: '观星礼录',
  shopTab: '星砂兑换商店',
  journeyTab: '千星游记',
  notesTab: '节令小札',
  qingmeiTab: '青酿换万金',
  pool: '奖池',
  recent: '最近结果',
  freeRemain: '免费剩余',
  paidRemain: '点券剩余',
  dailyUsed: '今日已用',
  dailyRemain: '今日剩余',
  helu: '星砂',
  heluBalance: '星砂余额',
  exchangeGoods: '兑换奖励',
  drawOne: '点亮',
  drawBatch: '一键点亮',
  drawDone: '点亮完成',
  batchDone: '点亮完成',
  drawFail: '点亮失败',
  exchangeDone: '兑换成功：',
  exchangeFail: '兑换失败',
  canExchange: '立即兑换',
  unavailable: '暂不可用',
  owned: '已拥有',
  noHelu: '星砂不足',
  unsupportedCurrency: '暂不支持该货币',
  priceLabel: '价格',
  stateLabel: '状态',
  drawCostLabel: '操作说明',
  freeDraw: '免费',
  paidDraw: '消耗',
  recentCost: '本次消耗',
  rewardPoolCount: '星宿奖励',
  exchangeCount: '兑换奖励',
  typeFallback: '活动奖励',
  gold: '金币',
  coupon: '点券',
  activityCurrency: '星砂',
  defaultHeluTitle: '心许千灯星垂野',
  decorationLabel: '装扮',
  subActivityUnavailable: '暂未读取到活动数据。',
  activityStatus: '活动状态',
}

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const {
  heluActivity: activity,
  heluLoading,
  passportClaimLoading,
  solarClaimLoading,
  starRecordClaimLoading,
  exchangeLoading,
  heluError,
  qingmeiClaimLoading,
  qingmeiStartLoading,
  qingmeiContinueLoading,
  qingmeiAutoBrewLoading,
  qingmeiSettleLoading,
} = storeToRefs(activityStore)

// 青酿分步 UI 状态
const qingmeiIngredientSelected = ref(false)
const qingmeiCount = ref(1)
const qingmeiMaxCount = computed(() => Math.max(0, Number(activity.value?.qingmei?.balance || 0)))
const qingmeiBusy = computed(() =>
  qingmeiClaimLoading.value || qingmeiStartLoading.value || qingmeiContinueLoading.value || qingmeiAutoBrewLoading.value || qingmeiSettleLoading.value,
)
const qingmeiQuotes = computed(() => {
  const qm = activity.value?.qingmei
  const totals = qm?.quoteTotals || []
  const prices = qm?.quotePrices || []
  return totals.map((total, index) => ({
    index: index + 1,
    unitPrice: String(prices[index] || '0'),
    total: String(total),
  }))
})

// 倍数格式化：服务端用 ×10000 表示倍数（10000=1倍，15000=1.5倍）
function formatMultiplier(value: unknown): string {
  const n = Number(value) || 0
  const rounded = Math.round((n / 10000) * 100) / 100
  return `${rounded}倍`
}

// 金币格式化：过万时显示为 "X.XX万"，否则用千分位
function formatGold(value: unknown): string {
  const n = Number(value) || 0
  if (n >= 10000) {
    const wan = n / 10000
    const rounded = Math.round(wan * 100) / 100
    return `${rounded}万`
  }
  return n.toLocaleString()
}

function setQingmeiCount(value: unknown) {
  const v = Math.max(1, Math.min(Math.trunc(Number(value) || 1), qingmeiMaxCount.value || 1))
  qingmeiCount.value = v
}

watch(qingmeiMaxCount, (value) => {
  qingmeiCount.value = Math.max(1, Math.min(qingmeiCount.value, value || 1))
  if (value <= 0) qingmeiIngredientSelected.value = false
})

const activeSection = ref<ActivitySectionKey>('journey')
const sections = computed<ActivitySection[]>(() => [
  { key: 'journey', label: '千星游记', icon: 'i-carbon-map', count: activity.value?.passport?.claimableLevels || 0 },
  { key: 'records', label: '观星礼录', icon: 'i-carbon-star', count: activity.value?.starRecord?.claimableCount || 0 },
  { key: 'shop', label: '星砂兑换商店', icon: 'i-carbon-store', count: activity.value?.exchangeShop?.length || 0 },
  { key: 'notes', label: '节令小札', icon: 'i-carbon-notebook', count: activity.value?.solarTerms?.claimableCount || 0 },
  { key: 'qingmei', label: L.qingmeiTab, icon: 'i-carbon-sprout', count: activity.value?.qingmei?.claimable ? 1 : 0 },
])

async function refreshAll() {
  if (currentAccountId.value) {
    await activityStore.fetchHeluActivity(currentAccountId.value)
  }
}

async function claimRecords() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimStarRecords(currentAccountId.value)
  if (result?.ok) {
    const count = result.recordIds?.length || 0
    toast.success(count ? `已点亮并领取 ${count} 个星宿奖励` : '观星礼录领取完成')
  }
  else {
    toast.error(result?.error || '观星礼录领取失败')
  }
}

async function claimPassport() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimHeluPassport(currentAccountId.value)
  result?.ok ? toast.success('千星游记奖励领取完成') : toast.error(result?.error || '千星游记领取失败')
}

async function claimSolar(term: { id: number, title?: string }) {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimHeluSolar(currentAccountId.value, term.id)
  result?.ok
    ? toast.success(`节令小札领取完成：${term.title || term.id}`)
    : toast.error(result?.error || '节令小札领取失败')
}

async function exchangeStarSand(item: { id: number, itemName?: string, name?: string }, count: number) {
  if (!currentAccountId.value)
    return
  const result = await activityStore.exchangeStarSand(currentAccountId.value, item.id, count)
  result?.ok
    ? toast.success(`${L.exchangeDone}${item.itemName || item.name || item.id} ×${count}`)
    : toast.error(result?.error || L.exchangeFail)
}

async function claimQingmei() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimQingmeiSeeds(currentAccountId.value)
  if (result?.ok) {
    if (result.message) {
      if (result.alreadyClaimed) toast.info(result.message); else toast.success(result.message)
    } else if (result.alreadyClaimed) {
      toast.info('今日青梅种子已领取过')
    } else {
      toast.success(`青梅种子领取成功，获得 ${result.claimedCount || 0} 个`)
    }
  }
  else {
    toast.error(result?.error || '青梅种子领取失败')
  }
}

async function startQingmei() {
  if (!currentAccountId.value || !qingmeiIngredientSelected.value) return
  const result = await activityStore.startQingmeiBrew(currentAccountId.value, qingmeiCount.value)
  if (result?.ok)
    toast.success(result?.message || `青梅酿已启动，已投入 ${result.count || qingmeiCount.value} 颗青梅`)
  else
    toast.error(result?.error || '青梅酿启动失败')
}

async function autoBrewQingmei() {
  if (!currentAccountId.value) return
  const result = await activityStore.autoBrewQingmei(currentAccountId.value)
  if (result?.ok) {
    if (result.message) {
      if (result.completedRounds === 0)
        toast.info(result.message)
      else
        toast.success(result.message)
    }
    else {
      toast.success(`一键酿造完成：共 ${result.completedRounds || 0} 轮`)
    }
  }
  else {
    toast.error(result?.error || '一键酿造失败')
  }
}

async function settleQingmei() {
  if (!currentAccountId.value) return
  const result = await activityStore.settleQingmeiBrew(currentAccountId.value, true)
  if (result?.ok) {
    if (result.message) {
      toast.success(result.message)
    } else {
      const gold = result.gold || 0
      toast.success(`青酿出售成功${result.shared ? '（分享翻倍）' : ''}，获得 ${formatGold(gold)} 金币`)
    }
  }
  else {
    toast.error(result?.error || '青酿结算失败')
  }
}

// ===== Mock 模式：通过 URL ?mock=qingmei 激活，用于本地验证显示效果 =====
const isMockMode = ref(false)
const mockScenario = ref<'not-started' | 'in-progress' | 'completed'>('completed')

const mockScenarios: Record<string, any> = {
  'not-started': {
    qingmei: {
      name: '青酿换万金',
      title: '青梅酿万金',
      balance: '120',
      balanceKnown: true,
      basePrice: '10000',
      guaranteedPrice: '15000',
      currentRound: 0,
      maxRounds: 3,
      started: false,
      finished: false,
      quotePrices: [],
      quoteTotals: [],
      claimable: false,
      claimed: true,
      actions: {
        claimSeed: { enabled: false, available: false },
        start: { enabled: true, available: true },
        continue: { enabled: false, available: false },
        settle: { enabled: false, available: false },
      },
      rules: { title: '活动说明', paragraphs: ['投入青梅逐轮酿造，每轮获得不同倍率报价。', '完成3轮酿造后可分享出售获得1.5倍金币奖励。'] },
      material: { itemId: 29003, itemCount: 120, itemName: '青梅', image: '' },
      ingredient: { id: '29003', count: '120', name: '青梅', image: '', itemId: 29003, itemCount: 120, itemName: '青梅', rarity: 0 },
      dailySeed: { claimed: true, grantId: '1', reward: { itemId: 28003, itemCount: 5, itemName: '青梅种子', image: '' }, grant: { grantId: 1 } },
      reward: { itemId: 28003, itemCount: 5, itemName: '青梅种子', image: '' },
    },
  },
  'in-progress': {
    qingmei: {
      name: '青酿换万金',
      title: '青梅酿万金',
      balance: '80',
      balanceKnown: true,
      basePrice: '10000',
      guaranteedPrice: '15000',
      currentRound: 2,
      maxRounds: 3,
      started: true,
      finished: false,
      quotePrices: ['10000', '12000'],
      quoteTotals: ['50000', '61200'],
      claimable: false,
      claimed: true,
      actions: {
        claimSeed: { enabled: false, available: false },
        start: { enabled: false, available: false },
        continue: { enabled: true, available: true },
        settle: { enabled: false, available: false },
      },
      rules: { title: '活动说明', paragraphs: ['投入青梅逐轮酿造，每轮获得不同倍率报价。', '完成3轮酿造后可分享出售获得1.5倍金币奖励。'] },
      material: { itemId: 29003, itemCount: 80, itemName: '青梅', image: '' },
      ingredient: { id: '29003', count: '80', name: '青梅', image: '', itemId: 29003, itemCount: 80, itemName: '青梅', rarity: 0 },
      dailySeed: { claimed: true, grantId: '1', reward: { itemId: 28003, itemCount: 5, itemName: '青梅种子', image: '' }, grant: { grantId: 1 } },
      reward: { itemId: 28003, itemCount: 5, itemName: '青梅种子', image: '' },
    },
  },
  'completed': {
    qingmei: {
      name: '青酿换万金',
      title: '青梅酿万金',
      balance: '50',
      balanceKnown: true,
      basePrice: '10000',
      guaranteedPrice: '15000',
      currentRound: 3,
      maxRounds: 3,
      started: true,
      finished: false,
      quotePrices: ['10000', '12000', '15000'],
      quoteTotals: ['50000', '61200', '78300'],
      claimable: false,
      claimed: true,
      actions: {
        claimSeed: { enabled: false, available: false },
        start: { enabled: false, available: false },
        continue: { enabled: false, available: false },
        settle: { enabled: true, available: true },
      },
      rules: { title: '活动说明', paragraphs: ['投入青梅逐轮酿造，每轮获得不同倍率报价。', '完成3轮酿造后可分享出售获得1.5倍金币奖励。'] },
      material: { itemId: 29003, itemCount: 50, itemName: '青梅', image: '' },
      ingredient: { id: '29003', count: '50', name: '青梅', image: '', itemId: 29003, itemCount: 50, itemName: '青梅', rarity: 0 },
      dailySeed: { claimed: true, grantId: '1', reward: { itemId: 28003, itemCount: 5, itemName: '青梅种子', image: '' }, grant: { grantId: 1 } },
      reward: { itemId: 28003, itemCount: 5, itemName: '青梅种子', image: '' },
    },
  },
}

function loadMockScenario(scenario: 'not-started' | 'in-progress' | 'completed') {
  mockScenario.value = scenario
  const mock = mockScenarios[scenario]
  activity.value = {
    uid: 'SAIJI_MEGA_EVENT',
    title: '心许千灯星垂野',
    starSandBalance: 12500,
    qingmei: mock.qingmei,
  } as any
  activeSection.value = 'qingmei'
}

watch(currentAccountId, () => {
  if (isMockMode.value) return
  activityStore.clearActivityData()
  refreshAll()
})

onMounted(() => {
  const url = new URL(window.location.href)
  if (url.searchParams.get('mock') === 'qingmei') {
    isMockMode.value = true
    loadMockScenario('completed')
  }
  else {
    refreshAll()
  }
})
</script>

<template>
  <section class="space-y-4">
    <header class="relative min-h-40 overflow-hidden rounded-lg bg-[#071b43] shadow-sm">
      <img
        src="/activity/star-festival/star-sky.png"
        alt=""
        class="absolute inset-0 h-full w-full object-cover opacity-80"
      >
      <div class="absolute inset-0 bg-gradient-to-r from-[#061632]/95 via-[#0b2e61]/80 to-[#0b2e61]/25" />
      <img
        src="/activity/star-festival/star-farm.png"
        alt=""
        class="pointer-events-none absolute -bottom-32 right-0 hidden h-96 w-96 object-contain opacity-85 lg:block"
      >

      <div class="relative flex min-h-40 flex-col justify-between gap-4 p-4 xl:flex-row xl:items-center">
        <div class="min-w-0">
          <img
            src="/activity/star-festival/event-title.png"
            :alt="activity?.title || L.heluTitle"
            class="h-auto w-72 max-w-full object-contain object-left"
          >
          <div class="mt-1 text-xs text-sky-100/75">
            活动中心 · {{ L.currentAccount }} {{ currentAccount?.name || L.none }}
          </div>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-2 xl:max-w-[68%] xl:justify-end">
          <span class="inline-flex items-center rounded-lg border border-sky-200/20 bg-[#071b43]/70 px-3 py-1.5 text-xs text-sky-50 backdrop-blur-sm">
            <img src="/activity/star-festival/star-token.png" alt="" class="mr-1.5 h-5 w-7 object-contain">
            {{ L.heluBalance }} {{ Number(activity?.starSandBalance || 0).toLocaleString() }}
          </span>
          <div class="max-w-full overflow-x-auto">
            <div class="min-w-max inline-flex border border-sky-200/20 rounded-lg bg-[#071b43]/70 p-0.5 backdrop-blur-sm">
              <button
                v-for="section in sections"
                :key="section.key"
                class="rounded-md px-3 py-1.5 text-sm transition"
                :class="activeSection === section.key ? 'text-white' : 'text-sky-100/80 hover:text-white'"
                :style="activeSection === section.key ? { backgroundColor: 'var(--theme-primary)' } : {}"
                @click="activeSection = section.key"
              >
                {{ section.label }}
                <span v-if="section.count" class="ml-1 opacity-80">{{ section.count }}</span>
              </button>
            </div>
          </div>
          <BaseButton variant="primary" :loading="heluLoading" :disabled="!currentAccountId" @click="refreshAll">
            {{ L.refresh }}
          </BaseButton>
        </div>
      </div>
    </header>

    <div v-if="!currentAccountId && !isMockMode" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
      {{ L.needAccount }}
    </div>
    <template v-else>
      <div v-if="heluError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
        {{ heluError }}
      </div>
      <div v-if="activity?.warning" class="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
        {{ activity.warning }}
      </div>
      <div v-if="heluLoading && !activity" class="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:bg-sky-900/20 dark:text-sky-100">
        {{ L.loading }}
      </div>

      <StarRecordPanel
        v-if="activeSection === 'records'"
        :record="activity?.starRecord"
        :loading="starRecordClaimLoading"
        @claim="claimRecords"
      />
      <div v-else-if="activeSection === 'shop'" class="space-y-3">
        <div v-if="activity?.shopWarning" class="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
          {{ activity.shopWarning }}
        </div>
        <HeluExchangePanel
          :items="activity?.exchangeShop || []"
          :balance="activity?.starSandBalance || 0"
          :exchange-loading="exchangeLoading"
          :read-only="activity?.shopReadOnly"
          :labels="L"
          @exchange="exchangeStarSand"
        />
      </div>
      <HeluPassportPanel
        v-else-if="activeSection === 'journey'"
        :passport="activity?.passport"
        :loading="passportClaimLoading"
        :labels="L"
        @claim="claimPassport"
      />
      <HeluSolarTermsPanel
        v-else-if="activeSection === 'notes'"
        :solar-terms="activity?.solarTerms"
        :loading="solarClaimLoading"
        :labels="L"
        @claim="claimSolar"
      />
      <div v-else-if="activeSection === 'qingmei'" class="qingmei-page">
        <!-- Mock 模式场景切换栏 -->
        <div v-if="isMockMode" class="mock-switcher">
          <span>MOCK 模式</span>
          <button
            v-for="s in (['not-started', 'in-progress', 'completed'] as const)"
            :key="s"
            :class="{ active: mockScenario === s }"
            @click="loadMockScenario(s)"
          >
            {{ s === 'not-started' ? '未开始' : s === 'in-progress' ? '进行中(2轮)' : '已完成(3轮)' }}
          </button>
        </div>

        <template v-if="activity?.qingmei">
          <header class="qingmei-hero">
            <span class="qingmei-kicker">限时酿造</span>
            <h1>{{ activity.qingmei?.name || activity.qingmei?.title || '青酿换万金' }}</h1>
            <p>投入青梅，逐轮查看报价，在合适的时机出售。</p>
          </header>

          <section v-if="activity.qingmei?.warning" class="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            {{ activity.qingmei.warning }}
          </section>

          <section class="qingmei-panel balance-panel">
            <div class="ingredient">
              <img v-if="activity.qingmei.ingredient?.image || activity.qingmei.material?.image" :src="activity.qingmei.ingredient?.image || activity.qingmei.material?.image" alt="青梅">
              <div>
                <span>可用青梅</span>
                <strong>{{ (activity.qingmei.balanceKnown ?? true) ? (activity.qingmei.balance ?? activity.qingmei.material?.itemCount ?? 0) : '--' }}</strong>
              </div>
            </div>
            <BaseButton
              type="button"
              class="seed-button"
              :disabled="qingmeiBusy || !(activity.qingmei.actions?.claimSeed?.enabled ?? !(activity.qingmei.dailySeed?.claimed || activity.qingmei.claimed))"
              :loading="qingmeiClaimLoading"
              @click="claimQingmei"
            >
              {{ (activity.qingmei.actions?.claimSeed?.enabled === false || activity.qingmei.dailySeed?.claimed || activity.qingmei.claimed) ? '今日已领取' : '领取今日青梅种子' }}
            </BaseButton>
          </section>

          <section class="qingmei-panel brew-panel">
            <div class="section-heading">
              <div>
                <span>本轮酿造</span>
                <strong>
                  {{ activity.qingmei.started
                    ? `第 ${activity.qingmei.currentRound || 0}/${activity.qingmei.maxRounds || 3} 轮`
                    : '尚未开始' }}
                </strong>
              </div>
              <span class="base-price">保底倍率 {{ formatMultiplier(activity.qingmei.guaranteedPrice || activity.qingmei.basePrice || 0) }}</span>
            </div>

            <!-- 未开始：选原料 + 数量 + 开始按钮 -->
            <div v-if="!activity.qingmei.started" class="brew-setup">
              <span class="setup-label">选择酿造原料</span>
              <button
                type="button"
                class="ingredient-choice"
                :class="{ selected: qingmeiIngredientSelected }"
                :disabled="qingmeiBusy || qingmeiMaxCount <= 0"
                :aria-pressed="qingmeiIngredientSelected"
                @click="qingmeiIngredientSelected = !qingmeiIngredientSelected"
              >
                <img v-if="activity.qingmei.ingredient?.image || activity.qingmei.material?.image" :src="activity.qingmei.ingredient?.image || activity.qingmei.material?.image" alt="">
                <span>
                  <strong>{{ activity.qingmei.ingredient?.itemName || activity.qingmei.material?.itemName || '青梅果实' }}</strong>
                  <small>背包拥有 x{{ (activity.qingmei.balanceKnown ?? true) ? (activity.qingmei.balance ?? activity.qingmei.material?.itemCount ?? 0) : '--' }}</small>
                </span>
                <div class="selection-mark"><div v-if="qingmeiIngredientSelected" class="i-carbon-checkmark" /></div>
              </button>
              <div class="start-controls">
                <label>
                  <span>投入数量</span>
                  <div class="count-control">
                    <button type="button" aria-label="减少数量" :disabled="qingmeiBusy || qingmeiCount <= 1" @click="setQingmeiCount(qingmeiCount - 1)"><div class="i-carbon-subtract" /></button>
                    <input :value="qingmeiCount" type="number" inputmode="numeric" min="1" :max="qingmeiMaxCount || 1" @input="setQingmeiCount(($event.target as HTMLInputElement).value)">
                    <button type="button" aria-label="增加数量" :disabled="qingmeiBusy || qingmeiCount >= qingmeiMaxCount" @click="setQingmeiCount(qingmeiCount + 1)"><div class="i-carbon-add" /></button>
                    <button type="button" class="maximum-button" :disabled="qingmeiBusy || qingmeiCount >= qingmeiMaxCount" @click="setQingmeiCount(qingmeiMaxCount)">全部</button>
                  </div>
                </label>
                <BaseButton
                  type="button"
                  :disabled="qingmeiBusy || !qingmeiIngredientSelected || !(activity.qingmei.actions?.start?.enabled) || qingmeiCount < 1 || qingmeiCount > qingmeiMaxCount"
                  :loading="qingmeiStartLoading"
                  @click="startQingmei"
                >
                  开始酿造
                </BaseButton>
              </div>
            </div>

            <!-- 已开始：报价网格 + 继续/出售按钮 -->
            <template v-else>
              <div class="quote-grid">
                <div
                  v-for="quote in qingmeiQuotes"
                  :key="quote.index"
                  class="quote"
                  :class="{ selected: quote.index === (activity.qingmei.currentRound || 0) }"
                >
                  <span>第 {{ quote.index }} 轮</span>
                  <strong>{{ formatGold(quote.total) }}</strong>
                  <small>倍率 {{ formatMultiplier(quote.unitPrice) }}</small>
                </div>
                <div
                  v-for="idx in Math.max(0, (activity.qingmei.maxRounds || 3) - qingmeiQuotes.length)"
                  :key="`pending-${idx}`"
                  class="quote pending"
                >
                  <span>第 {{ qingmeiQuotes.length + idx }} 轮</span>
                  <strong>待酿造</strong>
                </div>
              </div>
              <div class="brew-actions">
                <BaseButton
                  type="button"
                  class="continue-button"
                  :disabled="qingmeiBusy || !(activity.qingmei.actions?.continue?.enabled)"
                  :loading="qingmeiAutoBrewLoading"
                  @click="autoBrewQingmei"
                >
                  <span class="i-carbon-flash" />
                  一键酿造
                </BaseButton>
                <BaseButton
                  type="button"
                  class="sell-button"
                  :disabled="qingmeiBusy || !(activity.qingmei.actions?.settle?.enabled)"
                  :loading="qingmeiSettleLoading"
                  @click="settleQingmei"
                >
                  <span class="i-carbon-share" />
                  分享出售（1.5倍）
                </BaseButton>
              </div>
              <p v-if="qingmeiQuotes.length === 0" class="first-quote-hint">青梅已投入，点击一键酿造连续跑完 3 轮报价。</p>
            </template>
          </section>

          <section v-if="activity.qingmei.rules?.paragraphs?.length" class="qingmei-rules">
            <h2>{{ activity.qingmei.rules.title || '活动说明' }}</h2>
            <p v-for="(line, idx) in activity.qingmei.rules.paragraphs" :key="idx">{{ line }}</p>
          </section>
        </template>

        <div v-else-if="!heluLoading" class="qingmei-empty">当前账号暂未发现青酿活动</div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.qingmei-page{min-height:0;padding:16px 14px 20px;color:#193b2f;background:linear-gradient(180deg,#cbead2 0,#eef5dc 36%,#f7edcb 100%);border-radius:8px}
.mock-switcher{display:flex;align-items:center;gap:6px;margin-bottom:10px;padding:8px 10px;border-radius:6px;background:#fff3cd;border:1px solid #ffc107;color:#856404;font-size:12px}
.mock-switcher span{font-weight:700;margin-right:4px}
.mock-switcher button{padding:4px 10px;border:1px solid #ffc107;border-radius:4px;background:#fff;color:#856404;cursor:pointer;font-size:11px}
.mock-switcher button.active{background:#ffc107;color:#fff;border-color:#ffc107}
.mock-switcher button:hover:not(.active){background:#fff8e1}
:global(.dark) .qingmei-page{color:#d0e4d6;background:linear-gradient(180deg,#0f2a20 0,#1a2a23 36%,#2a2616 100%)}
.qingmei-hero{padding:0 5px 12px}.qingmei-kicker{display:block;color:#9b5d26;font-size:11px;font-weight:700}
:global(.dark) .qingmei-kicker{color:#e0b07a}
.qingmei-hero h1{margin:2px 0 4px;color:#174d39;font-size:24px;line-height:1.1;letter-spacing:0}
:global(.dark) .qingmei-hero h1{color:#c6efd3}
.qingmei-hero p{margin:0;color:#557064;font-size:12px}
:global(.dark) .qingmei-hero p{color:#a3bbb0}
.qingmei-panel{margin:0 0 10px;padding:12px;border:1px solid rgba(34,91,62,.22);border-radius:8px;background:rgba(255,255,255,.86);box-shadow:0 4px 14px rgba(64,91,53,.1)}
:global(.dark) .qingmei-panel{border-color:rgba(120,200,160,.2);background:rgba(20,35,28,.85);box-shadow:0 4px 14px rgba(0,0,0,.3)}
.balance-panel{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ingredient{display:flex;align-items:center;gap:10px}.ingredient img{width:44px;height:44px;object-fit:contain}
.ingredient div,.section-heading div{display:flex;flex-direction:column}.ingredient span,.section-heading span{color:#718276;font-size:11px}
:global(.dark) .ingredient span,:global(.dark) .section-heading span{color:#9db2a6}
.ingredient strong{font-size:20px}
.seed-button,.start-controls :deep(.base-button__inner),.brew-actions :deep(.base-button__inner){min-height:38px}
.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}.section-heading strong{margin-top:2px;font-size:16px}
.base-price{padding:4px 7px;border-radius:4px;color:#795a28!important;background:#f8e8b9;font-size:11px}
:global(.dark) .base-price{color:#f1d79c!important;background:#5a4418}
.brew-setup{display:grid;gap:10px}
.setup-label{color:#64766b;font-size:11px}
:global(.dark) .setup-label{color:#a7bdb0}
.ingredient-choice{width:100%;display:grid;grid-template-columns:44px minmax(0,1fr) 24px;align-items:center;gap:10px;padding:10px;border:1px solid #b8c9ba;border-radius:7px;color:#315244;background:#f6f8f1;text-align:left;cursor:pointer}
:global(.dark) .ingredient-choice{border-color:#3c5a4a;color:#b9d6c4;background:#162820}
.ingredient-choice.selected{border-color:#397b4b;box-shadow:inset 0 0 0 1px #397b4b;background:#edf6e9}
:global(.dark) .ingredient-choice.selected{border-color:#5fa874;box-shadow:inset 0 0 0 1px #5fa874;background:#1b3a28}
.ingredient-choice:disabled{opacity:.55;cursor:not-allowed}
.ingredient-choice img{width:44px;height:44px;object-fit:contain}
.ingredient-choice>span{display:flex;min-width:0;flex-direction:column}
.ingredient-choice strong{overflow:hidden;font-size:14px;text-overflow:ellipsis;white-space:nowrap}
.ingredient-choice small{margin-top:2px;color:#708277;font-size:11px}
:global(.dark) .ingredient-choice small{color:#9bb2a5}
.selection-mark{width:22px;height:22px;display:grid;place-items:center;border:1px solid #91aa99;border-radius:4px;color:white;background:white}
:global(.dark) .selection-mark{border-color:#4c6b5a;background:#0e1f17}
.ingredient-choice.selected .selection-mark{border-color:#397b4b;background:#397b4b}
:global(.dark) .ingredient-choice.selected .selection-mark{border-color:#5fa874;background:#5fa874}
.start-controls{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
.start-controls label{display:flex;min-width:0;flex-direction:column;gap:4px;color:#64766b;font-size:11px}
:global(.dark) .start-controls label{color:#a7bdb0}
.count-control{display:grid;grid-template-columns:38px minmax(40px,1fr) 38px 44px;gap:5px}
.count-control button,.start-controls input{height:36px;border:1px solid #9eb5a7;border-radius:6px}
:global(.dark) .count-control button,:global(.dark) .start-controls input{border-color:#3c5a4a}
.count-control button{display:grid;place-items:center;padding:0;color:#315244;background:#edf3e9}
:global(.dark) .count-control button{color:#b9d6c4;background:#162820}
.count-control button:disabled{opacity:.45}
.count-control .maximum-button{font-size:11px;font-weight:700}
.start-controls input{width:100%;min-width:0;padding:0 6px;color:#173a2e;background:#fff;font-size:15px;text-align:center}
:global(.dark) .start-controls input{color:#cfead9;background:#0e1f17}
@media (max-width:420px){
  .start-controls{grid-template-columns:1fr}
  .start-controls .count-control{width:100%}
  .start-controls :deep(.base-button){width:100%}
}
.quote-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.quote{height:78px;display:flex;min-width:0;flex-direction:column;align-items:center;justify-content:center;border:1px solid #b7c8b8;border-radius:6px;color:#436052;background:#f5f8ef;cursor:pointer}
:global(.dark) .quote{border-color:#3c5a4a;color:#a8c4b3;background:#162820}
.quote.selected{border-color:#a46727;box-shadow:inset 0 0 0 1px #a46727;background:#fff2c9}
:global(.dark) .quote.selected{border-color:#caa059;background:#3d2f12}
.quote span,.quote small{font-size:10px}
.quote strong{max-width:100%;overflow:hidden;color:#7c4d1f;font-size:15px;text-overflow:ellipsis}
:global(.dark) .quote strong{color:#f2cf8e}
.quote.pending{opacity:.58;cursor:default}
.quote.pending strong{color:#728079;font-size:12px}
.brew-actions{display:grid;grid-template-columns:1fr 1.35fr;gap:8px;margin-top:10px}
.continue-button :deep(.base-button__inner){display:inline-flex;align-items:center;justify-content:center;gap:5px;background:#4d7c67!important}
.sell-button :deep(.base-button__inner){display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#a96624!important}
.first-quote-hint{margin:8px 0 0;color:#667b6f;font-size:11px;text-align:center}
.qingmei-rules{padding:8px 5px 4px;color:#546b5e;font-size:11px;line-height:1.55}
:global(.dark) .qingmei-rules{color:#9db2a6}
.qingmei-rules h2{margin:0 0 5px;color:#294e3c;font-size:13px}
:global(.dark) .qingmei-rules h2{color:#c6efd3}
.qingmei-rules p{margin:3px 0}
.qingmei-empty{padding:40px 20px;text-align:center;color:#5e7569}
@media (max-width:360px){
  .balance-panel{align-items:stretch;flex-direction:column}
  .seed-button{width:100%}
  .qingmei-hero h1{font-size:20px}
  .quote{height:70px}
}
</style>

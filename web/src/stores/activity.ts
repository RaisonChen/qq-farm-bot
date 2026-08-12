import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface ActivityExchangeShopItem {
  id: number
  sort: number
  status: number
  owned: boolean
  isRepeatable?: boolean
  exchangeLimit?: number
  ownedBlocksExchange?: boolean
  statusLabel: string
  name: string
  itemId: number
  itemCount: number
  itemName: string
  image?: string
  itemType: number
  itemTypeLabel: string
  isDecoration: boolean
  currencyId: number
  currencyName: string
  price: number
  desc: string
  extra: string
}

export interface HeluDrawReward {
  itemId: number
  itemCount: number
  count?: number
  itemName: string
  name?: string
  image?: string
}

export interface HeluDrawCost {
  itemId?: number
  itemName?: string
  itemCount?: number
  image?: string
}

export interface HeluDrawResult {
  rewards?: HeluDrawReward[]
  items?: HeluDrawReward[]
  cost?: HeluDrawCost | null
}

export interface HeluSeasonRewardTier {
  level: number
  freeRewards: HeluDrawReward[]
  premiumRewards: HeluDrawReward[]
}

export interface HeluSeasonPassport {
  uid?: string
  title: string
  seasonTitle?: string
  currentLevel: number
  score?: number
  currentProgress?: number
  nextLevelNeed?: number
  maxLevel?: number
  freeClaimedLevel?: number
  premiumClaimedLevel?: number
  claimableLevels: number
  rewardTierCount?: number
  levelRewardTiers?: HeluSeasonRewardTier[]
  rewards?: HeluDrawReward[]
  configText?: string
  startTime?: number
  endTime?: number
  nowTime?: number
  warning?: string
}

export interface HeluSolarTerm {
  id: number
  title: string
  status: number
  statusLabel: string
  claimable: boolean
  startTime: number
  endTime: number
  rewards: HeluDrawReward[]
}

export interface HeluSolarTerms {
  nowTime?: number
  terms: HeluSolarTerm[]
  claimableCount: number
  currentTerm?: HeluSolarTerm | null
  tipsText?: string
  warning?: string
}

export interface StarRecordItem {
  id: number
  title: string
  category: string
  explain: string
  graph: string
  featured: boolean
  unlocked: boolean
  claimed: boolean
  claimable: boolean
  rewards: HeluDrawReward[]
}

export interface StarActivityData {
  uid: string
  title: string
  activityId: number
  startTime?: number
  endTime?: number
  starRecord: {
    status: number
    openedDays: number
    records: StarRecordItem[]
    totalCount: number
    unlockedCount: number
    claimedCount: number
    claimableCount: number
  }
  exchangeShop: ActivityExchangeShopItem[]
  shopReadOnly: boolean
  shopWarning?: string
  starSandCurrencyId: number
  starSandBalance: number
  passport?: HeluSeasonPassport | null
  solarTerms?: HeluSolarTerms | null
  qingmei?: QingmeiActivity | null
  warning?: string
}

export type HeluSubActivityKey = 'giftLotus' | 'shop' | 'journey' | 'notes'

export interface QingmeiActivity {
  uid: string
  title: string
  name?: string
  activityId: number
  claimActivityId: number
  claimCommand: number
  wineActivityId?: number
  wineTitle?: string
  winePreviewCommand?: number
  wineBrewCommand?: number
  wineSellCommand?: number
  startTime?: number
  endTime?: number
  status?: number
  claimed: boolean
  claimable: boolean
  reward: HeluDrawReward
  material?: HeluDrawReward
  ingredient?: { itemId: number, itemName: string, image?: string }
  balance?: number
  balanceKnown?: boolean
  started?: boolean
  currentRound?: number
  maxRounds?: number
  basePrice?: number
  guaranteedPrice?: number
  quotePrices?: Array<number | string>
  quoteTotals?: Array<number | string>
  dailySeed?: { claimed: boolean, grant?: { grantId: number } }
  actions?: {
    claimSeed: { enabled: boolean, available?: boolean }
    start: { enabled: boolean, available?: boolean }
    continue: { enabled: boolean, available?: boolean }
    settle: { enabled: boolean, available?: boolean }
  }
  rules?: { title: string, paragraphs: string[] }
  warning?: string
}

export interface QingmeiBrewResult {
  wineType: number
  cost: number
  price: number
  canDouble: boolean
  round?: number
  unitPrice?: string
  totalGold?: string
  doubled?: boolean
}

export interface QingmeiSellResult {
  multiple: number
  gold: number
  item?: HeluDrawReward
  rewards?: HeluDrawReward[]
  shared?: boolean
}

export interface HeluSubActivity {
  key: HeluSubActivityKey
  id: number
  parentId: number
  title: string
  icon: string
  type: number
  sort: number
  status: number
  visible: boolean
  enabled: boolean
  startTime: number
  endTime: number
  payload?: Record<string, unknown> | null
  payloadSummary: Array<{ key: string, value: string }>
  hasDraw: boolean
  hasExchangeShop: boolean
  available: boolean
  source: string
}

export interface HeluActivityData {
  uid: string
  title: string
  activityId: number
  drawActivityId: number
  drawCommand: number
  draw: {
    freeMax: number
    freeUsed: number
    freeRemaining: number
    paidMax: number
    paidUsed: number
    paidRemaining: number
    paidPrice: number
    paidCurrencyId: number
    rewardPool: HeluDrawReward[]
    actions?: {
      one?: { count: number, available: boolean, cost: number, currencyId: number, type: string, label: string }
      batch?: { count: number, available: boolean, cost: number, currencyId: number, type: string, label: string }
    }
    dailyMax: number
    dailyUsed: number
    dailyRemaining: number
  }
  exchangeActivityId: number
  exchangeShop: ActivityExchangeShopItem[]
  subActivities: HeluSubActivity[]
  passport?: HeluSeasonPassport | null
  solarTerms?: HeluSolarTerms | null
  qingmei?: QingmeiActivity | null
  heluBalance: number
  lastDrawResult?: HeluDrawResult | null
  warning?: string
  summary: {
    rewardPoolCount: number
    exchangeShopCount: number
    activityCount: number
    subActivityCount?: number
    dailyUsed: number
    dailyRemaining: number
  }
  raw?: {
    activityCount?: number
    activityTitles?: string[]
    activityIds?: number[]
  }
}

export const useActivityStore = defineStore('activity', () => {
  const heluActivity = ref<StarActivityData | null>(null)

  const heluLoading = ref(false)
  const drawLoading = ref(false)
  const exchangeLoading = ref(false)
  const passportClaimLoading = ref(false)
  const solarClaimLoading = ref(false)
  const starRecordClaimLoading = ref(false)
  const qingmeiClaimLoading = ref(false)
  const qingmeiSellLoading = ref(false)
  const qingmeiStartLoading = ref(false)
  const qingmeiContinueLoading = ref(false)
  const qingmeiAutoBrewLoading = ref(false)
  const qingmeiSettleLoading = ref(false)

  const heluError = ref('')

  let heluRequestId = 0

  function clearActivityData() {
    heluActivity.value = null
    heluLoading.value = false
    drawLoading.value = false
    exchangeLoading.value = false
    passportClaimLoading.value = false
    solarClaimLoading.value = false
    starRecordClaimLoading.value = false
    qingmeiClaimLoading.value = false
    qingmeiSellLoading.value = false
    qingmeiStartLoading.value = false
    qingmeiContinueLoading.value = false
    qingmeiAutoBrewLoading.value = false
    qingmeiSettleLoading.value = false
    heluError.value = ''
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  async function fetchHeluActivity(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++heluRequestId
    heluLoading.value = true
    heluError.value = ''
    try {
      const { data } = await api.get('/api/activity/star', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== heluRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok)
        heluActivity.value = data.activity || null
      else
        heluError.value = data.error || '获取心许千灯星垂野失败'
    }
    catch (err: any) {
      if (requestId === heluRequestId && isCurrentAccount(requestedId))
        heluError.value = err.message || '获取心许千灯星垂野失败'
    }
    finally {
      if (requestId === heluRequestId)
        heluLoading.value = false
    }
  }

  async function claimStarRecords(accountId: string) {
    const requestedId = String(accountId)
    starRecordClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/records/claim', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      starRecordClaimLoading.value = false
    }
  }

  async function drawHelu(accountId: string, payload: { mode?: string, count?: number } = {}) {
    const requestedId = String(accountId)
    drawLoading.value = true
    try {
      const { data } = await api.post('/api/activity/helu/draw', payload, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      drawLoading.value = false
    }
  }

  async function exchangeHelu(accountId: string, slotId: number, count: number) {
    const requestedId = String(accountId)
    exchangeLoading.value = true
    try {
      const { data } = await api.post('/api/activity/helu/exchange', {
        slotId,
        count,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      exchangeLoading.value = false
    }
  }

  async function exchangeStarSand(accountId: string, slotId: number, count: number) {
    const requestedId = String(accountId)
    exchangeLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/exchange', {
        slotId,
        count,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      exchangeLoading.value = false
    }
  }

  async function claimHeluPassport(accountId: string) {
    const requestedId = String(accountId)
    passportClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/passport/claim', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      passportClaimLoading.value = false
    }
  }

  async function claimHeluSolar(accountId: string, termId?: number) {
    const requestedId = String(accountId)
    solarClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/solar/claim', {
        termId,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      solarClaimLoading.value = false
    }
  }

  async function claimQingmeiSeeds(accountId: string) {
    const requestedId = String(accountId)
    qingmeiClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/claim', {}, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (isCurrentAccount(requestedId) && data.ok) {
        const qingmei = data.qingmei || data.activity?.qingmei
        if (qingmei && heluActivity.value)
          heluActivity.value = { ...heluActivity.value, qingmei }
      }
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err?.message || '领取青梅种子失败' }
    }
    finally {
      qingmeiClaimLoading.value = false
    }
  }

  async function brewAndSellQingmeiWine(accountId: string) {
    const requestedId = String(accountId)
    qingmeiSellLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/wine/sell', {
        share: true,
      }, {
        headers: { 'x-account-id': accountId },
        timeout: 120000,
        skipErrorToast: true,
      } as any)
      if (isCurrentAccount(requestedId) && data.ok) {
        const qingmei = data.qingmei || data.activity?.qingmei
        if (qingmei && heluActivity.value)
          heluActivity.value = { ...heluActivity.value, qingmei }
      }
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err?.message || '青酿出售失败' }
    }
    finally {
      qingmeiSellLoading.value = false
    }
  }

  async function startQingmeiBrew(accountId: string, count = 1) {
    const requestedId = String(accountId)
    qingmeiStartLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/wine/start', { count }, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (isCurrentAccount(requestedId) && data.ok) {
        const qingmei = data.qingmei
        if (qingmei && heluActivity.value)
          heluActivity.value = { ...heluActivity.value, qingmei }
      }
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err?.message || '青梅酿启动失败' }
    }
    finally {
      qingmeiStartLoading.value = false
    }
  }

  async function continueQingmeiBrew(accountId: string) {
    const requestedId = String(accountId)
    qingmeiContinueLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/wine/continue', {}, {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (isCurrentAccount(requestedId) && data.ok) {
        const qingmei = data.qingmei
        if (qingmei && heluActivity.value)
          heluActivity.value = { ...heluActivity.value, qingmei }
      }
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err?.message || '青梅酿报价失败' }
    }
    finally {
      qingmeiContinueLoading.value = false
    }
  }

  async function autoBrewQingmei(accountId: string) {
    const requestedId = String(accountId)
    qingmeiAutoBrewLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/wine/auto-brew', {}, {
        headers: { 'x-account-id': accountId },
        timeout: 120000,
        skipErrorToast: true,
      } as any)
      if (isCurrentAccount(requestedId) && data.ok) {
        const qingmei = data.qingmei
        if (qingmei && heluActivity.value)
          heluActivity.value = { ...heluActivity.value, qingmei }
      }
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err?.message || '一键酿造失败' }
    }
    finally {
      qingmeiAutoBrewLoading.value = false
    }
  }

  async function settleQingmeiBrew(accountId: string, share = true) {
    const requestedId = String(accountId)
    qingmeiSettleLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/wine/settle', { share }, {
        headers: { 'x-account-id': accountId },
        timeout: 120000,
        skipErrorToast: true,
      } as any)
      if (isCurrentAccount(requestedId) && data.ok) {
        const qingmei = data.qingmei
        if (qingmei && heluActivity.value)
          heluActivity.value = { ...heluActivity.value, qingmei }
      }
      return data
    }
    catch (err: any) {
      return { ok: false, error: err?.response?.data?.error || err?.message || '青梅酿结算失败' }
    }
    finally {
      qingmeiSettleLoading.value = false
    }
  }

  return {
    heluActivity,
    heluLoading,
    drawLoading,
    exchangeLoading,
    passportClaimLoading,
    solarClaimLoading,
    starRecordClaimLoading,
    qingmeiClaimLoading,
    qingmeiSellLoading,
    qingmeiStartLoading,
    qingmeiContinueLoading,
    qingmeiAutoBrewLoading,
    qingmeiSettleLoading,
    heluError,
    clearActivityData,
    fetchHeluActivity,
    claimStarRecords,
    drawHelu,
    exchangeHelu,
    exchangeStarSand,
    claimHeluPassport,
    claimHeluSolar,
    claimQingmeiSeeds,
    brewAndSellQingmeiWine,
    startQingmeiBrew,
    continueQingmeiBrew,
    autoBrewQingmei,
    settleQingmeiBrew,
  }
})

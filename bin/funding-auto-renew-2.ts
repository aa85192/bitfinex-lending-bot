/*
yarn tsx ./bin/funding-auto-renew-2.ts

新增功能：
  1. INPUT_SPLIT 決定要拆幾單（預設 3）
  2. 依 order-book 計算吸引力，輪替分配單數：
       split=3  →  best 2 + second 1
       split=5  →  best 3 + second 1 + third 1
  3. 僅修改放貸邏輯，其餘 logger / telegram / ZodConfig 不變
*/

// ───────── import ─────────
import { getenv } from '../lib/dotenv.mjs'
import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import JSON5 from 'json5'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import {
  dateStringify,
  floatFormatDecimal,
  floatIsEqual,
  rateStringify,
} from '../lib/helper.mjs'
import { createLoggersByUrl } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

// ───────── 常數 & util ─────────
const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const RATE_MIN = 0.0001 // APR 3.65%

const bitfinex = new Bitfinex({
  apiKey:    getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode:   getenv('BITFINEX_AFF_CODE'),
})

// hack BigInt stringify
;(BigInt as any).prototype.toJSON ??= function () { return this.toString() }

function ymlDump (key: string, val: any): void {
  loggers.log(_.set({}, key, val))
}
function bigintAbs (a: bigint): bigint { return a < 0n ? -a : a }

// ───────── 參數驗證 ─────────
const ZodConfig = z.object({
  // 舊參數
  amount:  z.coerce.number().min(0).default(0),
  currency: z.coerce.string().default('USD'),
  period:  z.record(z.coerce.number().int().min(2).max(120), z.number().positive()).default({}),
  rank:    z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  // 新參數
  split:   z.coerce.number().int().min(1).max(20).default(3),
  alpha:   z.coerce.number().positive().default(0.5),  // 吸引力權重
  beta:    z.coerce.number().positive().max(1).default(0.4), // 報價接近高價程度
})

// ───────── 1. 取得 order-book 統計 ─────────
async function fetchPeriodStats (
  currency: string,
  periods: number[],
  len = 250,
): Promise<Record<number, { volume: number; rateVWAP: number; rateMax: number }>> {
  const stats: Record<number, { volume: number; rateSum: number; rateMax: number }> = {}
  for (const p of periods) stats[p] = { volume: 0, rateSum: 0, rateMax: 0 }

  for (const p of periods) {
    const rows = await Bitfinex.v2FundingBook(currency, p, { len }) as [string, string][]
    for (const [rateStr, amtStr] of rows) {
      const rate = Number(rateStr)
      const amt  = Math.abs(Number(amtStr))
      stats[p].volume  += amt
      stats[p].rateSum += rate * amt
      stats[p].rateMax = Math.max(stats[p].rateMax, rate)
    }
  }
  return _.mapValues(stats, s => ({
    volume: s.volume,
    rateVWAP: s.volume ? s.rateSum / s.volume : 0,
    rateMax: s.rateMax,
  }))
}

// ───────── 2. 輪替分配單數 (split) ─────────
function planOrders (
  stats: Record<number, { volume: number; rateVWAP: number; rateMax: number }>,
  split: number,
  periodMinMap: Record<number, number>,
  alpha: number,
): { period: number; count: number }[] {
  const ranked = _(stats)
    .map((s, p) => {
      const period = Number(p)
      const base   = Math.max(s.rateVWAP, periodMinMap[period] ?? 0)
      const score  = Math.pow(base / (periodMinMap[period] ?? RATE_MIN), alpha) *
                     Math.log1p(s.volume)
      return { period, score }
    })
    .orderBy('score', 'desc')
    .map('period')
    .value()

  if (!ranked.length) throw new Error('order-book 資料為空')

  // round-robin
  const counter: Record<number, number> = {}
  for (let i = 0; i < split; i++) {
    const p = ranked[i % ranked.length]
    counter[p] = (counter[p] ?? 0) + 1
  }
  return Object.entries(counter).map(([p, cnt]) => ({ period: Number(p), count: cnt }))
}

// ───────── 3. 計算掛單利率 ─────────
function calcOfferRate (
  stat: { rateVWAP: number; rateMax: number },
  period: number,
  periodMinMap: Record<number, number>,
  beta: number,
  rateMaxCap: number,
): number {
  const minR = periodMinMap[period] ?? RATE_MIN
  const base = Math.max(stat.rateVWAP, minR)
  return _.clamp(base + beta * (stat.rateMax - base), minR, rateMaxCap)
}

// ───────── 4. main ─────────
export async function main (): Promise<void> {
  const cfg = ZodConfig.parse({
    amount:   getenv('INPUT_AMOUNT'),
    currency: getenv('INPUT_CURRENCY'),
    period:   JSON5.parse(getenv('INPUT_PERIOD')),
    rank:     getenv('INPUT_RANK'),
    rateMax:  getenv('INPUT_RATE_MAX'),
    rateMin:  getenv('INPUT_RATE_MIN'),
    split:    getenv('INPUT_SPLIT'),
    alpha:    getenv('INPUT_ALPHA'),
    beta:     getenv('INPUT_BETA'),
  })

  // 輸入參數輸出
  ymlDump('input', {
    ...cfg,
    rateMin: rateStringify(cfg.rateMin),
    rateMax: rateStringify(cfg.rateMax),
  })

  // Bitfinex 狀態
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API in maintenance')
    return
  }

  // 1) Bitfinex funding stats 仍照舊紀錄
  const fundingStats = (await Bitfinex.v2FundingStatsHist({ currency: cfg.currency, limit: 1 }))?.[0]
  ymlDump('fundingStats', {
    currency: cfg.currency,
    date: dateStringify(fundingStats.mts),
    frr: rateStringify(fundingStats.frr),
  })

  // 2) Auto-renew 狀態 (若原先有開，要先關掉)
  const autoFunding = await bitfinex.v2AuthReadFundingAutoStatus({ currency: cfg.currency })
  if (_.isNil(autoFunding)) loggers.log({ autoRenew: { status: false } })
  else {
    ymlDump('autoRenew', {
      currency: cfg.currency,
      rate: rateStringify(autoFunding.rate),
      period: autoFunding.period,
      amount: autoFunding.amount,
    })
  }

  // 3) 如果有開，就先關閉 auto-renew & 取消舊掛單
  if (autoFunding) await bitfinex.v2AuthWriteFundingAuto({ currency: cfg.currency, status: 0 })
  await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency: cfg.currency })

  // 4) 計算 order-book 統計
  const periods = _.chain(cfg.period).keys().map(_.toSafeInteger).value() as number[] // ex: [2,30,60,120]
  const stats   = await fetchPeriodStats(cfg.currency, periods)

  // 5) 決定各天期掛幾單
  const planArr = planOrders(stats, cfg.split, cfg.period, cfg.alpha)

  // 6) 實際拆單並送出
  const totalAmount = cfg.amount // 0 → 全倉；Bitfinex 會以 0 表示全部可用額
  const amountEach  = totalAmount / cfg.split
  let orderCount = 0

  for (const { period, count } of planArr) {
    const stat = stats[period]
    for (let i = 0; i < count; i++) {
      const rate = _.round(
        calcOfferRate(stat, period, cfg.period, cfg.beta, cfg.rateMax),
        5,
      )
      await bitfinex.v2AuthWriteFundingOffer({
        type:   'LIMIT',
        symbol: cfg.currency,
        amount: amountEach.toFixed(2),
        rate,
        period,
        flags:  0, // auto-renew 由腳本管理
      })
      orderCount++
      await scheduler.wait(120) // 防 rate-limit
    }
  }

  // 7) 等 1 秒讓掛單寫入，再拉回自己掛單金額
  await scheduler.wait(1000)
  const orders      = await bitfinex.v2AuthReadFundingOffers({ currency: cfg.currency })
  const orderAmount = floatFormatDecimal(_.sumBy(orders, 'amount') ?? 0, 8)
  loggers.log({ orders, orderAmount })

  // 8) Telegram 回報
  await telegram
    .sendMessage({
      text: `${filename}:\n已拆成 ${orderCount} 單，共借出 ${orderAmount} ${cfg.currency}`,
    })
    .catch(err => loggers.error(err))
}

// ───── rateTarget → period (原函式保留，供其他腳本共用) ─────
export function rateToPeriod (
  periodMap: z.output<typeof ZodConfig>['period'],
  rateTarget,
) {
  const sorted = _.chain(periodMap)
    .map((v, k) => ({ period: _.toSafeInteger(k), rate: _.toFinite(v) }))
    .orderBy('period', 'desc')
    .value()
  const found = _.find(sorted, ({ period, rate }) => rateTarget >= rate)?.period ?? 2
  return _.clamp(found, 2, 120)
}

// ───────── CLI entry ─────────
class NotMainModuleError extends Error {}
try {
  if (!_.startsWith(import.meta.url, 'file:')) throw new NotMainModuleError()
  const modulePath = url.fileURLToPath(import.meta.url)
  if (process.argv[1] !== modulePath) throw new NotMainModuleError()
  await main()
} catch (err) {
  if (!(err instanceof NotMainModuleError)) {
    loggers.error([err])
    process.exit(1)
  }
}

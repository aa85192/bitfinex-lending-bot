/* ============================================================================
 * funding-auto-renew-2.ts  (2025-05-18, API-fix version)
 * ────────────────────────────────────────────────────────────────────────────
 * 1. INPUT_SPLIT 決定拆幾單；輪替分配到「吸引力最高」的天期
 * 2. 直接呼叫 Bitfinex public REST v2 book/fUSD/P0 取 order-book
 * 3. 其餘：logger / telegram / env 參數 與原版一致
 * ==========================================================================*/

import axios from 'axios'
import { Bitfinex, PlatformStatus } from '@taichunmin/bitfinex'
import { getenv } from '../lib/dotenv.mjs'
import { createLoggersByUrl } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'
import { scheduler } from 'node:timers/promises'
import JSON5 from 'json5'
import _ from 'lodash'
import { z } from 'zod'
import * as url from 'node:url'

/* ───────── 0. 常數 & util ───────── */
const loggers = createLoggersByUrl(import.meta.url)
const RATE_MIN = 0.0001                                          // 3.65 % APR
const PERIODS = [2, 30, 60, 120]                                 // 支援天期

/* ╔══════════════════╗
   ║   1. 參數驗證    ║
   ╚══════════════════╝ */
const ZodConfig = z.object({
  amount:  z.coerce.number().min(0).default(0),
  currency: z.coerce.string().default('USD'),
  period:  z.record(z.coerce.number().int(), z.number().positive()).default({}),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(RATE_MIN),
  split:   z.coerce.number().int().min(1).max(20).default(3),
  alpha:   z.coerce.number().positive().default(0.5),
  beta:    z.coerce.number().positive().max(1).default(0.4),
})

/* ╔═══════════════════════════════╗
   ║   2. Funding book 解析工具    ║
   ╚═══════════════════════════════╝
Endpoint: GET https://api-pub.bitfinex.com/v2/book/fUSD/P0?len=250
回傳每列: [RATE, PERIOD, COUNT, AMOUNT]
*/
async function fetchPeriodStats (
  currency: string,
  periods: number[],
  len = 250,
): Promise<Record<number, { volume:number; rateVWAP:number; rateMax:number }>> {
  const url = `https://api-pub.bitfinex.com/v2/book/f${currency}/P0`
  const { data } = await axios.get(url, { params: { len } })
  const stats: Record<number, { volume:number; rateSum:number; rateMax:number }> = {}
  periods.forEach(p => { stats[p] = { volume:0, rateSum:0, rateMax:0 } })

  for (const [rate, period, , amount] of data as [number, number, number, number][]) {
    if (!stats[period]) continue        // 只統計關心的天期
    const vol = Math.abs(amount)
    stats[period].volume  += vol
    stats[period].rateSum += rate * vol
    stats[period].rateMax  = Math.max(stats[period].rateMax, rate)
  }

  // 整理 VWAP
  return _.mapValues(stats, s => ({
    volume: s.volume,
    rateVWAP: s.volume ? s.rateSum / s.volume : 0,
    rateMax: s.rateMax,
  }))
}

/* ╔══════════════════════════════════════╗
   ║   3. 計算「輪替分配」與掛單利率       ║
   ╚══════════════════════════════════════╝ */
function planOrders (
  stats: Record<number, { volume:number; rateVWAP:number; rateMax:number }>,
  split: number,
  periodMin: Record<number, number>,
  alpha: number,
) {
  const ranked = _(stats)
    .map((s, p) => {
      const minR = periodMin[p] ?? RATE_MIN
      const base = Math.max(s.rateVWAP, minR)
      const score = Math.pow(base / minR, alpha) * Math.log1p(s.volume)
      return { period: Number(p), score }
    })
    .orderBy('score', 'desc')
    .map('period')
    .value()

  const counter: Record<number, number> = {}
  for (let i = 0; i < split; i++) {
    const p = ranked[i % ranked.length]
    counter[p] = (counter[p] ?? 0) + 1
  }
  return Object.entries(counter).map(([p, cnt]) => ({ period: +p, count: cnt }))
}

function offerRate (
  stat: { rateVWAP:number; rateMax:number },
  period: number,
  periodMin: Record<number, number>,
  beta: number,
  cap: number,
) {
  const minR = periodMin[period] ?? RATE_MIN
  const base = Math.max(stat.rateVWAP, minR)
  return _.clamp(base + beta * (stat.rateMax - base), minR, cap)
}

/* ╔══════════════════╗
   ║   4. 主流程       ║
   ╚══════════════════╝ */
async function main () {
  const cfg = ZodConfig.parse({
    amount:   getenv('INPUT_AMOUNT'),
    currency: getenv('INPUT_CURRENCY'),
    period:   JSON5.parse(getenv('INPUT_PERIOD')),
    rateMax:  getenv('INPUT_RATE_MAX'),
    split:    getenv('INPUT_SPLIT'),
    alpha:    getenv('INPUT_ALPHA'),
    beta:     getenv('INPUT_BETA'),
  })

  const periodMin = { ...cfg.period }
  PERIODS.forEach(p => { periodMin[p] ??= RATE_MIN })

  const bitfinex = new Bitfinex({
    apiKey:    getenv('BITFINEX_API_KEY'),
    apiSecret: getenv('BITFINEX_API_SECRET'),
  })

  /*── Bitfinex 是否維護 ──*/
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API in maintenance')
    return
  }

  /*── 取消舊掛單、自行管理 auto-renew ──*/
  await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency: cfg.currency })
  await bitfinex.v2AuthWriteFundingAuto({ currency: cfg.currency, status: 0 })

  /*── 取得 order-book 統計 ──*/
  const stats = await fetchPeriodStats(cfg.currency, PERIODS)
  const plan  = planOrders(stats, cfg.split, periodMin, cfg.alpha)

  /*── 金額分配 ──*/
  const totalAmount = cfg.amount || 0               // 0 = 全額
  const amtPerOrder = totalAmount / cfg.split

  let orderCnt = 0
  for (const { period, count } of plan) {
    const stat = stats[period]
    for (let i = 0; i < count; i++) {
      const rate = offerRate(stat, period, periodMin, cfg.beta, cfg.rateMax)
      await bitfinex.v2AuthWriteFundingOffer({
        type:   'LIMIT',
        symbol: cfg.currency,
        amount: amtPerOrder.toFixed(2),
        rate:   _.round(rate, 5),
        period,
        flags:  0,
      })
      orderCnt++
      await scheduler.wait(120)
    }
  }

  await telegram.sendMessage({
    text: `funding-auto-renew-2: 拆成 ${orderCnt} 單並完成掛單`,
  })
}

class NotMain extends Error {}
try {
  if (!_.startsWith(import.meta.url, 'file:')) throw new NotMain()
  if (process.argv[1] !== url.fileURLToPath(import.meta.url)) throw new NotMain()
  await main()
} catch (err) {
  if (!(err instanceof NotMain)) {
    loggers.error([err])
    process.exit(1)
  }
}

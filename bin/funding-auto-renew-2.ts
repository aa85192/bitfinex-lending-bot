/* =========================================================================
 * funding-auto-renew-2.ts   (2025-05-18  minimal-patch)
 * 功能新增：
 *   • INPUT_SPLIT  指定要拆幾單（預設 3）
 *   • 按 order-book 吸引力自動挑選 2/30/60/120 天期並「輪替」分配張數
 *   • 依 VWAP + 最高價用 β 係數決定每張利率
 * 其餘：API 呼叫、logger、Telegram、餘額邏輯 都與原檔一致
 * =========================================================================*/

import { getenv }                  from '../lib/dotenv.mjs'
import { createLoggersByUrl }      from '../lib/logger.mjs'
import { Bitfinex }                from '@taichunmin/bitfinex'
import { scheduler }               from 'node:timers/promises'
import JSON5                       from 'json5'
import _                           from 'lodash'
import { z }                       from 'zod'

// ───────── logger & 常數 ─────────
const loggers = createLoggersByUrl(import.meta.url)
const RATE_MIN = 0.0001                                    // APR 3.65 %
const PERIODS  = [2, 30, 60, 120]                          // 支援天期

// ───────── Zod 解析 INPUT_* 參數（新增 split / alpha / beta）──
const ZodConfig = z.object({
  amount:  z.coerce.number().min(0).default(0),
  currency:z.coerce.string().default('USD'),
  period:  z.record(z.coerce.number(), z.number()).default({}),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  split:   z.coerce.number().int().min(1).max(20).default(3),
  alpha:   z.coerce.number().positive().default(0.5),
  beta:    z.coerce.number().positive().max(1).default(0.4),
})
const cfg = ZodConfig.parse({
  amount:   getenv('INPUT_AMOUNT'),
  currency: getenv('INPUT_CURRENCY'),
  period:   JSON5.parse(getenv('INPUT_PERIOD')),
  rateMax:  getenv('INPUT_RATE_MAX'),
  split:    getenv('INPUT_SPLIT'),
  alpha:    getenv('INPUT_ALPHA'),
  beta:     getenv('INPUT_BETA'),
})
PERIODS.forEach(p => { cfg.period[p] ??= RATE_MIN })       // 若未給下限補預設

// ───────── 新增兩個小函式：planOrders() / quoteRate() ─────────
function planOrders(
  stats: Record<number,{volume:number;rateVWAP:number;rateMax:number}>,
  split: number,
  periodMin: Record<number,number>,
  alpha: number,
){
  const ranked = _(stats)
    .map((s,p)=>{
      const min = periodMin[p]
      const base= Math.max(s.rateVWAP, min)
      const score = Math.pow(base/min, alpha)*Math.log1p(s.volume)
      return { period:+p, score }
    })
    .orderBy('score','desc')
    .map('period')
    .value()

  const counter:Record<number,number> = {}
  for(let i=0;i<split;i++){
    const p = ranked[i%ranked.length]
    counter[p] = (counter[p]??0)+1
  }
  return Object.entries(counter).map(([p,c])=>({period:+p,count:c}))
}

function quoteRate(
  stat:{rateVWAP:number;rateMax:number},
  period:number,
  periodMin:Record<number,number>,
  beta:number,
  cap:number,
){
  const base = Math.max(stat.rateVWAP, periodMin[period])
  return Math.min(base + beta*(stat.rateMax-base), cap)
}

// ───────── 主流程 ─────────
async function main () {
  const bfx = new Bitfinex({
    apiKey:    getenv('BITFINEX_API_KEY'),
    apiSecret: getenv('BITFINEX_API_SECRET'),
  })

  // ① 取得四個天期 order-book 統計
  const stats:Record<number,{volume:number;rateVWAP:number;rateMax:number}> = {}
  for (const p of PERIODS) {
    const rows = await bfx.v2FundingBook(cfg.currency, p, { len: 250 }) as [number,number][]
    let vol=0,sum=0,max=0
    for (const [rate, amount] of rows){
      const v=Math.abs(amount); vol+=v; sum+=rate*v; max=Math.max(max,rate)
    }
    stats[p]={volume:vol,rateVWAP:vol?sum/vol:0,rateMax:max}
  }

  // ② 按 split & 吸引力計算 plan
  const plan = planOrders(stats, cfg.split, cfg.period, cfg.alpha)
  loggers.log({ plan })
  const totalAmt = cfg.amount || (await bfx.v2AuthReadWallets())
                     .find((w:any)=>w[0]==='funding'&&w[1]===cfg.currency)?.[2] ?? 0
  if (totalAmt<=0){ loggers.error('No balance'); return }
  const eachAmt = totalAmt / cfg.split

  // ③ 取消舊掛單（沿用原函式）
  await bfx.v2AuthWriteFundingOfferCancelAll({ currency: cfg.currency })

  // ④ 依 plan 拆單並送出
  for (const { period, count } of plan) {
    const s = stats[period]
    const rate = _.round(
      quoteRate(s,period,cfg.period,cfg.beta,cfg.rateMax),5
    )
    for (let i=0;i<count;i++){
      await bfx.v2AuthWriteFundingOfferSubmit({
        type:'LIMIT',
        symbol: cfg.currency,
        amount: eachAmt.toFixed(2),
        rate,
        period,
        flags:0,
      })
      await scheduler.wait(120)      // 舊程式的 rate-limit 間隔
    }
  }

  loggers.log(`Placed ${cfg.split} offers, total ${totalAmt} ${cfg.currency}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err=>{ loggers.error(err); process.exit(1) })

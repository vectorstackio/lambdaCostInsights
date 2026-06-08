// handler.ts

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type Dimension,
  type Expression
} from '@aws-sdk/client-cost-explorer'

import {
  CostOptimizationHubClient,
  ListRecommendationsCommand
} from '@aws-sdk/client-cost-optimization-hub'

import type { APIGatewayProxyEventV2 } from 'aws-lambda'

import type {
  ResultByTime
} from '@aws-sdk/client-cost-explorer'

/**
 * -----------------------
 * Types
 * -----------------------
 */

type CostFilter = {
  key: Dimension
  value: string
}

type DrilldownItem = {
  key: string
  cost: number
}

type DrilldownRequest = {
  filters?: CostFilter[]
  groupBy: Dimension
}

type DrilldownResponse = {
  groupBy: Dimension
  nextGroupBy?: Dimension
  filters: CostFilter[]
  items: DrilldownItem[]
}

type TopRecommendation = {
  resourceType: string
  action: string
  current: string
  recommended: string
}

type ServiceComparison = {
  service: string
  currentCost: number
  previousCost: number
  change: number
  changePercent: number
}

type TrendPoint = {
  month: string
  cost: number
}

type AWSRecommendation = {
  estimatedMonthlySavings?: number
  currentResourceType?: string
  actionType?: string
  currentResourceSummary?: string
  recommendedResourceSummary?: string
}

type CostIncreaseDriver = {
  service: string
  currentCost: number
  previousCost: number
  increase: number
  contributionPercent: number
}

type ServiceAnomaly = {
  service: string
  currentCost: number
  averageCost: number
  spikeAmount: number
  spikePercent: number
  zScore: number
  severity: 'low' | 'medium' | 'high'
}

type SummaryResponse = {
  currentMonthCost: number
  previousMonthCost: number
  monthOverMonthChangePercent: number
  byService: { service: string; cost: number }[]  // 👈 revert this
  byServiceComparison: ServiceComparison[]        // 👈 keep enhanced version separately
  trend: TrendPoint[]
  potentialSavings: number
  recommendationCount: number
  topRecommendations: TopRecommendation[]
  topCostIncreaseDrivers: CostIncreaseDriver[]
  anomalies: ServiceAnomaly[]
  metadata?: {
    generatedAt: string
    currency: string
  }
}

/**
 * -----------------------
 * AWS Clients
 * -----------------------
 */

const ce = new CostExplorerClient({ region: 'us-east-1' })
const coh = new CostOptimizationHubClient({ region: 'us-east-1' })

/**
 * -----------------------
 * Drilldown hierarchy
 * -----------------------
 */

const DRILLDOWN_LEVELS: Dimension[] = [
  'SERVICE',
  'REGION',
  'USAGE_TYPE',
  'OPERATION',
  'LINKED_ACCOUNT'
]

function getNextGroupBy(current: Dimension): Dimension | undefined {
  const idx = DRILLDOWN_LEVELS.indexOf(current)
  return DRILLDOWN_LEVELS[idx + 1]
}

/**
 * -----------------------
 * Date helpers
 * -----------------------
 */

function toYMD(date: Date): string {
  return date.toISOString().split('T')[0]
}

function getStartOfMonth(): string {
  const now = new Date()
  return toYMD(new Date(now.getFullYear(), now.getMonth(), 1))
}

function getPreviousMonthRange() {
  const now = new Date()

  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const end = new Date(now.getFullYear(), now.getMonth(), 0)

  return {
    start: toYMD(start),
    end: toYMD(end)
  }
}

function buildFilter(filters: CostFilter[]): Expression | undefined {
  if (!filters.length) return undefined

  const expressions: Expression[] = filters.map((f) => ({
    Dimensions: {
      Key: f.key,
      Values: [f.value]
    }
  }))

  if (expressions.length === 1) {
    return expressions[0]
  }

  return {
    And: expressions
  }
}

function buildTopCostIncreaseDrivers(
  current: { service: string; cost: number }[],
  previous: { service: string; cost: number }[],
  limit = 5
): CostIncreaseDriver[] {
  const previousMap = new Map(
    previous.map(s => [s.service, s.cost])
  )

  const increases = current
    .map(service => {
      const previousCost =
        previousMap.get(service.service) ?? 0

      const increase = service.cost - previousCost

      return {
        service: service.service,
        currentCost: service.cost,
        previousCost,
        increase
      }
    })
    .filter(item => item.increase > 0)

  const totalIncrease = increases.reduce(
    (sum, item) => sum + item.increase,
    0
  )

  return increases
    .sort((a, b) => b.increase - a.increase)
    .slice(0, limit)
    .map(item => ({
      ...item,
      contributionPercent:
        totalIncrease === 0
          ? 0
          : Number(
            (
              (item.increase / totalIncrease) *
              100
            ).toFixed(2)
          )
    }))
}

/**
 * -----------------------
 * Core cost function (reused everywhere)
 * -----------------------
 */

async function getCostData(start: string, end: string) {
  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
    })
  )

  const byService =
    res.ResultsByTime?.[0]?.Groups?.map((g) => ({
      service: g.Keys?.[0] ?? 'Unknown',
      cost: Number(parseFloat(g.Metrics?.UnblendedCost?.Amount ?? '0').toFixed(2))
    })) ?? []

  const total = byService.reduce((sum, s) => sum + s.cost, 0)

  return {
    total: Number(total.toFixed(2)),
    byService
  }
}

/**
 * -----------------------
 * MoM + comparison helpers
 * -----------------------
 */

function calculateMoMChange(current: number, previous: number) {
  if (previous === 0) return 0
  return Number((((current - previous) / previous) * 100).toFixed(2))
}

function buildServiceComparison(
  current: { service: string; cost: number }[],
  previous: { service: string; cost: number }[]
): ServiceComparison[] {
  const prevMap = new Map(previous.map(s => [s.service, s.cost]))

  const allServices = new Set([
    ...current.map(s => s.service),
    ...previous.map(s => s.service)
  ])

  return Array.from(allServices).map(service => {
    const currentCost = current.find(s => s.service === service)?.cost ?? 0
    const previousCost = prevMap.get(service) ?? 0

    const change = Number((currentCost - previousCost).toFixed(2))
    const changePercent =
      previousCost === 0 ? 0 : Number(((change / previousCost) * 100).toFixed(2))

    return {
      service,
      currentCost,
      previousCost,
      change,
      changePercent
    }
  }).sort((a, b) => b.currentCost - a.currentCost)
}

/**
 * -----------------------
 * 6-month trend
 * -----------------------
 */

function getLast6Months() {
  const now = new Date()

  return Array.from({ length: 6 }).map((_, i) => {
    const start = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1)
    const end = new Date(now.getFullYear(), now.getMonth() - (5 - i) + 1, 0)

    return {
      start: toYMD(start),
      end: toYMD(end),
      month: start.toISOString().slice(0, 7)
    }
  })
}

async function getTrend(): Promise<TrendPoint[]> {
  const months = getLast6Months()

  const results = await Promise.all(
    months.map(async (m) => {
      const res = await ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: m.start, End: m.end },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost']
        })
      )

      const cost =
        res.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? '0'

      return {
        month: m.month,
        cost: Number(parseFloat(cost).toFixed(2))
      }
    })
  )

  return results
}

async function getServiceHistory(months = 6) {
  const now = new Date()

  const start = new Date(
    now.getFullYear(),
    now.getMonth() - (months - 1),
    1
  )

  const end = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1
  )

  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: toYMD(start),
        End: toYMD(end)
      },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        {
          Type: 'DIMENSION',
          Key: 'SERVICE'
        }
      ]
    })
  )

  return res.ResultsByTime ?? []
}

function average(values: number[]) {
  return (
    values.reduce((a, b) => a + b, 0) /
    values.length
  )
}

function stdDev(values: number[]) {
  const avg = average(values)

  const variance =
    values.reduce(
      (sum, v) => sum + Math.pow(v - avg, 2),
      0
    ) / values.length

  return Math.sqrt(variance)
}

function buildServiceHistoryMap(
  resultsByTime: ResultByTime[]
): Record<string, number[]> {
  const history: Record<string, number[]> = {}

  for (const month of resultsByTime) {
    for (const group of month.Groups ?? []) {
      const service = group.Keys?.[0] ?? 'Unknown'

      const cost = Number(
        group.Metrics?.UnblendedCost?.Amount ?? '0'
      )

      if (!history[service]) {
        history[service] = []
      }

      history[service].push(cost)
    }
  }

  return history
}

function buildAnomalies(
  serviceHistory: Record<string, number[]>
): ServiceAnomaly[] {
  const anomalies: ServiceAnomaly[] = []

  for (const [service, history] of Object.entries(
    serviceHistory
  )) {
    if (history.length < 4) continue

    const current = history[history.length - 1]

    const baseline = history.slice(0, -1)

    const avg = average(baseline)
    const sd = stdDev(baseline)

    if (sd === 0) continue

    const zScore = (current - avg) / sd

    if (zScore < 2) continue

    const spikeAmount = current - avg

    anomalies.push({
      service,
      currentCost: Number(current.toFixed(2)),
      averageCost: Number(avg.toFixed(2)),
      spikeAmount: Number(spikeAmount.toFixed(2)),
      spikePercent: Number(
        (((current - avg) / avg) * 100).toFixed(2)
      ),
      zScore: Number(zScore.toFixed(2)),
      severity:
        zScore > 4
          ? 'high'
          : zScore > 3
            ? 'medium'
            : 'low'
    })
  }

  return anomalies.sort(
    (a, b) => b.zScore - a.zScore
  )
}

/**
 * -----------------------
 * SUMMARY HANDLER
 * -----------------------
 */
async function handleSummary(): Promise<SummaryResponse> {
  const current = getStartOfMonth()
  const end = toYMD(new Date())

  const prev = getPreviousMonthRange()

  const [currentData, previousData, recRes, trend, serviceHistory] = await Promise.all([
    getCostData(current, end),
    getCostData(prev.start, prev.end),
    coh.send(new ListRecommendationsCommand({ maxResults: 100 })),
    getTrend(),
    getServiceHistory()
  ])

  const monthOverMonthChangePercent = calculateMoMChange(
    currentData.total,
    previousData.total
  )

  const byService = buildServiceComparison(
    currentData.byService,
    previousData.byService
  )

  const topCostIncreaseDrivers =
    buildTopCostIncreaseDrivers(
      currentData.byService,
      previousData.byService
    )

  let potentialSavings = 0

  const topRecommendations: TopRecommendation[] = (
    (recRes.items ?? []) as AWSRecommendation[]
  ).map(r => {
    potentialSavings += r.estimatedMonthlySavings ?? 0

    return {
      resourceType: r.currentResourceType ?? 'Unknown',
      action: r.actionType ?? 'Unknown',
      current: r.currentResourceSummary ?? 'N/A',
      recommended: r.recommendedResourceSummary ?? 'N/A'
    }
  })

  const serviceHistoryMap = buildServiceHistoryMap(serviceHistory)

  const anomalies = buildAnomalies(serviceHistoryMap)

  return {
    currentMonthCost: currentData.total,
    previousMonthCost: previousData.total,

    byService: currentData.byService.map(s => ({
      service: s.service,
      cost: s.cost
    })),

    byServiceComparison: byService,

    topCostIncreaseDrivers,

    monthOverMonthChangePercent,

    trend,

    anomalies,

    potentialSavings: Number(
      potentialSavings.toFixed(2)
    ),

    recommendationCount: recRes.items?.length ?? 0,

    topRecommendations: topRecommendations.slice(0, 5),

    metadata: {
      generatedAt: new Date().toISOString(),
      currency: 'USD'
    }
  }
}

/**
 * -----------------------
 * DRILLDOWN HANDLER (unchanged logic)
 * -----------------------
 */

async function handleDrilldown(body: DrilldownRequest): Promise<DrilldownResponse> {
  const filters = body.filters ?? []
  const groupBy = body.groupBy

  const start = getStartOfMonth()
  const end = toYMD(new Date())

  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: groupBy }],
      Filter: buildFilter(filters)
    })
  )

  const items =
    res.ResultsByTime?.[0]?.Groups
      ?.map(g => ({
        key: g.Keys?.[0] ?? 'Unknown',
        cost: Number(parseFloat(g.Metrics?.UnblendedCost?.Amount ?? '0').toFixed(2))
      }))
      .filter(i => i.cost > 0)
      .sort((a, b) => b.cost - a.cost) ?? []

  return {
    groupBy,
    nextGroupBy: getNextGroupBy(groupBy),
    filters,
    items
  }
}

/**
 * -----------------------
 * MAIN HANDLER
 * -----------------------
 */

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<{ statusCode: number; body: string }> => {
  try {
    const method = event.requestContext.http.method

    if (method === 'GET') {
      const summary = await handleSummary()

      return {
        statusCode: 200,
        body: JSON.stringify(summary)
      }
    }

    if (method === 'POST') {
      const body: DrilldownRequest = JSON.parse(event.body ?? '{}')

      if (!body.groupBy) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'groupBy is required' })
        }
      }

      const result = await handleDrilldown(body)

      return {
        statusCode: 200,
        body: JSON.stringify(result)
      }
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    }
  } catch (err) {
    console.error(err)
    console.error('DRILLDOWN ERROR RAW:', err)

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    }
  }
}

// import {
//   CostExplorerClient,
//   GetCostAndUsageCommand,
//   type Dimension,
//   type Expression
// } from '@aws-sdk/client-cost-explorer'

// import {
//   CostOptimizationHubClient,
//   ListRecommendationsCommand
// } from '@aws-sdk/client-cost-optimization-hub'

// import type { APIGatewayProxyEventV2 } from 'aws-lambda'

// /**
//  * -----------------------
//  * Types
//  * -----------------------
//  */

// type CostFilter = {
//   key: Dimension
//   value: string
// }

// type DrilldownItem = {
//   key: string
//   cost: number
// }

// type DrilldownRequest = {
//   filters?: CostFilter[]
//   groupBy: Dimension
// }

// type DrilldownResponse = {
//   groupBy: Dimension
//   nextGroupBy?: Dimension
//   filters: CostFilter[]
//   items: DrilldownItem[]
// }

// type TopRecommendation = {
//   resourceType: string
//   action: string
//   current: string
//   recommended: string
// }

// type SummaryResponse = {
//   currentMonthCost: number
//   previousMonthCost: number
//   byService: { service: string; cost: number }[]
//   potentialSavings: number
//   recommendationCount: number
//   topRecommendations: TopRecommendation[]
// }

// type AWSRecommendation = {
//   estimatedMonthlySavings?: number
//   currentResourceType?: string
//   actionType?: string
//   currentResourceSummary?: string
//   recommendedResourceSummary?: string
// }

// /**
//  * -----------------------
//  * AWS Clients
//  * -----------------------
//  */

// const ce = new CostExplorerClient({ region: 'us-east-1' })
// const coh = new CostOptimizationHubClient({ region: 'us-east-1' })

// /**
//  * -----------------------
//  * Drilldown hierarchy
//  * -----------------------
//  */

// const DRILLDOWN_LEVELS: Dimension[] = [
//   'SERVICE',
//   'REGION',
//   'USAGE_TYPE',
//   'OPERATION',
//   'LINKED_ACCOUNT'
// ]

// function getNextGroupBy(current: Dimension): Dimension | undefined {
//   const idx = DRILLDOWN_LEVELS.indexOf(current)
//   return DRILLDOWN_LEVELS[idx + 1]
// }

// /**
//  * -----------------------
//  * Date helpers
//  * -----------------------
//  */

// function toYMD(date: Date): string {
//   return date.toISOString().split('T')[0]
// }

// function getStartOfMonth(): string {
//   const now = new Date()
//   return toYMD(new Date(now.getFullYear(), now.getMonth(), 1))
// }

// function getPreviousMonthRange() {
//   const now = new Date()

//   const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
//   const end = new Date(now.getFullYear(), now.getMonth(), 0)

//   return {
//     start: toYMD(start),
//     end: toYMD(end)
//   }
// }

// /**
//  * -----------------------
//  * Helpers
//  * -----------------------
//  */

// function buildFilter(filters: CostFilter[]): Expression | undefined {
//   if (!filters.length) return undefined

//   const expressions: Expression[] = filters.map((f) => ({
//     Dimensions: {
//       Key: f.key,
//       Values: [f.value]
//     }
//   }))

//   if (expressions.length === 1) return expressions[0]

//   return { And: expressions }
// }

// async function getMonthlyCost(start: string, end: string) {
//   const res = await ce.send(
//     new GetCostAndUsageCommand({
//       TimePeriod: { Start: start, End: end },
//       Granularity: 'MONTHLY',
//       Metrics: ['UnblendedCost'],
//       GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
//     })
//   )

//   const byService =
//     res.ResultsByTime?.[0]?.Groups?.map((g) => ({
//       service: g.Keys?.[0] ?? 'Unknown',
//       cost: Number(parseFloat(g.Metrics?.UnblendedCost?.Amount ?? '0').toFixed(2))
//     })) ?? []

//   const total = byService.reduce((sum, s) => sum + s.cost, 0)

//   return {
//     total: Number(total.toFixed(2)),
//     byService: byService.sort((a, b) => b.cost - a.cost)
//   }
// }

// /**
//  * -----------------------
//  * SUMMARY HANDLER
//  * -----------------------
//  */

// async function handleSummary(): Promise<SummaryResponse> {
//   const currentStart = getStartOfMonth()
//   const currentEnd = toYMD(new Date())

//   const previous = getPreviousMonthRange()

//   const [current, previousMonth, recRes] = await Promise.all([
//     getMonthlyCost(currentStart, currentEnd),
//     getMonthlyCost(previous.start, previous.end),
//     coh.send(new ListRecommendationsCommand({ maxResults: 100 }))
//   ])

//   let potentialSavings = 0

//   const topRecommendations: TopRecommendation[] = (
//     (recRes.items ?? []) as AWSRecommendation[]
//   ).map((r) => {
//     potentialSavings += r.estimatedMonthlySavings ?? 0

//     return {
//       resourceType: r.currentResourceType ?? 'Unknown',
//       action: r.actionType ?? 'Unknown',
//       current: r.currentResourceSummary ?? 'N/A',
//       recommended: r.recommendedResourceSummary ?? 'N/A'
//     }
//   })

//   return {
//     currentMonthCost: current.total,
//     previousMonthCost: previousMonth.total,
//     potentialSavings: Number(potentialSavings.toFixed(2)),
//     recommendationCount: recRes.items?.length ?? 0,
//     byService: current.byService,
//     topRecommendations: topRecommendations
//   }
// }

// /**
//  * -----------------------
//  * DRILLDOWN HANDLER
//  * -----------------------
//  */

// async function handleDrilldown(body: DrilldownRequest): Promise<DrilldownResponse> {
//   const filters = body.filters ?? []
//   const groupBy = body.groupBy

//   const start = getStartOfMonth()
//   const end = toYMD(new Date())

//   const res = await ce.send(
//     new GetCostAndUsageCommand({
//       TimePeriod: { Start: start, End: end },
//       Granularity: 'MONTHLY',
//       Metrics: ['UnblendedCost'],
//       GroupBy: [{ Type: 'DIMENSION', Key: groupBy }],
//       Filter: buildFilter(filters)
//     })
//   )

//   const items: DrilldownItem[] =
//     res.ResultsByTime?.[0]?.Groups
//       ?.map((g) => ({
//         key: g.Keys?.[0] ?? 'Unknown',
//         cost: Number(parseFloat(g.Metrics?.UnblendedCost?.Amount ?? '0').toFixed(2))
//       }))
//       .filter((i) => i.cost > 0)
//       .sort((a, b) => b.cost - a.cost) ?? []

//   return {
//     groupBy,
//     nextGroupBy: getNextGroupBy(groupBy),
//     filters,
//     items
//   }
// }

// /**
//  * -----------------------
//  * MAIN HANDLER
//  * -----------------------
//  */

// export const handler = async (
//   event: APIGatewayProxyEventV2
// ): Promise<{ statusCode: number; body: string }> => {
//   try {
//     const method = event.requestContext.http.method

//     if (method === 'GET') {
//       const summary = await handleSummary()

//       return {
//         statusCode: 200,
//         body: JSON.stringify(summary)
//       }
//     }

//     if (method === 'POST') {
//       const body: DrilldownRequest = JSON.parse(event.body ?? '{}')

//       if (!body.groupBy) {
//         return {
//           statusCode: 400,
//           body: JSON.stringify({ error: 'groupBy is required' })
//         }
//       }

//       const result = await handleDrilldown(body)

//       return {
//         statusCode: 200,
//         body: JSON.stringify(result)
//       }
//     }

//     return {
//       statusCode: 405,
//       body: JSON.stringify({ error: 'Method not allowed' })
//     }
//   } catch (err) {
//     console.error(err)

//     return {
//       statusCode: 500,
//       body: JSON.stringify({ error: 'Internal server error' })
//     }
//   }
// }
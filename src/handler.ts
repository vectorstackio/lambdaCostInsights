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
  metadata?: {
    generatedAt: string
    currency: string
  }
}

type AWSRecommendation = {
  estimatedMonthlySavings?: number
  currentResourceType?: string
  actionType?: string
  currentResourceSummary?: string
  recommendedResourceSummary?: string
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

/**
 * -----------------------
 * SUMMARY HANDLER
 * -----------------------
 */

async function handleSummary(): Promise<SummaryResponse> {
  const current = getStartOfMonth()
  const end = toYMD(new Date())

  const prev = getPreviousMonthRange()

  const [currentData, previousData, recRes, trend] = await Promise.all([
    getCostData(current, end),
    getCostData(prev.start, prev.end),
    coh.send(new ListRecommendationsCommand({ maxResults: 100 })),
    getTrend()
  ])

  const monthOverMonthChangePercent = calculateMoMChange(
    currentData.total,
    previousData.total
  )

  const byService = buildServiceComparison(
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

  return {
    // =========================
    // ORIGINAL FRONTEND CONTRACT (UNCHANGED)
    // =========================

    currentMonthCost: currentData.total,

    previousMonthCost: previousData.total,

    byService: currentData.byService.map(s => ({
      service: s.service,
      cost: s.cost
    })),

    potentialSavings: Number(potentialSavings.toFixed(2)),
    recommendationCount: recRes.items?.length ?? 0,
    topRecommendations: topRecommendations,

    // =========================
    // NEW FIELDS (SAFE ADDITIONS)
    // =========================

    monthOverMonthChangePercent,

    byServiceComparison: byService, // enhanced version (new shape)

    trend,

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
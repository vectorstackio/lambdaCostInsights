// handler.ts

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type Dimension,
  type Expression,
  type ResultByTime,
  type Group,
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

type CostGroup = Group

type CostFilter = {
  key: Dimension
  value: string
}

type DrilldownItem = {
  key: string
  cost: number
  percentageOfParent?: number
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

type CostIncreaseDriver = {
  service: string
  currentCost: number
  previousCost: number
  increase: number
  contributionPercent: number
  isNewService: boolean
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

type RootCauseNode = {
  level: Dimension
  key: string

  currentCost: number
  previousCost: number
  change: number
  changePercent: number

  contributionToParent: number

  isNew?: boolean

  children?: RootCauseNode[]
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
  rootCauseTree: RootCauseNode[]
  topCausalChains: RootCauseNode[]
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
  'USAGE_TYPE',
  'REGION',
  'OPERATION',
  'LINKED_ACCOUNT',
  'RESOURCE_ID'
]

const getNextGroupBy = (current: Dimension): Dimension | undefined => {
  const idx = DRILLDOWN_LEVELS.indexOf(current)
  return DRILLDOWN_LEVELS[idx + 1]
}

/**
 * -----------------------
 * Date helpers
 * -----------------------
 */

const getMonthRange = (month: string) => {
  const [year, monthIndex] = month.split('-').map(Number)
  const start = new Date(year, monthIndex - 1, 1)
  const end = new Date(year, monthIndex, 0) // last day of month

  return {
    start: toYMD(start),
    end: toYMD(end)
  }
}

const getPreviousMonthFrom = (month: string) => {
  const [year, monthIndex] = month.split('-').map(Number)
  const prevStart = new Date(year, monthIndex - 2, 1)
  const prevEnd = new Date(year, monthIndex - 1, 0)

  return {
    start: toYMD(prevStart),
    end: toYMD(prevEnd)
  }
}

const toYMD = (date: Date): string => {
  return date.toISOString().split('T')[0]
}

const getStartOfMonth = (): string => {
  const now = new Date()
  return toYMD(new Date(now.getFullYear(), now.getMonth(), 1))
}

const getPreviousMonthRange = () => {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const end = new Date(now.getFullYear(), now.getMonth(), 0)

  return {
    start: toYMD(start),
    end: toYMD(end)
  }
}

const buildFilter = (filters: CostFilter[]): Expression | undefined => {
  if (!filters.length) return undefined

  const expressions: Expression[] = filters.map(f => ({
    Dimensions: {
      Key: f.key,
      Values: [f.value]
    }
  }))

  if (expressions.length === 1) return expressions[0]

  // FIX: prevent AWS AND error
  return expressions.length > 1 ? { And: expressions } : expressions[0]
}

const buildTopCostIncreaseDrivers = (
  current: { service: string; cost: number }[],
  previous: { service: string; cost: number }[],
  limit = 5
): CostIncreaseDriver[] => {
  const previousMap = new Map(
    previous.map(s => [s.service, s.cost])
  )

  const increases = current
    .map(service => {
      const previousCost =
        previousMap.get(service.service) ?? 0

      const increase = service.cost - previousCost

      const isNewService = !previousMap.has(service.service)

      return {
        service: service.service,
        currentCost: service.cost,
        previousCost,
        increase,
        isNewService
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

const getCostData = async (start: string, end: string) => {
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

const calculateMoMChange = (current: number, previous: number) => {
  if (previous === 0) return 0

  return Number((((current - previous) / previous) * 100).toFixed(2))
}

const buildServiceComparison = (
  current: { service: string; cost: number }[],
  previous: { service: string; cost: number }[]
): ServiceComparison[] => {
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

const getLast6Months = () => {
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

const getTrend = async (): Promise<TrendPoint[]> => {
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

const getServiceHistory = async (months = 6) => {
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

const average = (values: number[]) => {
  return (
    values.reduce((a, b) => a + b, 0) /
    values.length
  )
}

const stdDev = (values: number[]) => {
  const avg = average(values)

  const variance =
    values.reduce(
      (sum, v) => sum + Math.pow(v - avg, 2),
      0
    ) / values.length

  return Math.sqrt(variance)
}

const buildServiceHistoryMap = (
  resultsByTime: ResultByTime[]
): Record<string, number[]> => {
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

const buildAnomalies = (
  serviceHistory: Record<string, number[]>
): ServiceAnomaly[] => {
  const anomalies: ServiceAnomaly[] = []

  for (const [service, history] of Object.entries(serviceHistory)) {
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

const getCostBreakdown = async (
  start: string,
  end: string,
  groupBy: Dimension[],
  filter?: Expression
) => {
  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: groupBy.map(g => ({ Type: 'DIMENSION', Key: g })),
      Filter: filter
    })
  )

  return res.ResultsByTime?.[0]?.Groups ?? []
}

const buildHierarchy = (
  groups: CostGroup[],
  levels: Dimension[]
): RootCauseNode[] => {
  const level = levels[0]
  const nextLevels = levels.slice(1)

  const map = new Map<
    string,
    {
      key: string
      level: Dimension
      currentCost: number
      previousCost: number
      childrenRaw: CostGroup[]
    }
  >()

  for (const g of groups) {
    const key = g.Keys?.[0] ?? 'Unknown'
    const cost = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
    const existing = map.get(key)

    if (!existing) {
      map.set(key, {
        key,
        level,
        currentCost: cost,
        previousCost: 0,
        childrenRaw: [g]
      })
    } else {
      existing.currentCost += cost
      existing.childrenRaw.push(g)
    }
  }

  const nodes: RootCauseNode[] = []

  for (const node of map.values()) {
    const children =
      nextLevels.length > 0
        ? buildHierarchy(node.childrenRaw, nextLevels)
        : undefined

    const change = node.currentCost - node.previousCost

    nodes.push({
      level: node.level,
      key: node.key,
      currentCost: node.currentCost,
      previousCost: node.previousCost,
      change,
      changePercent:
        node.previousCost === 0
          ? 0
          : Number(
            ((change / node.previousCost) * 100).toFixed(2)
          ),
      contributionToParent: 0,
      children
    })
  }

  return nodes.sort(
    (a, b) => b.currentCost - a.currentCost
  )
}

const enrichWithPrevious = (
  current: RootCauseNode[],
  previousMap: Map<string, number>
): RootCauseNode[] => {

  return current.map(node => {
    const prev = previousMap.get(node.key) ?? 0

    const change = node.currentCost - prev

    const changePercent =
      prev === 0 ? 100 : (change / prev) * 100

    const children = node.children
      ? enrichWithPrevious(node.children, previousMap)
      : undefined

    return {
      ...node,
      previousCost: prev,
      change,
      changePercent,
      isNew: prev === 0,
      children
    }
  })
}

const extractTopCausalChain = (nodes: RootCauseNode[]): RootCauseNode[] => {
  return nodes
    .sort((a, b) => b.change - a.change)
    .slice(0, 3)
}

/**
 * -----------------------
 * SUMMARY HANDLER
 * -----------------------
 */
const handleSummary = async (
  month?: string
): Promise<SummaryResponse> => {
  const now = new Date()

  const currentRange = month
    ? getMonthRange(month)
    : {
      start: getStartOfMonth(),
      end: toYMD(now)
    }

  const prevRange = month
    ? getPreviousMonthFrom(month)
    : getPreviousMonthRange()

  // Cost Explorer requires Start < End.
  // On the first day of the current month, there is
  // no completed day of current-month cost data yet.
  const isEmptyCurrentMonth = !month && currentRange.start === currentRange.end

  const [
    currentData,
    previousData,
    recRes,
    trend,
    serviceHistory
  ] = await Promise.all([
    isEmptyCurrentMonth
      ? Promise.resolve({
        total: 0,
        byService: []
      })
      : getCostData(
        currentRange.start,
        currentRange.end
      ),

    getCostData(
      prevRange.start,
      prevRange.end
    ),

    coh.send(new ListRecommendationsCommand({ maxResults: 100 })),
    getTrend(),
    getServiceHistory()
  ])

  const monthOverMonthChangePercent = calculateMoMChange(currentData.total, previousData.total)
  const byService = buildServiceComparison(currentData.byService, previousData.byService)
  const topCostIncreaseDrivers = buildTopCostIncreaseDrivers(currentData.byService, previousData.byService)

  let potentialSavings = 0

  const topRecommendations: TopRecommendation[] =
    (recRes.items ?? []).map(r => {
      potentialSavings +=
        r.estimatedMonthlySavings ?? 0

      return {
        resourceType:
          r.currentResourceType ?? 'Unknown',

        action:
          r.actionType ?? 'Unknown',

        current:
          r.currentResourceSummary ?? 'N/A',

        recommended:
          r.recommendedResourceSummary ?? 'N/A'
      }
    })

  const serviceHistoryMap = buildServiceHistoryMap(serviceHistory)
  const anomalies = buildAnomalies(serviceHistoryMap)

  // There is no valid current-month Cost Explorer
  // range on the first day of the month.
  const currentRaw = isEmptyCurrentMonth
    ? []
    : await getCostBreakdown(
      currentRange.start,
      currentRange.end,
      ['SERVICE']
    )

  const previousRaw =
    await getCostBreakdown(
      prevRange.start,
      prevRange.end,
      ['SERVICE']
    )

  const tree = buildHierarchy(
    currentRaw,
    [
      'SERVICE',
      'REGION',
      'USAGE_TYPE'
    ]
  )

  const topCausalChains = extractTopCausalChain(tree)

  const previousMap = new Map(
    previousRaw.map(g => [
      g.Keys?.[0] ?? 'Unknown',
      Number(
        g.Metrics?.UnblendedCost?.Amount ?? 0
      )
    ])
  )

  const rootCauseTree = enrichWithPrevious(tree, previousMap)

  return {
    currentMonthCost: currentData.total,
    previousMonthCost: previousData.total,

    byService:
      currentData.byService.map(s => ({
        service: s.service,
        cost: s.cost
      })),

    byServiceComparison: byService,
    topCostIncreaseDrivers,
    monthOverMonthChangePercent,
    trend,
    anomalies,
    potentialSavings: Number(potentialSavings.toFixed(2)),
    recommendationCount: recRes.items?.length ?? 0,
    topRecommendations,
    rootCauseTree,
    topCausalChains,

    metadata: {
      generatedAt: new Date().toISOString(),

      currency: 'USD'
    }
  }
}

/**
 * -----------------------
 * DRILLDOWN HANDLER
 * -----------------------
 */
const handleDrilldown = async (
  body: DrilldownRequest
): Promise<
  DrilldownResponse & {
    total: number
    context: {
      depth: number
      path: CostFilter[]
      groupBy: Dimension
      nextGroupBy?: Dimension
    }
  }
> => {
  const filters = body.filters ?? []
  const groupBy = body.groupBy
  const start = getStartOfMonth()
  const end = toYMD(new Date())
  const isEmptyCurrentMonth = start === end

  if (isEmptyCurrentMonth) {
    const context = {
      depth: filters.length,
      path: filters,
      groupBy,
      nextGroupBy: getNextGroupBy(groupBy)
    }

    return {
      groupBy,
      nextGroupBy: context.nextGroupBy,
      filters,
      items: [],
      total: 0,
      context
    }
  }

  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: start,
        End: end
      },

      Granularity:
        'MONTHLY',

      Metrics: [
        'UnblendedCost'
      ],

      GroupBy: [
        {
          Type: 'DIMENSION',
          Key: groupBy
        }
      ],

      Filter:
        buildFilter(filters)
    })
  )

  const rawItems = res.ResultsByTime?.[0]?.Groups ?? []

  // ----------------------------
  // BASE TRANSFORM
  // ----------------------------
  const items =
    rawItems
      .map(g => ({
        key:
          g.Keys?.[0] ??
          'Unknown',

        cost:
          Number(
            parseFloat(
              g.Metrics
                ?.UnblendedCost
                ?.Amount ?? '0'
            ).toFixed(2)
          )
      }))
      .filter(
        i => i.cost > 0
      )

  // ----------------------------
  // TOTAL
  // ----------------------------
  const total =
    items.reduce(
      (s, i) =>
        s + i.cost,
      0
    )

  // ----------------------------
  // STABLE SORT
  // ----------------------------
  const sorted =
    items.sort(
      (a, b) => {
        if (
          b.cost !== a.cost
        ) {
          return (
            b.cost -
            a.cost
          )
        }

        return a.key.localeCompare(
          b.key
        )
      }
    )

  // ----------------------------
  // ENRICH WITH PARENT %
  // ----------------------------
  const enriched =
    sorted.map(i => ({
      ...i,

      percentageOfParent:
        total === 0
          ? 0
          : Number(
            (
              (i.cost /
                total) *
              100
            ).toFixed(2)
          )
    }))

  // ----------------------------
  // CONTEXT
  // ----------------------------
  const context = {
    depth: filters.length,
    path: filters,
    groupBy,
    nextGroupBy: getNextGroupBy(groupBy)
  }

  return {
    groupBy,
    nextGroupBy: context.nextGroupBy,
    filters,
    items:enriched,
    total,
    context
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
      const month = event.queryStringParameters?.month
      const summary = await handleSummary(month)

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

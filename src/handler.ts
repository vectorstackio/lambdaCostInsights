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

import type { APIGatewayProxyEvent } from 'aws-lambda'

/**
 * -----------------------
 * Types
 * -----------------------
 */

type CostFilter = {
  key: string
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
  filters: CostFilter[]
  items: DrilldownItem[]
}

type TopRecommendation = {
  resourceType: string
  action: string
  current: string
  recommended: string
}

type SummaryResponse = {
  currentMonthCost: number
  byService: { service: string; cost: number }[]
  potentialSavings: number
  recommendationCount: number
  topRecommendations: TopRecommendation[]
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

const ce = new CostExplorerClient({
  region: 'us-east-1'
})

const coh = new CostOptimizationHubClient({
  region: 'us-east-1'
})

/**
 * -----------------------
 * Helpers
 * -----------------------
 */

function getStartOfMonth(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0]
}

function buildFilter(filters: CostFilter[]): Expression | undefined {
  if (!filters.length) return undefined

  const expressions: Expression[] = filters.map((f) => ({
    Dimensions: {
      Key: f.key as Dimension,
      Values: [f.value]
    }
  }))

  // IMPORTANT: Cost Explorer rule
  if (expressions.length === 1) {
    return expressions[0]
  }

  return {
    And: expressions
  }
}

/**
 * -----------------------
 * HANDLER 1: SUMMARY
 * -----------------------
 */

async function handleSummary(): Promise<SummaryResponse> {
  const start = getStartOfMonth()
  const end = new Date().toISOString().split('T')[0]

  const costRes = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
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

  const recRes = await coh.send(
    new ListRecommendationsCommand({
      maxResults: 100
    })
  )

  const byService =
    costRes.ResultsByTime?.[0]?.Groups?.map((g) => ({
      service: g.Keys?.[0] ?? 'Unknown',
      cost: Number(
        parseFloat(
          g.Metrics?.UnblendedCost?.Amount ?? '0'
        ).toFixed(2)
      )
    })) ?? []

  const currentMonthCost = byService.reduce(
    (sum, s) => sum + s.cost,
    0
  )

  let potentialSavings = 0

  const recommendations = (recRes.items ?? []) as AWSRecommendation[]
  const topRecommendations = recommendations.map((r) => {
    potentialSavings += r.estimatedMonthlySavings ?? 0

    return {
      resourceType: r.currentResourceType ?? 'Unknown',
      action: r.actionType ?? 'Unknown',
      current: r.currentResourceSummary ?? 'N/A',
      recommended: r.recommendedResourceSummary ?? 'N/A'
    }
  })

  byService.sort((a, b) => b.cost - a.cost)

  return {
    currentMonthCost: Number(currentMonthCost.toFixed(2)),
    potentialSavings: Number(potentialSavings.toFixed(2)),
    recommendationCount: recRes.items?.length ?? 0,
    byService,
    topRecommendations: topRecommendations.slice(0, 5)
  }
}

/**
 * -----------------------
 * HANDLER 2: DRILLDOWN ENGINE
 * -----------------------
 */

async function handleDrilldown(
  body: DrilldownRequest
): Promise<DrilldownResponse> {
  const filters = body.filters ?? []
  const groupBy = body.groupBy

  if (!groupBy) {
    throw new Error('groupBy is required')
  }

  const start = getStartOfMonth()
  const end = new Date().toISOString().split('T')[0]

  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        {
          Type: 'DIMENSION',
          Key: groupBy
        }
      ],
      Filter: buildFilter(filters)
    })
  )

  const items: DrilldownItem[] =
    res.ResultsByTime?.[0]?.Groups?.map((g) => ({
      key: g.Keys?.[0] ?? 'Unknown',
      cost: Number(
        parseFloat(
          g.Metrics?.UnblendedCost?.Amount ?? '0'
        ).toFixed(2)
      )
    })) ?? []

  return {
    groupBy,
    filters,
    items
  }
}

/**
 * -----------------------
 * MAIN LAMBDA ENTRY
 * -----------------------
 */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<{ statusCode: number; body: string }> => {
  try {
    console.log({ event })
    // const method = event.httpMethod
    const method = event.requestContext?.http?.method
    console.log({ method })
    //const method = event.requestContext.http.method

    /**
     * -----------------------
     * ROUTER
     * -----------------------
     */
    if (method === 'GET') {
      const summary = await handleSummary()

      return {
        statusCode: 200,
        body: JSON.stringify(summary)
      }
    }

    if (method === 'POST') {
      const body: DrilldownRequest = JSON.parse(
        event.body ?? '{}'
      )

      const result = await handleDrilldown(body)

      return {
        statusCode: 200,
        body: JSON.stringify(result)
      }
    }

    return {
      statusCode: 405,
      body: JSON.stringify({
        error: 'Method not allowed'
      })
    }
  } catch (err) {
    console.error(err)

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error'
      })
    }
  }
}
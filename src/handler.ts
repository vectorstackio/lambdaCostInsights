// handler.ts

import {
  CostExplorerClient,
  GetCostAndUsageCommand
} from '@aws-sdk/client-cost-explorer'

import {
  CostOptimizationHubClient,
  ListRecommendationsCommand
} from '@aws-sdk/client-cost-optimization-hub'

/**
 * -----------------------
 * Types (your API layer)
 * -----------------------
 */
type TopRecommendation = {
  resourceType: string
  action: string
  current: string
  recommended: string
}

type SummaryResponse = {
  currentMonthCost: number
  potentialSavings: number
  recommendationCount: number
  byService: ServiceCost[]
  topRecommendations: TopRecommendation[]
}

type AWSRecommendation = {
  estimatedMonthlySavings?: number
  currentResourceType?: string
  actionType?: string
  currentResourceSummary?: string
  recommendedResourceSummary?: string
}

type ServiceCost = {
  service: string
  cost: number
}

/**
 * -----------------------
 * AWS clients (data layer)
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

function mapRecommendation(r: AWSRecommendation): TopRecommendation {
  return {
    resourceType: r.currentResourceType ?? 'Unknown',
    action: r.actionType ?? 'Unknown',
    current: r.currentResourceSummary ?? 'N/A',
    recommended: r.recommendedResourceSummary ?? 'N/A'
  }
}

/**
 * -----------------------
 * Handler
 * -----------------------
 */
export const handler = async (): Promise<{
  statusCode: number
  body: string
}> => {
  /**
   * 1. FETCH LAYER
   */
  const start = getStartOfMonth()
  const end = new Date().toISOString().split('T')[0]

  const costRes = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: start,
        End: end
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

  const recRes = await coh.send(
    new ListRecommendationsCommand({
      maxResults: 100
    })
  )

  // const recommendations = (recRes.items ?? []) as any[]
  const recommendations: AWSRecommendation[] = recRes.items ?? []

  /**
   * 2. TRANSFORM LAYER
   */
  // Service breakdown
  const byService: ServiceCost[] =
    costRes.ResultsByTime?.[0]?.Groups?.map((group) => ({
      service: group.Keys?.[0] ?? 'Unknown',
      cost: Number(
        parseFloat(
          group.Metrics?.UnblendedCost?.Amount ?? '0'
        ).toFixed(2)
      )
    })) ?? []

  // Total monthly cost
  const currentMonthCost = Number(
    byService
      .reduce((sum, service) => sum + service.cost, 0)
      .toFixed(2)
  )

  // Savings + recommendations
  let potentialSavings = 0

  const topRecommendations: TopRecommendation[] = recommendations.map((r) => {
    potentialSavings += r.estimatedMonthlySavings ?? 0
    return mapRecommendation(r)
  })

  // Sort services by cost descending
  byService.sort((a, b) => b.cost - a.cost)

  // Sort recommendations by savings descending
  // (future-proof if you later expose savings per recommendation)
  const response: SummaryResponse = {
    currentMonthCost,
    potentialSavings: Number(potentialSavings.toFixed(2)),
    recommendationCount: recommendations.length,
    byService,
    topRecommendations: topRecommendations.slice(0, 5)
  }

  console.log(response)

  /**
   * 3. RESPONSE LAYER
   */
  return {
    statusCode: 200,
    body: JSON.stringify(response)
  }
}
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
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost']
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
  let potentialSavings = 0

  const topRecommendations: TopRecommendation[] = recommendations.map((r) => {
    potentialSavings += r.estimatedMonthlySavings ?? 0
    return mapRecommendation(r)
  })

  const currentMonthCost = Number(
    (
      parseFloat(
        costRes.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || '0'
      )
    ).toFixed(2)
  )

  const response: SummaryResponse = {
    currentMonthCost,
    potentialSavings: Number(potentialSavings.toFixed(2)),
    recommendationCount: recommendations.length,
    topRecommendations: topRecommendations.slice(0, 5)
  }

  /**
   * 3. RESPONSE LAYER
   */
  return {
    statusCode: 200,
    body: JSON.stringify(response)
  }
}

// import {
//   CostExplorerClient,
//   GetCostAndUsageCommand
// } from '@aws-sdk/client-cost-explorer'

// import {
//   CostOptimizationHubClient,
//   ListRecommendationsCommand
// } from '@aws-sdk/client-cost-optimization-hub'

// type COHRecommendation = {
//   estimatedMonthlySavings?: number
//   estimatedSavingsPercentage?: number
//   estimatedMonthlyCost?: number
// }

// const ce = new CostExplorerClient({})
// const coh = new CostOptimizationHubClient({
//   region: 'us-east-1'
// })

// function getStartOfMonth() {
//   const now = new Date()
//   return new Date(now.getFullYear(), now.getMonth(), 1)
//     .toISOString()
//     .split('T')[0]
// }

// export const handler = async () => {
//   const start = getStartOfMonth()
//   const end = new Date().toISOString().split('T')[0]

//   // 1. Get current month cost
//   const costRes = await ce.send(
//     new GetCostAndUsageCommand({
//       TimePeriod: { Start: start, End: end },
//       Granularity: 'MONTHLY',
//       Metrics: ['UnblendedCost']
//     })
//   )

//   const currentMonthCost =
//     parseFloat(
//       costRes.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || '0'
//     )

//   // 2. Get recommendations (Cost Optimization Hub)
//   let potentialSavings = 0
//   let recommendationCount = 0

//   try {
//     const recRes = await coh.send(
//       new ListRecommendationsCommand({
//         maxResults: 100
//       })
//     )
//     console.log(JSON.stringify(recRes, null, 2))

//     const recommendations = (recRes.items ?? []) as COHRecommendation[]

//     recommendationCount = recommendations.length

//     for (const r of recommendations) {
//       potentialSavings += r.estimatedMonthlySavings ?? 0
//     }

//     // for (const r of recommendations) {
//     //   const savings = r.savingsOpportunity?.estimatedMonthlySavings?.amount
//     //   if (savings) {
//     //     potentialSavings += parseFloat(savings)
//     //   }
//     // }
//   } catch (err) {
//     // If COH isn't ready, don't fail the whole function
//     console.log('COH not available yet', err)
//   }

//   return {
//     statusCode: 200,
//     body: JSON.stringify({
//       currentMonthCost: Number(currentMonthCost.toFixed(2)),
//       potentialSavings: Number(potentialSavings.toFixed(2)),
//       recommendationCount
//     })
//   }
// }
import { PLAN_TIER, type Plan, type PlanTier } from '@family/contracts';

/**
 * Store product identifier → plan tier.
 *
 * Store products are named in App Store Connect and the Play Console, not in
 * this repo, so the mapping is data rather than code. The defaults follow the
 * `Plan` enum lower-cased, which is the convention the store listings are set
 * up with; `configureProductTiers` overrides it at startup from remote
 * configuration if the listings ever diverge.
 *
 * An unrecognised product is deliberately NOT guessed at — `toPlanOptions`
 * drops it. Showing a user a plan card whose tier we inferred wrongly would let
 * them buy something other than what the card described.
 */

export const DEFAULT_PRODUCT_TIERS: Readonly<Record<string, PlanTier>> = Object.fromEntries(
  (Object.keys(PLAN_TIER) as Plan[])
    .filter((plan) => plan !== 'FREE')
    .map((plan) => [plan.toLowerCase(), PLAN_TIER[plan]]),
);

let productTiers: Record<string, PlanTier> = { ...DEFAULT_PRODUCT_TIERS };

export function configureProductTiers(mapping: Record<string, PlanTier>): void {
  productTiers = { ...mapping };
}

export function getProductTiers(): Readonly<Record<string, PlanTier>> {
  return productTiers;
}

/** Ordering for the plan list: cheapest first, annual under monthly. */
export const TIER_DISPLAY_ORDER: readonly PlanTier[] = ['FREE', 'FAMILY', 'FAMILY_PLUS'];

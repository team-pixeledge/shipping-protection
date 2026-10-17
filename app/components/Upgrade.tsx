// "Available on Growth" — shown where a feature isn't on the shop's plan.
import { lowestPlanWith, type FeatureKey } from "../lib/plan";

/** A small badge next to a heading or setting. */
export function PlanBadge({ feature }: { feature: FeatureKey }) {
  return <s-badge tone="info">{`${lowestPlanWith(feature).name} plan`}</s-badge>;
}

/** A banner explaining what the feature does and where to get it. */
export function UpgradeNotice({ feature, children }: { feature: FeatureKey; children: React.ReactNode }) {
  const plan = lowestPlanWith(feature);
  return (
    <s-banner tone="info" heading={`Available on the ${plan.name} plan`}>
      <s-stack direction="block" gap="small-200">
        <s-text>{children}</s-text>
        <s-stack direction="inline" gap="small-200">
          <s-button href="/app/plan">Compare plans</s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}

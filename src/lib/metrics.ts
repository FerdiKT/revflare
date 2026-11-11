import type { Metric } from "@shared/types";

export const METRIC_INFO: Record<Metric, { label: string; description: string; stock?: boolean; invert?: boolean }> = {
  revenue: { label: "Revenue", description: "Gross sales (what customers paid), before Apple's commission and taxes." },
  proceeds: { label: "Proceeds", description: "What you receive: revenue after Apple's commission and taxes." },
  mrr: { label: "MRR", description: "Monthly recurring revenue of active paid subscriptions, normalized to a month.", stock: true },
  mrr_proceeds: { label: "MRR (proceeds)", description: "MRR after Apple's commission and taxes.", stock: true },
  arr: { label: "ARR", description: "Annual run rate: MRR × 12.", stock: true },
  active_subscriptions: { label: "Active subscriptions", description: "Paid subscriptions active at the end of each bucket.", stock: true },
  active_trials: { label: "Active trials", description: "Free trials running at the end of each bucket.", stock: true },
  new_subscriptions: { label: "New subscriptions", description: "First paid periods (including trial conversions)." },
  renewals: { label: "Renewals", description: "Paid renewals of existing subscriptions." },
  one_time_purchases: { label: "One-time purchases", description: "Non-subscription purchases (lifetime unlocks, consumables)." },
  trials_started: { label: "Trials started", description: "New free trials." },
  trial_conversions: { label: "Trial conversions", description: "Trials that turned into a paid subscription." },
  trial_conversion_rate: { label: "Trial conversion rate", description: "Converted trials ÷ trials that ended." },
  refunds: { label: "Refunds", description: "Number of refunded transactions.", invert: true },
  refunds_amount: { label: "Refunded amount", description: "Revenue refunded by Apple.", invert: true },
  refund_rate: { label: "Refund rate", description: "Refunds ÷ paid transactions.", invert: true },
  churn_rate: { label: "Churn rate", description: "Subscriptions that ended ÷ subscriptions active at the start.", invert: true },
  churned_subscriptions: { label: "Churned subscriptions", description: "Paid subscriptions that ended.", invert: true },
  new_customers: { label: "New customers", description: "Customers with their first purchase or trial." },
  arppu: { label: "ARPPU", description: "Average revenue per paying user." },
};

export const METRIC_GROUPS: Array<{ label: string; metrics: Metric[] }> = [
  { label: "Revenue", metrics: ["revenue", "proceeds", "arppu", "one_time_purchases"] },
  { label: "Recurring revenue", metrics: ["mrr", "mrr_proceeds", "arr"] },
  { label: "Subscriptions", metrics: ["active_subscriptions", "new_subscriptions", "renewals", "churned_subscriptions", "churn_rate"] },
  { label: "Trials", metrics: ["active_trials", "trials_started", "trial_conversions", "trial_conversion_rate"] },
  { label: "Refunds", metrics: ["refunds", "refunds_amount", "refund_rate"] },
  { label: "Customers", metrics: ["new_customers"] },
];

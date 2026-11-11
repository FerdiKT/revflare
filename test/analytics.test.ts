import { describe, expect, it } from "vitest";
import { ReportAggregator, aggregateTsv, reportDay, reportKind } from "../worker/apple/analytics";
import { responseLines } from "../worker/apple/connect";
import { metricsOf } from "../worker/lib/acquisition";

// Apple App Analytics reports: tab-separated files, one row per date and dimension combination (synthetic data).

const tsv = (head: string[], rows: (string | number)[][]) => [head.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n") + "\n";

describe("reportKind", () => {
  it("maps Apple's report names to the reports Revflare imports", () => {
    expect(reportKind("App Downloads Standard")).toBe("downloads");
    expect(reportKind("App Downloads Detailed")).toBe("downloads_detailed");
    expect(reportKind("App Store Discovery and Engagement Standard")).toBe("engagement");
    expect(reportKind("App Store Discovery and Engagement Detailed")).toBe("engagement_detailed");
    expect(reportKind("App Store Purchases Standard")).toBe("purchases");
    expect(reportKind("App Store Purchases Detailed")).toBe("purchases_detailed");
    expect(reportKind("App Sessions Standard")).toBeNull();
    expect(reportKind("App Store Installation and Deletion Standard")).toBeNull();
    expect(reportKind("App Downloads")).toBeNull();
  });
});

describe("reportDay", () => {
  it("reads ISO and US dates", () => {
    expect(reportDay("2026-10-09")).toBe("2026-10-09");
    expect(reportDay("2026-10-09T00:00:00Z")).toBe("2026-10-09");
    expect(reportDay("10/9/2026")).toBe("2026-10-09");
    expect(reportDay("")).toBeNull();
  });
});

describe("downloads report", () => {
  const head = ["Date", "App Name", "App Apple Identifier", "Download Type", "App Version", "Device", "Platform Version", "Source Type", "Source Info", "Campaign", "Page Type", "Page Title", "Pre-Order", "Territory", "Counts"];
  it("sums first-time downloads and redownloads by day, source type, referrer and campaign; drops updates", () => {
    const rows = aggregateTsv(
      "downloads",
      tsv(head, [
        ["2026-10-09", "Example", "1234567890", "First-time download", "1.0", "iPhone", "iOS 26.0", "App Store search", "", "", "Product page", "Default", "No", "US", 12],
        ["2026-10-09", "Example", "1234567890", "First-time download", "1.0", "iPad", "iOS 26.0", "App Store search", "", "", "Product page", "Default", "No", "DE", 3],
        ["2026-10-09", "Example", "1234567890", "Redownload", "1.0", "iPhone", "iOS 26.0", "App Store search", "", "", "Product page", "Default", "No", "US", 2],
        ["2026-10-09", "Example", "1234567890", "Manual update", "1.0", "iPhone", "iOS 26.0", "App Store search", "", "", "Product page", "Default", "No", "US", 40],
        ["2026-10-09", "Example", "1234567890", "Auto-update", "1.0", "iPhone", "iOS 26.0", "Unavailable", "", "", "No page", "", "No", "US", 99],
        ["2026-10-09", "Example", "1234567890", "First-time download", "1.0", "iPhone", "iOS 26.0", "Web referrer", "example.com", "launch_post", "Product page", "Default", "No", "US", 7],
        ["2026-10-10", "Example", "1234567890", "First-time download", "1.0", "iPhone", "iOS 26.0", "App referrer", "com.example.social", "null", "Store sheet", "", "No", "FR", 5],
      ]),
    );
    const byKey = Object.fromEntries(rows.map((r) => [`${r.day}|${r.sourceType}|${r.sourceInfo}|${r.campaign}`, r]));
    expect(rows).toHaveLength(3);
    expect(byKey["2026-10-09|App Store search||"]).toMatchObject({ downloads: 15, redownloads: 2, impressions: 0 });
    expect(byKey["2026-10-09|Web referrer|example.com|launch_post"]).toMatchObject({ downloads: 7, redownloads: 0 });
    expect(byKey["2026-10-10|App referrer|com.example.social|"]).toMatchObject({ downloads: 5 });
  });
});

describe("engagement report", () => {
  const head = ["Date", "App Name", "App Apple Identifier", "Event", "Page Type", "Source Type", "Engagement Type", "Device", "Platform Version", "Territory", "Counts", "Unique Counts"];
  it("counts impressions and page views (counts and unique counts); taps are left out", () => {
    const [r] = aggregateTsv(
      "engagement",
      tsv(head, [
        ["2026-10-09", "Example", "1234567890", "Impression", "No page", "App Store browse", "", "iPhone", "iOS 26.0", "US", 1000, 800],
        ["2026-10-09", "Example", "1234567890", "Impression", "No page", "App Store browse", "", "iPad", "iOS 26.0", "US", 200, 150],
        ["2026-10-09", "Example", "1234567890", "Page view", "Product page", "App Store browse", "", "iPhone", "iOS 26.0", "US", 90, 60],
        ["2026-10-09", "Example", "1234567890", "Tap", "No page", "App Store browse", "Get", "iPhone", "iOS 26.0", "US", 30, 30],
      ]),
    );
    expect(r).toMatchObject({ day: "2026-10-09", sourceType: "App Store browse", impressions: 1200, impressionsUnique: 950, pageViews: 90, pageViewsUnique: 60 });
  });
});

describe("purchases report", () => {
  const head = ["Date", "App Name", "App Apple Identifier", "Purchase Type", "Content Name", "Content Apple Identifier", "Payment Method", "Device", "Platform Version", "Source Type", "Page Type", "App Download Date", "Pre-Order", "Territory", "Purchases", "Proceeds in USD", "Sales in USD", "Paying Users"];
  it("sums purchases, proceeds and sales; refunds subtract", () => {
    const [r] = aggregateTsv(
      "purchases",
      tsv(head, [
        ["2026-10-09", "Example", "1234567890", "Auto-renewable subscription", "Pro", "1234567891", "Card", "iPhone", "iOS 26.0", "App Store search", "Product page", "2026-10-08", "No", "US", 3, 25.47, 29.97, 3],
        ["2026-10-09", "Example", "1234567890", "Auto-renewable subscription", "Pro", "1234567891", "Card", "iPhone", "iOS 26.0", "App Store search", "Product page", "", "No", "US", -1, -8.49, -9.99, 1],
      ]),
    );
    expect(r.purchases).toBe(2);
    expect(r.proceedsUsd).toBeCloseTo(16.98);
    expect(r.salesUsd).toBeCloseTo(19.98);
  });
});

describe("ReportAggregator", () => {
  it("merges segments, each with its own header line", () => {
    const head = ["Date", "Download Type", "Source Type", "Counts"];
    const agg = new ReportAggregator("downloads");
    for (const file of [tsv(head, [["2026-10-09", "First-time download", "App Store search", 4]]), tsv(["Source Type", "Date", "Download Type", "Counts"], [["App Store search", "2026-10-09", "First-time download", 6]])]) {
      agg.newFile();
      for (const l of file.split("\n")) agg.addLine(l);
    }
    expect(agg.result()).toEqual([expect.objectContaining({ day: "2026-10-09", sourceType: "App Store search", downloads: 10 })]);
  });
});

describe("responseLines", () => {
  it("gunzips and splits a segment into lines", async () => {
    const text = "Date\tCounts\r\n2026-10-09\t3\n2026-10-10\t4";
    const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const lines: string[] = [];
    for await (const l of responseLines(new Response(gz))) lines.push(l);
    expect(lines).toEqual(["Date\tCounts", "2026-10-09\t3", "2026-10-10\t4"]);
  });
});

describe("metricsOf", () => {
  it("computes conversion from unique page views and converts money", () => {
    const m = metricsOf({ impressions: 100, impressions_unique: 80, page_views: 50, page_views_unique: 40, downloads: 10, redownloads: 1, purchases: 2, proceeds_usd: 10, sales_usd: 12 }, 0.5);
    expect(m.conversionRate).toBe(0.25);
    expect(m.proceeds).toBe(5);
    expect(m.sales).toBe(6);
    expect(metricsOf({ impressions: 0, impressions_unique: 0, page_views: 0, page_views_unique: 0, downloads: 3, redownloads: 0, purchases: 0, proceeds_usd: 0, sales_usd: 0 }, 1).conversionRate).toBeNull();
  });
});

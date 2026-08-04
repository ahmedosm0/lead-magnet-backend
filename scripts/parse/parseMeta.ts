import { parseCsv, requireField, requireNumber, optionalNumber } from "../lib/csv.ts";
import type { ParsedMetaRow, MetaResultType } from "./types.ts";

export function parseMetaCsv(csvText: string, client: string): ParsedMetaRow[] {
  const context = `${client} Meta Ads Manager export`;
  const records = parseCsv(csvText);

  return records.map((record, index) => {
    const rowContext = `${context} (row ${index + 2})`;

    const purchaseValue = optionalNumber(record, "Purchase value", rowContext);
    const roas = optionalNumber(record, "Website purchase ROAS (return on ad spend)", rowContext);
    const costPerLead = optionalNumber(record, "Cost per lead", rowContext);

    let resultType: MetaResultType;
    if (requireField(record, "Purchases", rowContext).trim() !== "") {
      resultType = "purchase";
    } else if (requireField(record, "Leads", rowContext).trim() !== "") {
      resultType = "lead";
    } else {
      throw new Error(
        `${rowContext}: neither "Purchases" nor "Leads" is populated — can't tell what this campaign optimizes for`
      );
    }

    return {
      reportingStart: requireField(record, "Reporting starts", rowContext),
      reportingEnd: requireField(record, "Reporting ends", rowContext),
      campaignName: requireField(record, "Campaign name", rowContext),
      objective: requireField(record, "Objective", rowContext),
      deliveryStatus: requireField(record, "Delivery status", rowContext),
      attributionSetting: requireField(record, "Attribution setting", rowContext),
      amountSpent: requireNumber(record, "Amount spent (USD)", rowContext),
      impressions: requireNumber(record, "Impressions", rowContext),
      cpm: requireNumber(record, "CPM (cost per 1,000 impressions) (USD)", rowContext),
      reach: requireNumber(record, "Reach", rowContext),
      frequency: requireNumber(record, "Frequency", rowContext),
      linkClicks: requireNumber(record, "Link clicks", rowContext),
      cpc: requireNumber(record, "CPC (cost per link click) (USD)", rowContext),
      ctr: requireNumber(record, "CTR (link click-through rate)", rowContext),
      results: requireNumber(record, "Results", rowContext),
      resultIndicator: requireField(record, "Result indicator", rowContext),
      costPerResult: requireNumber(record, "Cost per results", rowContext),
      resultType,
      purchaseValue,
      roas,
      costPerLead,
    };
  });
}

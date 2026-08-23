/**
 * Maps BigQuery trial rows → dashboard payload (records + summary metrics).
 *
 * Field assumptions (confirm / override):
 * - Account name  → email (no company name in extract yet)
 * - Account UID   → companyid
 * - Trial type    → Enterprise if plan/type contains "enterprise", else Standard
 * - Trial segment → Returning if returning/reactivation flags truthy, else New
 * - AE name       → ae_owner_name → sfdc_owner_name → property_sales_team_owner
 * - Limit type    → Default = Enterprise trial (plan 1194); Custom = 1194→100 override
 * - Trial extension → current trial length > 14 days (standard trial), any plan type
 * - Converted     → CustomerTime present
 * - Status        → Converted | Cancelled | Ongoing | Expired
 * - Usage limit   → usage_limit_applied when present
 *
 * Grain is one row per companyid. The funnel extract is contact/email-level, so
 * the same company is collapsed here (and in SQL) to stop emails inflating counts.
 */
const { coerceNumber, coerceString, unwrapBqValue } = require("./bigquery");

/** Enterprise FUP default cap (doc: replace unlimited with 2,000). */
const ENTERPRISE_DEFAULT_USAGE_LIMIT = Number(
  process.env.ENTERPRISE_DEFAULT_USAGE_LIMIT || 2000
);
const STANDARD_DEFAULT_USAGE_LIMIT = Number(process.env.STANDARD_DEFAULT_USAGE_LIMIT || 500);

function toDateStr(value) {
  const raw = unwrapBqValue(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function truthyFlag(value) {
  const v = coerceString(value).trim().toLowerCase();
  if (!v) return false;
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

function trialType(row) {
  const selected =
    coerceString(row.plan_selected_new).trim() ||
    coerceString(row.property_c_plan_type).trim() ||
    coerceString(row.subscription_plan).trim();
  return selected.toLowerCase().includes("enterprise") ? "Enterprise" : "Standard";
}

function trialSegment(row) {
  if (truthyFlag(row.property_returning_trial_user_flag) || truthyFlag(row.property_trial_reactivation)) {
    return "Returning";
  }
  return "New";
}

function aeName(row) {
  const candidates = [
    coerceString(row.ae_owner_name).trim(),
    coerceString(row.sfdc_owner_name).trim(),
    coerceString(row.property_sales_team_owner).trim(),
  ];
  for (const name of candidates) {
    if (!name) continue;
    // HubSpot sometimes stores owner id in property_sales_team_owner
    if (/^\d+$/.test(name)) continue;
    return name;
  }
  return "Self Serve";
}

function isCancelledStatus(status) {
  const s = coerceString(status).toLowerCase();
  return (
    s.includes("cancel") ||
    s === "unpaid" ||
    s === "incomplete_expired" ||
    s === "paused"
  );
}

function latestTrialEnd(originalEnd, extendedEnd) {
  if (originalEnd && extendedEnd) return extendedEnd > originalEnd ? extendedEnd : originalEnd;
  return extendedEnd || originalEnd || null;
}

function deriveStatus(row, todayStr, effectiveEnd) {
  if (toDateStr(row.CustomerTime)) return "Converted";
  if (isCancelledStatus(row.subscription_status)) return "Cancelled";
  if (effectiveEnd && effectiveEnd >= todayStr) return "Ongoing";
  if (effectiveEnd && effectiveEnd < todayStr) return "Expired";
  return "Ongoing";
}

function dayDiff(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const a = new Date(startStr + "T00:00:00Z");
  const b = new Date(endStr + "T00:00:00Z");
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

function mapRow(row, index, todayStr) {
  const trialStart = toDateStr(row.TrialTime);
  const originalEnd = toDateStr(row.TrialEndTime);
  const closedWon = toDateStr(row.CustomerTime);
  const overrideDate = toDateStr(row.overriden_date);
  const limitOverridden =
    coerceNumber(row.limit_overriden_flag) === 1 || truthyFlag(row.limit_overriden_flag);

  const extendedEnd = toDateStr(row.ExtendedTrialEndTime);
  const extensionDate =
    toDateStr(row.latest_extension_at_date) ||
    toDateStr(row.extension_date) ||
    null;
  let additionalDays =
    row.additional_days_provided != null && row.additional_days_provided !== ""
      ? coerceNumber(row.additional_days_provided)
      : null;
  if (additionalDays == null && originalEnd && extendedEnd) {
    additionalDays = dayDiff(originalEnd, extendedEnd);
  }

  const originalDuration =
    row.trial_days_given != null && row.trial_days_given !== ""
      ? coerceNumber(row.trial_days_given)
      : dayDiff(trialStart, originalEnd);

  const effectiveEnd = latestTrialEnd(originalEnd, extendedEnd);
  const currentDuration =
    originalDuration != null && additionalDays != null
      ? originalDuration + additionalDays
      : dayDiff(trialStart, effectiveEnd) ?? originalDuration;

  const extendedDaysBeyond14 =
    currentDuration != null && Number.isFinite(currentDuration)
      ? Math.max(0, currentDuration - 14)
      : null;
  // Extended = basic 14-day trial was lengthened, for Standard and Enterprise alike.
  // Do not treat a 1194→100 FUP override as a trial-duration extension.
  const trialExtended = extendedDaysBeyond14 != null && extendedDaysBeyond14 > 0;
  if (trialExtended && (additionalDays == null || additionalDays <= 0)) {
    additionalDays = extendedDaysBeyond14;
  }

  const daysToConversion =
    row.trial_to_cust_days != null && row.trial_to_cust_days !== ""
      ? coerceNumber(row.trial_to_cust_days)
      : dayDiff(trialStart, closedWon);
  const mrr = coerceNumber(row.land_mrr) || coerceNumber(row.subscription_mrr) || 0;
  const converted = Boolean(closedWon);
  const status = deriveStatus(row, todayStr, effectiveEnd);
  const type = trialType(row);
  const ae = aeName(row);

  // Enterprise default = 2,000; Custom override enables Unlimited FUP (per product doc).
  let usageLimit = null;
  if (row.usage_limit_applied != null && row.usage_limit_applied !== "") {
    const raw = coerceString(row.usage_limit_applied).trim().toLowerCase();
    if (raw === "unlimited" || raw === "-1" || raw === "null") {
      usageLimit = "Unlimited";
    } else {
      usageLimit = coerceNumber(row.usage_limit_applied) || coerceString(row.usage_limit_applied);
    }
  } else if (limitOverridden) {
    usageLimit = "Unlimited";
  } else if (type === "Enterprise") {
    usageLimit = ENTERPRISE_DEFAULT_USAGE_LIMIT;
  } else {
    usageLimit = STANDARD_DEFAULT_USAGE_LIMIT;
  }

  const planSelected =
    coerceString(row.plan_selected_new).trim() ||
    coerceString(row.property_c_plan_type).trim() ||
    coerceString(row.subscription_plan).trim() ||
    type;
  const email = coerceString(row.email);
  const companyName =
    coerceString(row.company_name).trim() ||
    coerceString(row.companyName).trim() ||
    (email.includes("@") ? email.split("@")[1] : "") ||
    "";
  const limitType = limitOverridden
    ? "Custom"
    : type === "Enterprise"
      ? "Default"
      : "";

  return {
    id: `${coerceString(row.companyid) || "x"}-${trialStart || index}-${coerceString(row.opportunity_id) || index}`,
    accountName: email || coerceString(row.companyid) || "—",
    companyName: companyName || "—",
    accountUid: coerceString(row.companyid),
    email,
    opportunityId: coerceString(row.opportunity_id),
    trialType: type,
    planSelected,
    trialSegment: trialSegment(row),
    aeName: ae,
    contractCustomer: truthyFlag(row.is_contract) ? "Yes" : "No",
    trialStartDate: trialStart,
    originalTrialEndDate: originalEnd,
    originalTrialDurationDays: originalDuration,
    trialExtended: trialExtended ? "Yes" : "No",
    extensionDate,
    extendedByName: coerceString(row.extended_by_name).trim() || "",
    extendedTrialEndDate: extendedEnd,
    additionalDaysProvided: trialExtended ? additionalDays : null,
    currentTotalTrialDurationDays: currentDuration,
    extendedDaysBeyond14,
    currentTrialEndDate: effectiveEnd,
    currentTrialStatus: status,
    usageLimitApplied: usageLimit,
    limitType,
    limitOverridden: limitOverridden ? "Yes" : "No",
    limitOverrideDate: overrideDate,
    planUpdatedByName: coerceString(row.overriden_by_name).trim() || "",
    convertedToPaid: converted ? "Yes" : "No",
    closedWonDate: closedWon,
    mrrGenerated: converted ? mrr : 0,
    daysTrialToClosedWon: converted ? daysToConversion : null,
    aeConversionOwner: converted ? ae : "",
    subscriptionStatus: coerceString(row.subscription_status),
    closedByMotion: coerceString(row.closed_by_motion),
  };
}

function avg(nums) {
  const vals = nums.filter((n) => n != null && Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function buildSummary(records) {
  const total = records.length;
  const ongoing = records.filter((r) => r.currentTrialStatus === "Ongoing").length;
  const extended = records.filter((r) => r.trialExtended === "Yes").length;
  const converted = records.filter((r) => r.convertedToPaid === "Yes");
  const convertedCount = converted.length;
  const totalMrr = converted.reduce((s, r) => s + (r.mrrGenerated || 0), 0);
  const conversionRate = total ? (convertedCount / total) * 100 : 0;

  return {
    totalTrialsStarted: total,
    ongoingTrials: ongoing,
    trialsExtended: extended,
    trialsConverted: convertedCount,
    trialToPaidConversionRate: Math.round(conversionRate * 10) / 10,
    totalMrrGenerated: Math.round(totalMrr * 100) / 100,
    avgOriginalTrialDurationDays:
      Math.round((avg(records.map((r) => r.originalTrialDurationDays)) || 0) * 10) / 10,
    avgFinalTrialDurationDays:
      Math.round((avg(records.map((r) => r.currentTotalTrialDurationDays)) || 0) * 10) / 10,
    avgDaysTrialToConversion:
      Math.round((avg(converted.map((r) => r.daysTrialToClosedWon)) || 0) * 10) / 10,
  };
}

function betterRecord(a, b) {
  if ((a.convertedToPaid === "Yes") !== (b.convertedToPaid === "Yes")) {
    return a.convertedToPaid === "Yes" ? a : b;
  }
  const aStart = a.trialStartDate || "";
  const bStart = b.trialStartDate || "";
  if (aStart !== bStart) return aStart > bStart ? a : b;
  if (Boolean(a.aeName) !== Boolean(b.aeName)) return a.aeName ? a : b;
  if ((a.trialExtended === "Yes") !== (b.trialExtended === "Yes")) {
    return a.trialExtended === "Yes" ? a : b;
  }
  const aMrr = Number(a.mrrGenerated) || 0;
  const bMrr = Number(b.mrrGenerated) || 0;
  if (aMrr !== bMrr) return aMrr > bMrr ? a : b;
  return a;
}

function dedupeByCompanyId(records) {
  const map = new Map();
  let missing = 0;
  for (const record of records) {
    const key = String(record.accountUid || "").trim();
    if (!key) {
      missing += 1;
      map.set(`missing-${missing}-${record.id}`, record);
      continue;
    }
    const prev = map.get(key);
    map.set(key, prev ? betterRecord(prev, record) : record);
  }
  return [...map.values()];
}

function filterOptions(records) {
  const aes = [...new Set(records.map((r) => r.aeName).filter(Boolean))].sort();
  const types = [...new Set(records.map((r) => r.trialType))].sort();
  const statuses = [...new Set(records.map((r) => r.currentTrialStatus))].sort();
  const limitTypes = [...new Set(records.map((r) => r.limitType).filter((v) => v === "Default" || v === "Custom"))].sort();
  return { aeNames: aes, trialTypes: types, trialStatuses: statuses, limitTypes };
}

function buildPayload(rows, opts = {}) {
  const errors = [];
  const warnings = [];
  const todayStr = opts.today || new Date().toISOString().slice(0, 10);

  if (!Array.isArray(rows)) {
    return { payload: null, checks: { ok: false, errors: ["rows is not an array"], warnings } };
  }

  const records = dedupeByCompanyId(rows.map((r, i) => mapRow(r, i, todayStr)));

  const companyIds = records.map((r) => String(r.accountUid || "").trim()).filter(Boolean);
  if (new Set(companyIds).size !== companyIds.length) {
    warnings.push("Duplicate company ids remain after email collapse");
  }

  const enterpriseMissingAe = records.filter(
    (r) => r.trialType === "Enterprise" && !r.aeName
  ).length;
  if (enterpriseMissingAe > 0) {
    warnings.push(`${enterpriseMissingAe} Enterprise trial(s) missing AE name`);
  }

  if (records.length === 0) {
    warnings.push("Extract returned 0 rows");
  }

  const summary = buildSummary(records);
  const filters = filterOptions(records);

  const payload = {
    generatedAt: new Date().toISOString(),
    asOfDate: todayStr,
    demoMode: Boolean(opts.demoMode),
    rowCount: records.length,
    summary,
    filters,
    records,
    fieldNotes: {
      accountName: "Mapped from email until company name is added to the extract",
      companyName: "Email domain fallback until company name is in the extract",
      extendedDaysBeyond14: "current total trial days minus 14 (standard trial length)",
      trialInstance: "One row per companyid — multiple emails on the same company are collapsed",
      aeName:
        "From extract: ae_owner_name → SFDC owner name (SDR/BDR/PS/AE) → property_sales_team_owner → Self Serve",
      extensionDate: "Latest DATE(extended_at) from jc_mastermind.trial_extension per companyid",
      extendedByName: "adminpanel.name joined on trial_extension.extended_by",
      planSelected:
        "plan_selected_new: if is_contract then property_c_plan_type → subscription_plan; else changeplan → property_c_plan_type → subscription_plan",
      planUpdatedByName: "adminpanel.name joined on upgradeDowngradeLogs.mmadminid (1194→100)",
      contractCustomer: "Yes/No from is_contract on int_licence_final_mrr (false when unmatched)",
      trialExtended:
        "Yes when current trial duration is greater than 14 days, for any trial type",
      limitOverridden: "Custom = upgradeDowngradeLogs 1194→100 (enterprise FUP made custom)",
      usageLimitApplied:
        `Enterprise Default = ${ENTERPRISE_DEFAULT_USAGE_LIMIT}; Custom override → Unlimited (Sales managers: Vedant, Sandeep, Manpreet)`,
      limitType: "Default = Enterprise trial on plan 1194; Custom = enterprise made custom (plan 100)",
      currentTrialEndDate: "Latest of original end and extended end",
      demoMode: "DEMO_MODE=1 serves synthetic accounts — AE names are blank until BigQuery is connected",
    },
  };

  return {
    payload,
    checks: { ok: errors.length === 0, errors, warnings },
  };
}

module.exports = { buildPayload, mapRow, buildSummary };

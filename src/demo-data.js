/**
 * Synthetic tracker rows for local UI review when DEMO_MODE=1.
 * Shape matches the extract: change rows only, and the live Salesforce
 * userid measures are filled only on the latest date.
 */
function buildDemoRows() {
  const latest = "2026-11-11";

  const companies = [
    {
      companyid: 10421,
      status: "active",
      from: "Pro",
      to: "Proplus",
      users: [8, 9, 9, 11],
      sf: [2, 2, 3, 3],
      license: 12,
      prevSf: 2,
      latestAll: 4,
      latestActive: 3,
      latestInactive: 1,
    },
    {
      companyid: 11008,
      status: "active",
      from: "Essential",
      to: "Essential",
      users: [4, 4, 6, 6],
      sf: [1, 1, 1, 1],
      license: 6,
      prevSf: 1,
      latestAll: 2,
      latestActive: 1,
      latestInactive: 1,
    },
    {
      companyid: 11880,
      status: "active",
      from: "Proplus",
      to: "Business",
      users: [20, 20, 18, 18],
      sf: [6, 6, 6, 5],
      license: 20,
      prevSf: 6,
      latestAll: 7,
      latestActive: 5,
      latestInactive: 2,
    },
    {
      companyid: 12114,
      status: "trialing",
      from: "Pro",
      to: "Pro",
      users: [2, 3, 3, 5],
      sf: [1, 1, 1, 1],
      license: 5,
      prevSf: 0,
      latestAll: 1,
      latestActive: 1,
      latestInactive: 0,
    },
    {
      companyid: 13002,
      status: "past_due",
      from: "Business",
      to: "Pro",
      users: [15, 15, 15, 14],
      sf: [4, 4, 4, 4],
      license: 15,
      prevSf: 4,
      latestAll: 4,
      latestActive: 4,
      latestInactive: 0,
    },
    {
      companyid: 14077,
      status: "canceled",
      from: "Proplus",
      to: "Proplus",
      users: [7, 7, 1, 0],
      sf: [3, 3, 0, 0],
      license: 0,
      prevSf: 2,
      latestAll: 2,
      latestActive: 0,
      latestInactive: 2,
    },
  ];

  const dates = ["2026-11-08", "2026-11-09", "2026-11-10", latest];
  const rows = [];

  for (const company of companies) {
    for (let i = 1; i < dates.length; i += 1) {
      const date = dates[i];
      const isLatest = date === latest;
      const previousUsers = company.users[i - 1];
      const currentUsers = company.users[i];
      const userDiff = currentUsers - previousUsers;
      const previousPlan = i === 1 ? company.from : company.to;
      const currentPlan = company.to;
      const planChanged = previousPlan !== currentPlan ? 1 : 0;
      const sfChanged = isLatest && company.latestActive !== company.prevSf ? 1 : 0;
      const licenseChanged = isLatest && company.license !== company.latestAll ? 1 : 0;

      const row = {
        date,
        companyid: company.companyid,
        company_status: company.status,
        previous_day_plan: previousPlan,
        current_day_plan: currentPlan,
        plan_change_flag: planChanged,
        current_active_users: currentUsers,
        current_total_license: isLatest ? company.license : null,
        latest_integrations: isLatest ? company.latestAll : null,
        latest_active_users_integrations: isLatest ? company.latestActive : null,
        latest_inactive_users_integrations: isLatest ? company.latestInactive : null,
        previous_day_active_users_integrations: isLatest ? company.prevSf : null,
        active_sfuserids_change_flag: sfChanged,
        license_integrations_flag: licenseChanged,
      };

      if (
        row.plan_change_flag === 1 ||
        userDiff !== 0 ||
        row.active_sfuserids_change_flag === 1 ||
        row.license_integrations_flag === 1
      ) {
        rows.push(row);
      }
    }
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.companyid - b.companyid;
  });
  return rows;
}

module.exports = { buildDemoRows };

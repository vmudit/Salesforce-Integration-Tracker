# Project input

Source: [Trial extension dashboard](https://docs.google.com/document/d/1sSDRSGHBQLwBuGpfcjX5VNewUZUhFZ3Z9CZaxXntKLY/edit?usp=sharing)

## Objective

Create a dashboard that provides account-level visibility into every trial. The dashboard should help track:

- Original trial setup
- Extensions or limit overrides
- Current status
- Revenue generated after conversion

Each trial instance should appear as a separate record so that repeat trials are not overwritten.

## Fields required

### Account details

- Account name
- Account UID
- Trial type: Standard or Enterprise
- Trial segment: New (first-time trial) or Returning
- AE name (required for Enterprise trials)

### Trial duration

- Trial start date
- Original trial end date
- Original trial duration (days)
- Trial extended: Yes or No
- Extension date
- Extended trial end date
- Number of additional days provided
- Current total trial duration
- Current trial status: Ongoing, Expired, Converted, or Cancelled

### Trial limits

- Usage limit applied
- Limit type: Default or Custom
- Limit overridden: Yes or No
- Date of limit override (if applicable)

**Enterprise FUP change:** default usage cap is **2,000** (replacing unlimited). Designated Sales managers (Vedant, Sandeep, Manpreet) can override to unlimited FUP for genuine customer cases.

### Conversion details

- Converted to paid: Yes or No
- Closed-won date
- MRR generated
- Days from trial start to closed-won
- AE name responsible for conversion (if applicable)

## Filters

- Trial start-date range
- Trial type
- Trial status
- Extended vs non-extended trials
- Default vs custom limits
- AE name
- Converted vs non-converted trials

## Summary metrics

- Total trials started
- Ongoing trials
- Trials extended
- Trials converted
- Trial-to-paid conversion rate
- Total MRR generated
- Average original and final trial duration
- Average days from trial start to conversion

## Acceptance criteria

- Each trial instance appears as a separate record.
- Original dates and limits remain available after an extension or override.
- The latest trial end date and current status are clearly shown.
- AE name is available for every Enterprise trial.
- Closed-won date, MRR, and time to conversion are captured for converted trials.
- Dashboard data updates automatically without requiring manual input.
- All listed filters and summary metrics are available.

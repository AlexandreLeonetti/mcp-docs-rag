---
title: Postmortem 2025-11 Login Outage
doc_type: postmortem
department: incidents
updated_at: 2025-11-21
tags: [postmortem, login, sso]
---
# Postmortem — Login Outage, November 2025

## Root Cause
A recently deployed redirect rule introduced a loop for a subset of SSO configurations.

## Contributing Factors
- insufficient tenant-specific regression testing
- limited alerting on redirect anomalies

## Follow-up Actions
- add regression coverage for tenant-specific SSO flows
- improve incident timeline summaries
- update support macros for login outage communication

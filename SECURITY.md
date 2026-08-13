# Security Policy

## Supported versions

LiveView is pre-1.0. Security fixes are applied to the latest revision of the
default branch; older snapshots are not maintained as separate release lines.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use the
repository's **Security** tab to submit a private vulnerability report. If that
facility is unavailable, contact a maintainer privately through the contact
method published on their GitHub profile.

Include the affected revision, reproduction steps, expected impact, and any
known mitigations. Please avoid accessing data that is not yours or disrupting
a deployment while validating a report.

## Deployment scope

LiveView does not provide user accounts or multi-user authorization.
Internet-facing operators must place it behind a trusted authentication and TLS
boundary and restrict PostgreSQL and object-storage access independently. Exact
CORS origins and an optional proxy-injected bearer token provide defense in
depth; they are not a replacement for an identity-aware access layer.

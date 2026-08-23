# Pacific Resilience Platform — Product Charter

## Mission

Build a vendor-neutral, offline-first energy and resilience platform for remote
and island communities, beginning with private homes, rental properties,
installers, and small commercial sites in Saipan, CNMI.

The platform should make mixed-brand electrical systems understandable even
when the supplied hardware has fragmented or poor software.

## Initial problem

Property owners, tenants, installers, and DIY energy users need a trustworthy
way to understand:

- Whether power is coming from the utility, a generator, solar, or a battery
- Whether voltage and frequency are stable
- How much energy each site, circuit, appliance, or tenant uses
- How utility rates and fuel-adjustment charges affect cost
- Whether solar and battery systems produce real savings
- How long critical loads can operate on backup power
- When outages, transfers, abnormal-voltage events, and maintenance occurred
- Which readings are measured, imported, manual, inferred, estimated, or
  simulated

Closed vendor applications and disconnected analog equipment do not provide a
single reliable operational record.

## Initial customers

The first market is:

- Homeowners and tenants
- Apartment and rental-property owners
- Property managers
- Solar and battery installers
- Electricians and generator operators
- Small commercial sites
- Experienced DIY energy users

The initial business must not depend on a municipal utility procurement cycle.
Utilities may become later enterprise customers after private-site deployments
prove the platform.

## Site 001

The first development model is a two-bedroom Saipan apartment with:

- CUC utility power
- A building automatic transfer switch and temporary generator service
- An apartment electrical panel
- An Anker SOLIX battery system
- A standalone refrigerator and Starlink as critical loads
- Intermittent utility outages and source transfers
- Older electrical infrastructure

Site 001 is a software and telemetry test environment. It does not authorize
automatic control of the utility, generator, transfer switch, or breakers.

## First vertical slice

The first working slice should use a telemetry simulator before real hardware.
It should:

1. Represent one organization and Site 001.
2. Simulate voltage, frequency, site load, refrigerator load, Starlink load,
   battery state of charge, and current energy source.
3. Publish a normalized telemetry envelope.
4. Buffer data locally during a connection loss.
5. Synchronize without duplicate records.
6. Detect outage and restoration events.
7. Display a responsive site dashboard.
8. Label simulated and measured data clearly.
9. Preserve an audit trail for configuration changes.

## Product principles

- One shared platform, multiple products
- Vendor-neutral adapters
- Offline-first edge collection
- Human operators remain responsible for critical actions
- Monitoring and recommendations before control
- Explicit data provenance
- Security and tenant isolation by default
- Reusable capabilities instead of one-off customer code
- Verified integrations only

## Non-goals for the first release

- Utility billing-system integration
- Automated tenant billing or legally binding resale calculations
- Automatic control of breakers, generators, transfer switches, or grid assets
- Nuclear or microreactor control
- Native mobile applications
- Kubernetes or complex cloud infrastructure
- Unsupported production integrations obtained through reverse engineering
- Manufacturing proprietary monitoring hardware

## Long-term path

Start with property energy visibility and resilience monitoring. Expand into
installer tools, portfolio and tenant energy management, field operations,
generator and microgrid monitoring, and eventually utility and critical-
infrastructure operations.

The enduring asset is the normalized data, offline edge layer, integration
framework, operational workflows, and trusted record across mixed equipment.

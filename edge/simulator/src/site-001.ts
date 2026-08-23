/**
 * Site 001 model constants.
 *
 * Every electrical figure here is an **unverified placeholder**. Nothing at Site
 * 001 has been verified — see docs/product/site-001-profile.md — so these values
 * exist to make the simulator plausible, not to describe the real site. They are
 * expressed so that a single correction propagates: thresholds elsewhere are
 * fractions of nominal, and load figures are named constants.
 */

export const SITE_001 = {
  siteId: "site_001",
  gatewayId: "gw_001_1",
  sources: {
    panel: "src_001_sim_panel",
    battery: "src_001_sim_battery",
    refrigerator: "src_001_sim_fridge",
    starlink: "src_001_sim_starlink",
  },
} as const;

/**
 * UNVERIFIED — decision D13. Pending a CUC service document, the apartment panel
 * label, or a calibrated meter reading.
 */
export const NOMINAL = {
  voltageV: 120,
  frequencyHz: 60,
} as const;

/**
 * UNVERIFIED — plausible load figures for a two-bedroom apartment. The
 * refrigerator cycles; the Starlink terminal is close to constant and is also the
 * site uplink.
 */
export const LOADS = {
  refrigeratorRunningW: 120,
  refrigeratorIdleW: 2,
  refrigeratorDutyCycle: 0.35,
  refrigeratorPeriodMs: 30 * 60 * 1000,
  starlinkW: 55,
  householdBaseW: 180,
} as const;

/** Jitter half-widths, so successive ticks are not artificially identical. */
export const JITTER = {
  voltageV: 1.4,
  frequencyHz: 0.05,
  refrigeratorW: 4,
  starlinkW: 3,
  householdW: 25,
} as const;

/**
 * The Northvane Mutual demo records.
 *
 * Flat JSON on disk rather than a database, because five files is the whole
 * dataset and a migration would buy nothing. Every value is fictional. There
 * is no real policyholder, claim, vehicle or lender behind any of it.
 *
 * These numbers are load-bearing: the settlement engine reconciles against
 * them and the on-screen breakdown has to sum to the figure the agent says
 * out loud. They were copied from the spec rather than retyped.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export interface Policy {
  policy_id: string;
  holder_name: string;
  phone: string;
  state: string;
  coverages: string[];
  deductible_collision: number;
  rental_days_allowed: number;
  rental_days_used: number;
  effective_from: string;
  effective_to: string;
}

export interface Claim {
  claim_id: string;
  policy_id: string;
  vin: string;
  loss_date: string;
  quote_date: string;
  repair_estimate: number;
  shop_name: string;
  yard_id: string;
  storage_per_day: number;
  storage_start: string;
  status: string;
  adjuster: string;
}

export interface Lien {
  lender: string;
  loan_id: string;
  principal: number;
  principal_as_of: string;
  per_diem: number;
  good_through: string;
}

export interface Vehicle {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  condition_grade: string;
  options: Array<{ name: string; value: number }>;
  prior_damage: Array<{ desc: string; deduction: number }>;
  lien: Lien;
  salvage_bid: number;
}

export interface Comp {
  comp_id: string;
  vin_ref: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  list_price: number;
  distance_mi: number;
  source: string;
  listed_on: string;
}

export interface StateRule {
  state: string;
  total_loss_threshold_pct: number;
  sales_tax_pct: number;
  title_fee: number;
  reg_fee: number;
  tax_reimbursed_on_total_loss: boolean;
  offer_validity_days: number;
  salvage_retention_allowed: boolean;
  lien_consent_required: boolean;
  mileage_adjustment_per_mile: number;
  note: string;
}

// Five lanes read these concurrently, so each file is parsed once.
const cache = new Map<string, unknown>();

function load<T>(file: string): T {
  const hit = cache.get(file);
  if (hit !== undefined) return hit as T;

  const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as T;
  cache.set(file, parsed);
  return parsed;
}

export const loadPolicy = (): Policy => load<Policy>('policy.json');
export const loadClaim = (): Claim => load<Claim>('claim.json');
export const loadVehicle = (): Vehicle => load<Vehicle>('vehicle.json');
export const loadComps = (): Comp[] => load<Comp[]>('comps.json');
export const loadStateRules = (): StateRule => load<StateRule>('state_rules.json');

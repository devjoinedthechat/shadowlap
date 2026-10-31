/**
 * Each billed job's estimate before it runs, one helper per kind (A15), and Spending, the rule that
 * decides when a job asks first. The dashboard's server works them out from a recording's calls and
 * the reports the store keeps; its pages and the terminal UI say them in the words here.
 */
export { liveFrom, modelFactor, noEstimate, noPriceWords, pricedCalls, probedCalls, recordEstimate, scopeHolds, spentLive, timesWords, type Estimate, type EstimateKind, type LiveCost, type PriceOptions, type PricedCall, type Prices } from './estimate.js';
export { amountWords, askWords, asksFirst, costLine, costWords, drawerCost, heldAmount, parseSpending, priceWords, SPENDING_DEFAULT, SPENDING_MAX, SPENDING_PICKS, SPENDING_REFUSED, spendingField, spendingUsd, spendingWords, validSpending, type CostShown, type Spending } from './spending.js';
export { forkEstimate, plantEstimate, PLANT_REPEAT, repeatEstimate, REPEAT_TIMES, type ForkChange } from './fork.js';
export { BLAME_SCAN, blameBound, blameEstimate, type BlameBound, type BlameEstimateOptions, type BlameRule } from './blame.js';
export { VERIFY_LIVE, verifyCeiling, verifyEstimate, verifyLimits, verifyMoreEstimate, verifyParts, verifyRunCosts, type VerifyEstimateOptions, type VerifyLimits, type VerifyRule, type VerifyRunCost } from './verify.js';
export { REPAIR_CANDIDATES, REPAIRER_LIMITS, repairerBound, repairEstimate, type NoFixToTry, type RepairPlan, type RepairRun } from './repair.js';
export { bisectCommits, bisectEstimate, goldenTestEstimate, moreEstimate, runBisectEstimate, testsEstimate, updateEstimate, type SessionResult } from './tests.js';
export { CLEAN_GATE, causeEstimate, injectionAgainEstimate, injectionEstimate, presetsEstimate, type InjectionPlan } from './injection.js';
export { decisionRunCost, MIGRATE_SAMPLES, migrateEstimate, PREVIEW_SAMPLES, previewEstimate, previewFrom, type MigratePlan, type PreviewChange, type PreviewOptions } from './changes.js';

#!/usr/bin/env bun
/**
 * Stamp `series_identity` on a report's trial-outcomes JSONL (the pass-rates
 * history key: a hash of each case's own touchfiles, GLOBAL_TOUCHFILES
 * excluded; scripts/eval-flake-rank.ts caseSeriesIdentities). A separate step
 * after `test-paid-shards.ts --report`, so the paid runner's closure never
 * imports the history tool.
 *
 * Usage: bun run scripts/eval-trial-series.ts <trial-outcomes.jsonl>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { caseSeriesIdentities } from './eval-flake-rank';
import { formatTrialOutcomes, parseTrialOutcomes } from '../test/helpers/eval-store';

const ROOT = path.resolve(import.meta.dir, '..');

/** Rewrite the file with every record stamped; an invalid line fails the whole stamp. */
export function stampTrialSeries(file: string, root = ROOT): number {
  const { records, errors } = parseTrialOutcomes(fs.readFileSync(file, 'utf8'));
  if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
  const identities = caseSeriesIdentities([...new Set(records.map(record => record.case))], root);
  const stamped = records.map(record => ({ ...record, series_identity: identities[record.case] }));
  fs.writeFileSync(file, formatTrialOutcomes(stamped));
  return stamped.length;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: bun run scripts/eval-trial-series.ts <trial-outcomes.jsonl>');
    process.exit(2);
  }
  console.log(`[eval-trial-series] stamped ${stampTrialSeries(file)} record(s) in ${file}`);
}

/**
 * Scenario suite driver.
 *
 * The scenarios themselves live in `tests/lib/scenarios.ts` (shared with the report), so this
 * file only decides pass/fail and prints the trail.
 */
import { runAll, SCENARIOS } from './lib/scenarios';

const results = runAll();
const groups = [...new Set(SCENARIOS.map((scenario) => scenario.group))];

for (const group of groups) {
  console.log(`\n${group}`);
  for (const { scenario, outcome, ok } of results.filter(
    (result) => result.scenario.group === group,
  )) {
    const icon = ok ? '\u2713' : '\u2717';
    const expectation =
      scenario.expect === 'error' ? 'rejected' : scenario.expect === 'ok' ? 'accepted' : scenario.expect;
    console.log(`  ${icon} ${scenario.name} [${expectation}]${ok ? '' : ` -> got ${outcome.outcome}`}`);
    if (!ok) console.log(`      ${outcome.notes}`);
  }
}

const failed = results.filter((result) => !result.ok);
const passed = results.length - failed.length;
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${passed}/${results.length} scenarios passed`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const { scenario, outcome } of failed) {
    console.log(`  - ${scenario.name}: expected ${scenario.expect}, got ${outcome.outcome} (${outcome.notes})`);
  }
}
process.exit(failed.length === 0 ? 0 : 1);

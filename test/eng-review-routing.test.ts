import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateBrainWriteBack } from '../scripts/resolvers/gbrain';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';
import { generateTestCoverageAuditPlan, generateTestCoverageAuditShip } from '../scripts/resolvers/testing';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ENG_REVIEW_EXCERPT } from './helpers/workflow-excerpt';

const entry = readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8');
const section = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
const compact = (text: string) => text.replace(/\s+/g, ' ');

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

function ordered(text: string, stages: string[]) {
  const positions = stages.map(stage => text.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

const scope = section.split('## Scope Challenge\n')[1]?.split('## Review Sections')[0] ?? '';
const assessment = scope.split('### A. Assess the target')[1]?.split('### B. Resolve complexity selectors')[0] ?? '';
const complexity = scope.split('### B. Resolve complexity selectors')[1]?.split('### C. Resolve findings')[0] ?? '';
const findings = scope.split('### C. Resolve findings')[1] ?? '';
const recovery = entry.split('## Recovery routing')[1]?.split('{{EXIT_PLAN_MODE_GATE}}')[0] ?? '';

describe('engineering review routing contracts', () => {
  test('the bounded engineering excerpt includes the recovery rules it references', () => {
    const excerpt = between(entry, ENG_REVIEW_EXCERPT.startMarker, ENG_REVIEW_EXCERPT.endMarker);
    ordered(excerpt, ['{{SECTION:review-sections}}', '## Recovery routing', '**Paused question:**',
      '**Repairable write/read failure:**', '**Late change or missing work:**', '**Blocked outcome:**']);
    expect(compact(entry.slice(entry.indexOf(ENG_REVIEW_EXCERPT.endMarker)))).toMatch(/use Recovery routing above/i);
  });

  test('preparation establishes permission and evidence before applying review rules', () => {
    ordered(section, ['## Review preparation', '## Review record and write policy', '{{LEARNINGS_SEARCH}}',
      '## Retrospective learning', '{{CONFIDENCE_CALIBRATION}}', '## Decision procedure',
      '## Scope Challenge', '### A. Assess the target', '### B. Resolve complexity selectors',
      '### C. Resolve findings', '### 1. Architecture review']);
    expect(entry).toMatch(/keep the reviewed target fixed/i);
  });

  test('compression cannot remove mandatory review stages', () => {
    const priority = between(entry, '## Priority hierarchy', '## My engineering preferences');
    expect(compact(priority)).toMatch(/complete every required stage, decision gate and output/i);
    expect(priority).not.toContain('Everything else');
  });

  test('Scope Challenge has one named route and completes its assessments before writing', () => {
    expect([...scope.matchAll(/^### (.+)$/gm)].map(match => match[1])).toEqual([
      'A. Assess the target', 'B. Resolve complexity selectors', 'C. Resolve findings',
    ]);
    expect([...assessment.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(match => match[1])).toEqual(expect.arrayContaining([
      'What already solves each sub-problem?', 'What minimum changes achieve the goal?',
      'Complexity check:', 'Search check:', 'TODOS cross-reference:', 'Completeness check:', 'Distribution check:',
    ]));
    expect(compact(assessment)).toMatch(/do not apply scope changes or write findings into the plan yet/i);
    expect(scope).not.toContain('Below the threshold, start at step 1');
  });

  test('below-threshold route skips selectors, never findings or remedy approvals', () => {
    expect(compact(complexity)).toMatch(/fewer than 8 files AND fewer than 2 new classes\/services, skip B's questions/i);
    expect(findings).toMatch(/run C whether B was completed or skipped/i);
    ordered(compact(findings), ['1. Present', '2. Resolve each remedy through Decision procedure', '3. Report',
      'Continue to Section 1 only when no answer is pending']);
    expect(findings).toMatch(/approve no remedies/i);
    expect(findings).toContain('"No issues found"');
  });

  test('high complexity stops before Section 1 and asks cuts and structure separately', () => {
    expect(compact(complexity)).toMatch(/at 8\+ files or 2\+ new classes\/services, stop before section 1/i);
    ordered(compact(complexity), ['1. Explain the complexity', 'Ask each proposed feature cut/deferral separately',
      '2. Always ask the structure question', '3. Save the actual feature and structure answers']);
    expect(compact(complexity)).toContain('Pending remedies not decided here: <ids>');
  });

  test('no safe smaller arrangement does not authorize scope cuts or bypass the pause', () => {
    ordered(compact(complexity), ['If no smaller arrangement preserves these commitments',
      'A pause leaves the arrangement undecided', 'Do not continue to C until it is settled']);
    expect(compact(complexity)).toMatch(/do not continue to C until it is settled/i);
    expect(compact(complexity)).toMatch(/investigate only the agreed question/i);
  });

  test('selector answers are saved and verified before scope changes apply', () => {
    const summary = compact(complexity.slice(complexity.indexOf('3. Save the actual')));
    ordered(summary, ['feature answers: <refs>; structure: <A/B + ref>; accepted scope: <exact scope>; pending remedies: <ids or none>',
      'Read it back', 'apply only accepted scope changes', 'Continue to **C. Resolve findings**']);
    expect(summary).toMatch(/a failed save or read blocks advancement/i);
    expect(summary).toContain('**not persisted**');
    expect(compact(section)).toMatch(/these selections approve no engineering remedy/i);
  });

  test('engineering remedies are saved, asked once, and recorded before the next choice', () => {
    const procedure = between(section, '## Decision procedure', '## Scope Challenge');
    ordered(procedure, ['**Compare one choice.**', '**Pending-record checkpoint.**', '### Send once and wait',
      'AskUserQuestion({ questions: [currentDecision] })', '### Record the answer', 'For the next choice']);
    expect(between(procedure, '### Send once and wait', '### Record the answer')).toMatch(/stop until the actual answer arrives/i);
    expect(compact(procedure)).toMatch(/approves no implementation, including a conditional fix/i);
    expect(compact(procedure)).toMatch(/do not apply a remedy[^.]*call ExitPlanMode while the choice awaits an answer/i);
    const questions = generateAskUserFormat({ skillName: 'plan-eng-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext);
    expect(questions).toContain('10 = complete, 7 = happy path, 3 = shortcut');
    expect(questions).toContain('Note: options differ in kind, not coverage — no completeness score.');
  });

  test('unavailable research preserves an explicit coverage limit and continues review', () => {
    expect(compact(assessment)).toContain('"Search unavailable — proceeding with in-distribution knowledge only."');
    const outside = between(section, '### Continue after Outside Voice', '### TODOS.md updates');
    expect(compact(outside)).toMatch(/only completed reviews enter cross-model tension/i);
    expect(section).toContain('Outside voice: recorded provider, completed / unavailable / disabled / skipped (reason)');
    ordered(compact(outside), ['TODO choices', 'Approval readiness', 'Required outputs']);
  });

  test('paused transport and failed persistence have distinct non-success outcomes', () => {
    const pause = between(recovery, '**Paused question:**', '**Repairable write/read failure:**');
    expect(pause).toMatch(/without completion telemetry or ExitPlanMode/i);
    expect(compact(pause)).toMatch(/still pending; do not resend it/i);
    const failure = compact(between(recovery, '**Repairable write/read failure:**', '**Late change or missing work:**'));
    expect(failure).toMatch(/stop before the dependent question or output/i);
    expect(failure).toContain('follow **Blocked outcome**');
    expect(failure).toMatch(/never turn a failed permitted save into a chat-only success/i);
    const policy = compact(between(section, '## Review record and write policy', '{{LEARNINGS_SEARCH}}'));
    expect(policy).toContain('**Recovery routing → Repairable write/read failure**');
    expect(policy).toMatch(/skip forbidden writes/i);
    expect(recovery).toContain('`OUTCOME=error`');
    expect(recovery).not.toContain('`OUTCOME=success`');
  });

  test('late changes rerun affected approvals and outputs before another navigation answer', () => {
    const late = compact(between(recovery, '**Late change or missing work:**', '**Blocked outcome:**'));
    ordered(late, ['Return to the affected review stage', 'Decision procedure',
      'Repeat Approval readiness', 'Required outputs steps 1–4', 'before choosing navigation again']);
    expect(late).toMatch(/stale evidence, follow \*\*Blocked outcome\*\* first/i);
    const finish = section.slice(section.indexOf('## Required outputs'));
    expect(compact(finish)).toContain('**Recovery routing → Late change or missing work** before navigation resumes');
    expect(compact(finish)).toMatch(/a next-step answer approves no implementation change/i);
    ordered(finish, ['{{TASKS_SECTION_EMIT:eng-review}}', '### Completion summary', '{{PLAN_FILE_REVIEW_REPORT}}',
      '## Review Log', '{{REVIEW_DASHBOARD}}', '## Next Steps — Review Chaining', '## Learning hooks', '{{BRAIN_WRITE_BACK}}']);
    const sequence = compact(finish.slice(0, finish.indexOf('### Output reference')));
    ordered(sequence, ['1. **Prepare the review body.**', '2. **Save and Read back.**', '3. **Log the saved review.**',
      '4. **Publish.**', '5. **Choose navigation.**', '6. **Finish.**', 'Section self-check']);
  });

  test('plan test diagrams cover proposed paths without inventing existing implementation', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const ctx = { skillName: 'plan-eng-review', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext;
      const audit = generateTestCoverageAuditPlan(ctx);
      expect(audit).toMatch(/existing or proposed component/);
      expect(audit).toMatch(/existing or proposed function\/method/);
      expect(audit).toMatch(/future paths remain proposals, not runnable code/i);
      for (const obligation of ['Every conditional branch', 'Every error path', 'Every call to another function', 'Every edge:']) {
        expect(audit).toContain(obligation);
      }
      expect(audit).toMatch(/no skipping regression coverage/i);
      const ship = generateTestCoverageAuditShip({ ...ctx, skillName: 'ship' });
      expect(ship).toMatch(/for each changed file, draw an ASCII diagram/i);
      expect(ship).toMatch(/function\/method that was added or modified/);
      expect(ship).not.toContain('existing or proposed');
    }
  });

  test('calibration write-back stays gated: no write instruction runs without the default-off gate', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const ctx = { skillName: 'plan-eng-review', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext;
      const output = generateBrainWriteBack(ctx);
      const gate = output.indexOf('Skip unless `BRAIN_CALIBRATION_WRITEBACK` is set');
      expect(gate).toBeGreaterThan(0);
      expect(output.indexOf('mcp__gbrain__takes_add')).toBeGreaterThan(gate);
      expect(output.indexOf('mcp__gbrain__put_page')).toBeGreaterThan(gate);
      expect(output.slice(0, gate)).toMatch(/skip this section/i);
      expect(output.slice(0, gate)).toMatch(/do not enable it or infer permission/i);
      expect(output).toContain('brain_trust_policy@<endpoint-hash>=personal');
      expect(output).toMatch(/if unknown, skip/i);
      expect(output).toContain('source_skill: plan-eng-review');
      expect(output).not.toContain('${BRAIN_CALIBRATION_WRITEBACK');
      for (const skillName of ['office-hours', 'plan-ceo-review', 'plan-design-review', 'plan-devex-review']) {
        const other = generateBrainWriteBack({ ...ctx, skillName });
        expect(other).toStartWith('## Brain Calibration Write-Back (gated)\n\nSkip unless');
        expect(other).not.toMatch(/skip this section/i);
      }
    }
  });
});

/**
 * _gstack_codex_model_probe — round-trip model readiness (#2477).
 *
 * The auth probe accepts "auth exists" as readiness, but a ChatGPT account
 * with a model it cannot use passes auth and then dies with an HTTP 400 on
 * every invocation. The model probe does one short `codex exec "reply OK"`
 * round trip with gstack's selected model.
 *
 * Contract pinned here (all runs use a STUBBED codex binary):
 *   - exit 0            -> MODEL_OK, result cached (1h TTL + config/auth
 *                          mtime signature), second call does NOT re-invoke
 *   - model 400 output  -> MODEL_UNUSABLE (exit 1) + config.toml HINT lines,
 *                          negative-cached 15 min (same exit-1 + hints from
 *                          cache; re-probing every preflight charged the
 *                          affected user 30s + real tokens per section)
 *   - transient failure -> MODEL_PROBE_INCONCLUSIVE, FAIL-OPEN (exit 0),
 *                          never cached
 *   - config.toml mtime change invalidates a cached MODEL_OK and a cached
 *                          MODEL_UNUSABLE (editing the pin IS the fix)
 *   - the probed model is the runtime selection (#2914): explicit request,
 *     GSTACK_CODEX_MODEL, config.toml (review_model first for native review),
 *     then gpt-6-astra; an invalid choice never falls back to the default
 *   - the cache key also covers the resolved codex binary, its mtime and the
 *     auth mode (#2787), and never stores a credential
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');

const STUB = `#!/usr/bin/env bash
echo "invoked" >> "$STUB_LOG"
printf '%s\\n' "$*" >> "$STUB_ARGS_LOG"
case "\${STUB_MODE:-ok}" in
  ok) echo "OK"; exit 0 ;;
  model400)
    echo 'warning: Model metadata for \`gpt-6-astra\` not found.' >&2
    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2
    exit 1 ;;
  transient) echo "stream error: network unreachable" >&2; exit 7 ;;
esac
`;

interface Fixture {
  home: string;
  stubDir: string;
  codexHome: string;
  gstackHome: string;
  stubLog: string;
  stubArgsLog: string;
}

function makeFixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-model-probe-'));
  const stubDir = path.join(home, 'stub-bin');
  const codexHome = path.join(home, '.codex');
  const gstackHome = path.join(home, '.gstack');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(gstackHome, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'codex'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const stubLog = path.join(home, 'stub.log');
  const stubArgsLog = path.join(home, 'stub-args.log');
  return { home, stubDir, codexHome, gstackHome, stubLog, stubArgsLog };
}

function runProbe(f: Fixture, stubMode: string, extraEnv: Record<string, string> = {}, call = '_gstack_codex_model_probe'): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    'bash',
    ['-c', `set +e\nsource "${PROBE}"\n${call}`],
    {
      env: {
        PATH: `${f.stubDir}:${process.env.PATH ?? ''}`,
        HOME: f.home,
        CODEX_HOME: f.codexHome,
        GSTACK_HOME: f.gstackHome,
        STUB_MODE: stubMode,
        STUB_LOG: f.stubLog,
        STUB_ARGS_LOG: f.stubArgsLog,
        _TEL: 'off',
        ...extraEnv,
      },
      timeout: 10000,
    },
  );
  return { stdout: (result.stdout ?? '').toString(), stderr: (result.stderr ?? '').toString(), status: result.status ?? -1 };
}

function lastArgs(f: Fixture): string {
  try {
    const lines = fs.readFileSync(f.stubArgsLog, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.at(-1) ?? '';
  } catch {
    return '';
  }
}

function invocations(f: Fixture): number {
  try {
    return fs.readFileSync(f.stubLog, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('codex model probe (#2477)', () => {
  test('successful round trip -> MODEL_OK, cached, no re-invocation', () => {
    const f = makeFixture();
    try {
      const first = runProbe(f, 'ok');
      expect(first.stdout.trim()).toBe('MODEL_OK');
      expect(first.status).toBe(0);
      expect(invocations(f)).toBe(1);
      // #2914: the fixture's config.toml chooses gpt-5.4; gstack must not override it.
      expect(lastArgs(f)).toContain('-c model="gpt-5.4"');
      expect(lastArgs(f)).toContain("-c skills.include_instructions=false");
      expect(first.stderr).toContain(`CODEX_MODEL: gpt-5.4 (exec; source: ${path.join(f.codexHome, 'config.toml')} model)`);
      expect(fs.existsSync(path.join(f.gstackHome, '.codex-model-probe'))).toBe(true);

      const second = runProbe(f, 'ok');
      expect(second.stdout.trim()).toBe('MODEL_OK (cached)');
      expect(second.status).toBe(0);
      expect(invocations(f)).toBe(1); // cache hit: stub not re-invoked
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('model 400 -> MODEL_UNUSABLE with selected-model hints, exit 1, negative-cached', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'model400');
      expect(r.stdout).toContain('MODEL_UNUSABLE');
      expect(r.stdout).toContain('gstack requested model');
      expect(r.stdout).toContain('GSTACK_CODEX_MODEL');
      // Surfaces the actual rejection so the user sees WHICH model and why it was chosen.
      expect(r.stdout).toContain("gstack requested model 'gpt-5.4'");
      expect(r.stdout).toContain('config.toml model');
      expect(r.status).toBe(1);
      // The deterministic 400 is config-driven: re-probing every preflight
      // charged the user a 30s round trip + real tokens per review section.
      // A second run within the 15-min TTL must NOT re-invoke codex, and must
      // keep the exit-1 + hints contract so callers can't tell the difference.
      expect(invocations(f)).toBe(1);
      const second = runProbe(f, 'model400');
      expect(second.stdout).toContain('MODEL_UNUSABLE (cached)');
      expect(second.stdout).toContain('GSTACK_CODEX_MODEL');
      expect(second.status).toBe(1);
      expect(invocations(f)).toBe(1);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('GSTACK_CODEX_MODEL change re-probes past a cached MODEL_UNUSABLE (the recovery path)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'model400');
      expect(invocations(f)).toBe(1);
      // Fixing the gstack model override changes the cache signature — the
      // negative cache must not outlive the model it condemned.
      const r = runProbe(f, 'ok', { GSTACK_CODEX_MODEL: 'gpt-5.6-sol' });
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(r.status).toBe(0);
      expect(invocations(f)).toBe(2);
      expect(lastArgs(f)).toContain('-c model="gpt-5.6-sol"');
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('transient failure -> inconclusive, FAIL-OPEN exit 0', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'transient');
      expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('TTL expiry: a cached MODEL_OK older than 3600s re-probes (T5)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(invocations(f)).toBe(1);
      // Backdate the cache line's timestamp past the 1h TTL, keeping the
      // signature valid — TTL alone must force the re-probe.
      const cachePath = path.join(f.gstackHome, '.codex-model-probe');
      const [status, ts, sig] = fs.readFileSync(cachePath, 'utf-8').trim().split(' ');
      expect(status).toBe('MODEL_OK');
      fs.writeFileSync(cachePath, `MODEL_OK ${Number(ts) - 3700} ${sig}\n`);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK'); // not "(cached)"
      expect(invocations(f)).toBe(2); // re-probed
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('auth.json mtime change invalidates the cached MODEL_OK (T5: re-login re-probes)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(invocations(f)).toBe(1);
      // A re-login rewrites auth.json; the mtime signature must invalidate
      // the cache even though config.toml is untouched.
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.codexHome, 'auth.json'), future, future);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2); // re-probed
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('config.toml change invalidates the cached MODEL_OK', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(invocations(f)).toBe(1);
      // Change the model pin; mtime signature must invalidate the cache.
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.codexHome, 'config.toml'), future, future);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2); // re-probed
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('#2914: precedence is explicit request, GSTACK_CODEX_MODEL, config.toml, then gpt-6-astra', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-luna"\n');
      const sel = (env: Record<string, string>, call: string) =>
        runProbe(f, 'ok', env, `${call}; printf '%s|%s\\n' "$_GSTACK_CODEX_SEL" "$_GSTACK_CODEX_SEL_SRC"`).stdout.trim();
      const config = path.join(f.codexHome, 'config.toml');
      expect(sel({}, '_gstack_codex_select_model exec')).toBe(`gpt-5.6-terra|${config} model`);
      expect(sel({}, '_gstack_codex_select_model review')).toBe(`gpt-5.6-luna|${config} review_model`);
      expect(sel({ GSTACK_CODEX_MODEL: 'gpt-6-sol' }, '_gstack_codex_select_model review')).toBe('gpt-6-sol|GSTACK_CODEX_MODEL');
      expect(sel({ GSTACK_CODEX_MODEL: 'gpt-6-sol' }, "_gstack_codex_select_model exec 'gpt-6-luna'")).toBe('gpt-6-luna|explicit request');
      // An id with no dedicated prompt overlay is still passed through unchanged.
      fs.writeFileSync(config, 'model = "acme/custom-model:2026-09"\n');
      expect(sel({}, '_gstack_codex_select_model review')).toBe(`acme/custom-model:2026-09|${config} model`);
      fs.rmSync(config);
      expect(sel({}, '_gstack_codex_select_model exec')).toBe(`gpt-6-astra|gstack default (no ${config})`);
      expect(invocations(f)).toBe(0); // selection alone never spends a call
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('#2914: native review probes its own review_model selection', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-luna"\n');
      const r = runProbe(f, 'ok', {}, '_gstack_codex_model_probe review');
      expect(r.status).toBe(0);
      expect(lastArgs(f)).toContain('-c model="gpt-5.6-luna"');
      expect(r.stderr).toContain('CODEX_MODEL: gpt-5.6-luna (review; source:');
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  for (const [label, env, config] of [
    ['an injection-shaped GSTACK_CODEX_MODEL', { GSTACK_CODEX_MODEL: 'gpt"; touch PWNED; "' }, 'model = "gpt-5.4"\n'],
    ['an invalid config.toml model', {}, 'model = "has space"\n'],
    ['an unparseable config.toml', {}, 'model = \n'],
  ] as const) {
    test(`#2914: ${label} is a repair message, never a silent frontier fallback`, () => {
      const f = makeFixture();
      try {
        fs.writeFileSync(path.join(f.codexHome, 'config.toml'), config);
        const r = runProbe(f, 'ok', { ...env });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('MODEL_UNUSABLE');
        expect(r.stderr).toContain('GSTACK_CODEX_MODEL=<model>');
        expect(r.stderr).toContain('No Codex call was made');
        expect(r.stderr).not.toContain('CODEX_MODEL: gpt-6-astra');
        expect(invocations(f)).toBe(0);
        expect(fs.existsSync(path.join(f.home, 'PWNED'))).toBe(false);
      } finally {
        fs.rmSync(f.home, { recursive: true, force: true });
      }
    });
  }

  test('#2787: swapping the codex binary or its mtime invalidates a cached MODEL_OK', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(runProbe(f, 'ok').stdout.trim()).toBe('MODEL_OK (cached)');
      // A different codex earlier on PATH (an upgrade or a second install).
      const other = path.join(f.home, 'other-bin');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'codex'), STUB, { mode: 0o755 });
      const swapped = runProbe(f, 'ok', { PATH: `${other}:${f.stubDir}:${process.env.PATH ?? ''}` });
      expect(swapped.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2);
      // Reinstalling in place keeps the path but moves the mtime.
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.stubDir, 'codex'), future, future);
      expect(runProbe(f, 'ok').stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(3);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('#2787: switching to env-var auth invalidates the cache without persisting the key', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      const secret = 'sk-test-SHOULD-NOT-PERSIST-abcdefghij';
      const r = runProbe(f, 'ok', { OPENAI_API_KEY: secret });
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2);
      expect(runProbe(f, 'ok', { OPENAI_API_KEY: secret }).stdout.trim()).toBe('MODEL_OK (cached)');
      expect(fs.readFileSync(path.join(f.gstackHome, '.codex-model-probe'), 'utf-8')).not.toContain(secret);
      // A different Codex home is a different configuration identity.
      const otherHome = path.join(f.home, 'codex-two');
      fs.cpSync(f.codexHome, otherHome, { recursive: true, preserveTimestamps: true });
      expect(runProbe(f, 'ok', { OPENAI_API_KEY: secret, CODEX_HOME: otherHome }).stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(3);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });
});

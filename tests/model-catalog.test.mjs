import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { ROOT } from '../scripts/lib.mjs';
import { mergeDaemonModelCatalog } from '../scripts/model-catalog.mjs';
import { patches, transformExact } from '../scripts/patches.mjs';

const older = {
  id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro',
  shortDisplayName: 'Gemini 3.1 Pro', modelProvider: 'google',
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium', isCustom: false,
};
const argon = {
  ...older, id: 'gemini-4-argon', displayName: 'Gemini 4 Argon',
  shortDisplayName: 'Gemini 4 Argon', tokenMultiplier: 0.8, isNew: true,
};
const custom = { ...older, id: 'custom:private', isCustom: true };
const isCustom = (model) => model.isCustom === true || model.id.startsWith('custom:');
const customModels = (models) => (models ?? []).filter(isCustom);
const patch = (id) => {
  const value = patches.find((item) => item.id === id);
  assert.ok(value, id);
  return value;
};
const plain = (value) => JSON.parse(JSON.stringify(value));

// Match the stock behavior that can clear disabled metadata. The compatibility
// merge must retain daemon restrictions even after this existing policy step.
function applyPolicy(models, policy) {
  return models.filter((model) => !isCustom(model) || policy?.allowCustomModels !== false)
    .map((model) => policy?.blockedModelIds?.includes(model.id)
      ? { ...model, disabled: true, disabledReason: 'Organization policy' }
      : { ...model, disabled: false });
}

test('daemon catalog adds Argon and future built-ins without hardcoding IDs or changing inputs', () => {
  const frontend = Object.freeze([Object.freeze({ ...older })]);
  const daemon = Object.freeze([
    Object.freeze({ ...argon }), Object.freeze({ ...older, tokenMultiplier: 1.5 }),
    Object.freeze({ ...argon, id: 'future-model', isNew: false }),
  ]);
  const result = mergeDaemonModelCatalog(frontend, daemon);
  assert.deepEqual(result.map((model) => model.id), [older.id, argon.id, 'future-model']);
  assert.equal(result[0].tokenMultiplier, 1.5);
  assert.deepEqual(result[1], argon);
  assert.deepEqual(frontend, [older]);
  assert.equal(daemon[0].isCustom, false);
});

test('daemon catalog never invents a preview model when the daemon does not return it', () => {
  for (const daemon of [undefined, null, [], [older]]) {
    assert.deepEqual(mergeDaemonModelCatalog([older], daemon), [older]);
  }
  assert.deepEqual(mergeDaemonModelCatalog(undefined, undefined), []);
});

test('daemon and frontend disabled states cannot re-enable each other', () => {
  const blockedArgon = { ...argon, disabled: true, disabledReason: 'Not available for this organization' };
  assert.deepEqual(mergeDaemonModelCatalog([], [blockedArgon]), [blockedArgon]);
  const frontendBlocked = { ...older, disabled: true, disabledReason: 'Frontend policy' };
  const [result] = mergeDaemonModelCatalog([frontendBlocked], [{ ...older, disabled: false }]);
  assert.equal(result.disabled, true);
  assert.equal(result.disabledReason, frontendBlocked.disabledReason);
  const [daemonBlocked] = mergeDaemonModelCatalog(
    [older], [{ ...older, disabled: true, disabledReason: 'Daemon policy' }],
  );
  assert.equal(daemonBlocked.disabled, true);
  assert.equal(daemonBlocked.disabledReason, 'Daemon policy');
});

test('catalog merging deduplicates IDs without dropping restrictions or keeping stale reasons', () => {
  const result = mergeDaemonModelCatalog(
    [{ ...older, disabled: false, disabledReason: 'stale' }],
    [older, { ...argon, disabled: true, disabledReason: 'Unavailable' }, { ...argon, disabled: false }],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].disabledReason, undefined);
  assert.equal(result[1].disabled, true);
  assert.equal(result[1].disabledReason, 'Unavailable');
});

test('daemon built-in merging does not add or re-enable custom models outside their policy flow', () => {
  assert.deepEqual(mergeDaemonModelCatalog([older], [
    custom, { ...custom, isCustom: false }, { ...argon, isCustom: true },
  ]), [older]);
  const disabledCustom = { ...custom, disabled: true, disabledReason: 'Custom models disabled' };
  assert.deepEqual(mergeDaemonModelCatalog([disabledCustom], [custom]), [disabledCustom]);
});

test('renderer embeds the tested self-contained helper in both package modes', () => {
  const helper = patch('linux-daemon-model-catalog-helper');
  const context = vm.createContext({});
  // Complete the function declaration at the injection boundary.
  vm.runInContext(`${helper.after}{};globalThis.merge=mergeDaemonModelCatalog`, context);
  assert.deepEqual(plain(context.merge([older], [argon, custom])), [older, argon]);
  assert.ok(helper.after.includes(mergeDaemonModelCatalog.toString()));
});

test('new-chat model selection retains daemon built-ins without bypassing air-gap or custom controls', () => {
  const replacement = patch('linux-new-session-daemon-models');
  const evaluate = (source, overrides = {}) => vm.runInNewContext(
    `let ${source}void 0; q`,
    {
      K: [older, argon, custom], D: false, $: [older],
      j: { modelPolicy: { allowCustomModels: false } },
      aro: isCustom, Sne: customModels,
      RNe: (models) => customModels(models).map((model) => ({ ...model, disabled: false })),
      J8: applyPolicy, mergeDaemonModelCatalog, ...overrides,
    },
  );
  assert.equal(evaluate(replacement.before).some((model) => model.id === argon.id), false);
  assert.equal(evaluate(replacement.after).some((model) => model.id === argon.id), true);
  assert.equal(evaluate(replacement.after).some(isCustom), false);
  assert.deepEqual(plain(evaluate(replacement.after, { D: true })), [{ ...custom, disabled: false }]);
  const disabled = evaluate(replacement.after, {
    K: [{ ...argon, disabled: true, disabledReason: 'Organization restriction' }],
  }).find((model) => model.id === argon.id);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.disabledReason, 'Organization restriction');
});

test('active-session initialization and refresh keep built-ins and disabled metadata', () => {
  const models = [{ ...argon, disabled: true, disabledReason: 'Unavailable' }, custom];
  const initialization = patch('linux-chat-daemon-model-state');
  const evaluate = (source, dt, initial = []) => vm.runInNewContext(
    `(function(){${source}})()`, { dt, _: undefined, s: { availableModels: initial }, Sne: customModels },
  );
  assert.equal(evaluate(initialization.before, models).some((model) => model.id === argon.id), false);
  assert.deepEqual(plain(evaluate(initialization.after, models)), models);
  assert.deepEqual(plain(evaluate(initialization.after, undefined, models)), models);
  const update = patch('linux-chat-daemon-model-updates');
  let updated;
  vm.runInNewContext(update.after, { ot: models, j: (value) => { updated = value; } });
  assert.equal(updated, models);
});

test('automation query and custom-model guards keep BYOK gating separate from built-in discovery', () => {
  const query = patch('linux-automation-daemon-catalog-query');
  const context = { o: false, h: false, t: 'local', Ti: 'local', vo: () => true, u: 'connected', Bi: { Connected: 'connected' } };
  assert.equal(vm.runInNewContext(`let ${query.before};p`, { ...context }), false);
  assert.equal(vm.runInNewContext(`let ${query.after};p`, { ...context }), true);
  assert.equal(vm.runInNewContext(`let ${query.after};p`, { ...context, u: 'disconnected' }), false);
  const guard = patch('linux-automation-custom-model-feature-guard');
  for (const enabled of [false, true]) {
    const models = vm.runInNewContext(`${guard.after}unused=0;w`, {
      o: enabled, b: { availableModels: [older, argon, custom] }, Twc: isCustom,
    });
    assert.deepEqual(plain(models), enabled ? [custom] : []);
  }
});

test('automation model selectors include newer built-ins but filter daemon-disabled entries', () => {
  const replacement = patch('linux-automation-daemon-model-catalog');
  const evaluate = (source, models) => vm.runInNewContext(`let ${source};k`, {
    E: [older], T: [], a: { allowCustomModels: false }, _: false, w: [],
    b: { availableModels: models }, J8: applyPolicy, mergeDaemonModelCatalog,
    Ewc: (model) => !model.disabled, xwc: (model) => model,
  });
  assert.equal(evaluate(replacement.before, [argon]).some((model) => model.id === argon.id), false);
  assert.equal(evaluate(replacement.after, [argon]).some((model) => model.id === argon.id), true);
  assert.equal(evaluate(replacement.after, [{ ...argon, disabled: true }]).some((model) => model.id === argon.id), false);
  assert.equal(evaluate(replacement.after, [custom]).some(isCustom), false);
});

test('patched official chat hook retains daemon built-ins in renders and immediate updates', async (t) => {
  const app = path.join(ROOT, 'build', 'extracted', 'application', 'app');
  const file = path.join(app, patch('linux-chat-daemon-model-catalog').file);
  try {
    assert.ok((await lstat(app)).isDirectory(), 'the extracted official app must be a directory');
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('requires the extracted official app');
      return;
    }
    throw error;
  }
  let source = await readFile(file, 'utf8');
  for (const change of patches.filter((item) => item.file.includes('/renderer/'))) {
    source = transformExact(source, change);
  }
  assert.ok(source.includes('fkt=Sti,tnr=V.object('), 'session models retain disabled metadata');
  const start = source.indexOf('function qGc(t){');
  const end = source.indexOf('function XGc(t){', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    z: { c: () => [] }, O0: () => ({ flags: {} }),
    dB: () => [older], J8: applyPolicy, P1e: (models) => models,
    Sne: customModels,
    RNe: (models) => customModels(models).map((model) => ({ ...model, disabled: false })),
    mergeDaemonModelCatalog,
  });
  vm.runInContext(`${source.slice(start, end)};globalThis.hook=qGc`, context);
  const args = { airgapEnabled: false, orgModelPolicy: { allowCustomModels: false }, orgCustomModels: [], daemonCustomModels: [argon, custom] };
  const result = context.hook(args);
  assert.equal(result.availableModels.some((model) => model.id === argon.id), true);
  assert.equal(result.availableModels.some(isCustom), false);
  assert.equal(result.enabledBuiltInModels.some((model) => model.id === argon.id), true);
  assert.equal(result.mergeWithCustomModels([argon]).some((model) => model.id === argon.id), true);
  assert.equal(result.mergeWithCustomModels([{ ...argon, disabled: true }]).some((model) => model.id === argon.id), false);
  const blocked = context.hook({ ...args, daemonCustomModels: [{ ...argon, disabled: true, disabledReason: 'Policy' }] });
  assert.equal(blocked.availableModels.find((model) => model.id === argon.id).disabled, true);
  assert.equal(blocked.enabledBuiltInModels.some((model) => model.id === argon.id), false);
  const airgap = context.hook({ ...args, airgapEnabled: true });
  assert.equal(airgap.availableModels.some((model) => !isCustom(model)), false);
});

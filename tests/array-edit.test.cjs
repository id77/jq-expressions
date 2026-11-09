const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
function section(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.ok(first !== -1 && last !== -1);
  return html.slice(first, last);
}
const context = vm.createContext({});
vm.runInContext(
  `
  let ops = [], uid = 1, all = true, safe = true, viewIsResult = false;
  const $ = (id) => ({ checked: id === 'arrayAll' ? all : id === 'safeDynamic' ? safe : false });
  const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const renderAll = () => {};
  const cleanNum = (n) => parseFloat(Number(n).toPrecision(12));
  function joinPath(prefix, p) {
    p = (p || '').trim();
    if (!p || p === '.') return prefix;
    p = p.replace(/^\\.(?=\\[)/, '');
    return prefix === '.' ? (p[0] === '[' ? '.' + p : p) : prefix + p;
  }
  ${section('      const ID_RE =', '      const pad =')}
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  ${section('      /* ---------- value classification ---------- */', '      /* ---------- ops model ---------- */')}
  ${section('      const mk =', '      /* ---------- parse jq text ---------- */')}
  ${section('      const indentLines =', '      const wrap =')}
  globalThis.api = {
    reset(enabled, guarded = true) { ops = []; all = enabled; safe = guarded; },
    setSafe(enabled) { safe = enabled; },
    path: targetJqPath,
    set: setLiteral,
    delta(path, value, sample = 1) { applyDelta(path, classify(sample), value); },
    classify,
    remove: removeOps,
    output() { return compile(false); },
    operations() { return JSON.parse(JSON.stringify(ops)); },
  };
  `,
  context,
);
const api = context.api;

function runJq(input, filter) {
  const result = spawnSync('jq', ['-c', filter], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('all elements is enabled by default and assignments honor both modes', () => {
  assert.match(html, /id="arrayAll"\s+checked/);
  const input = { data: [{ test: 1 }, { test: 2 }] };
  for (const [enabled, expression, expected] of [
    [true, '.data[].test = 0', { data: [{ test: 0 }, { test: 0 }] }],
    [false, '.data[0].test = 0', { data: [{ test: 0 }, { test: 2 }] }],
  ]) {
    api.reset(enabled);
    api.set(['data', 0, 'test'], 0);
    assert.equal(api.output(), expression);
    assert.deepEqual(runJq(input, expression), expected);
  }
});

test('nested and root arrays and unusual object keys are distinct', () => {
  const input = { '[]': [{ 'a.b': [{ test: 1 }, { test: 2 }] }, { 'a.b': [{ test: 3 }] }] };
  api.reset(true);
  api.set(['[]', 0, 'a.b', 1, 'test'], 0);
  assert.equal(api.output(), '.["[]"][]["a.b"][]?.test = 0');
  assert.deepEqual(runJq(input, api.output()), {
    '[]': [{ 'a.b': [{ test: 0 }, { test: 0 }] }, { 'a.b': [{ test: 0 }] }],
  });
  assert.equal(api.path([0, 'test']), '.[].test');
  api.reset(false);
  assert.equal(api.path([0, 'test']), '.[0].test');
});

test('nested batch edits skip null and missing arrays without changing them', () => {
  const input = {
    data: [
      { items: [{ x: 1 }, { x: 2 }] },
      { items: null },
      {},
      { items: [{ x: 3 }] },
    ],
  };
  api.reset(true);
  api.set(['data', 0, 'items', 0, 'x'], 0);
  assert.equal(api.output(), '.data[].items[]?.x = 0');
  assert.deepEqual(runJq(input, api.output()), {
    data: [{ items: [{ x: 0 }, { x: 0 }] }, { items: null }, {}, { items: [{ x: 0 }] }],
  });
  api.reset(true);
  api.delta(['data', 0, 'items', 0, 'x'], 1);
  assert.deepEqual(runJq(input, api.output()), {
    data: [{ items: [{ x: 2 }, { x: 3 }] }, { items: null }, {}, { items: [{ x: 4 }] }],
  });
  api.reset(false);
  api.set(['data', 0, 'items', 0, 'x'], 0);
  assert.equal(api.output(), '.data[0].items[0].x = 0');
});

test('multiple nested optional traversals leave null branches intact', () => {
  const input = {
    data: [
      { groups: [{ items: [{ x: 1 }] }, { items: null }, {}] },
      { groups: null },
      {},
      { groups: [{ items: [{ x: 2 }] }] },
    ],
  };
  api.reset(true);
  api.set(['data', 0, 'groups', 0, 'items', 0, 'x'], 0);
  assert.equal(api.output(), '.data[].groups[]?.items[]?.x = 0');
  assert.deepEqual(runJq(input, api.output()), {
    data: [
      { groups: [{ items: [{ x: 0 }] }, { items: null }, {}] },
      { groups: null },
      {},
      { groups: [{ items: [{ x: 0 }] }] },
    ],
  });
  assert.deepEqual(
    runJq(input, 'del(.data[].groups[]?.items[]?.x)'),
    {
      data: [
        { groups: [{ items: [{}] }, { items: null }, {}] },
        { groups: null },
        {},
        { groups: [{ items: [{}] }] },
      ],
    },
  );
});

test('dynamic changes accumulate and cancel on the same tree node', () => {
  api.reset(true);
  api.delta(['data', 0, 'test'], 1);
  api.delta(['data', 0, 'test'], 1);
  assert.match(api.output(), /^\(\.data\?\[\]\?\.test\? \| select\(\. != null\)\) \|=/);
  api.delta(['data', 0, 'test'], -2);
  assert.equal(api.output(), '.');
});

test('dynamic validation is optional and disabled by default', () => {
  const checkbox = html.match(/<input\b[^>]*\bid="safeDynamic"[^>]*>/);
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox[0], /\bchecked\b/);
  api.reset(true, false);
  api.delta(['data', 0, 'x'], 1);
  assert.equal(api.output(), '.data[].x |= . + 1');
  assert.deepEqual(runJq({ data: [{ x: 1 }, { x: 2 }] }, api.output()), {
    data: [{ x: 2 }, { x: 3 }],
  });
  api.reset(true, true);
  api.delta(['data', 0, 'x'], 1);
  assert.deepEqual(runJq({ data: [{ x: 1 }, { x: null }, {}] }, api.output()), {
    data: [{ x: 2 }, { x: null }, {}],
  });
});

test('switching validation modes leaves prior operations intact', () => {
  api.reset(true, false);
  api.delta(['data', 0, 'x'], 1);
  const first = api.operations()[0];
  api.setSafe(true);
  assert.deepEqual(api.operations()[0], first);
  api.delta(['data', 0, 'x'], 2);
  assert.equal(api.operations().length, 2);
  api.delta(['data', 0, 'x'], -2);
  assert.equal(api.operations().length, 1);
  assert.deepEqual(api.operations()[0], first);
  api.setSafe(false);
  api.delta(['data', 0, 'x'], 1);
  assert.equal(api.output(), '.data[].x |= . + 2');
});

test('unchecked dynamic calculations preserve legacy output for each value type', () => {
  for (const [sample, delta, expected] of [
    [1, -2, '.x |= . - 2'],
    ['12', 1, '.x |= (tonumber + 1 | tostring)'],
    [1700000000, 3600, '.x |= . + 3600'],
    ['1700000000', -3600, '.x |= (tonumber - 3600 | tostring)'],
    ['2026-02-28 10:00:00', 86400, '.x |= (strptime("%Y-%m-%d %H:%M:%S") | mktime + 86400 | strftime("%Y-%m-%d %H:%M:%S"))'],
  ]) {
    api.reset(false, false);
    api.delta(['x'], delta, sample);
    assert.equal(api.output(), expected);
  }
  api.reset(false, false);
  api.delta(['x'], 86400, '2026-02-28T10:00:00.123Z');
  assert.deepEqual(runJq({ x: '2026-02-28T10:00:00.123Z' }, api.output()), {
    x: '2026-03-01T10:00:00.123Z',
  });
});

test('dynamic number updates preserve missing, null and mismatched values', () => {
  api.reset(true);
  api.delta(['data', 0, 'x'], 1);
  const input = { data: [{ x: 1 }, { x: null }, {}, { x: '2' }, null, { x: 9007199254740991 }] };
  assert.deepEqual(runJq(input, api.output()), {
    data: [{ x: 2 }, { x: null }, {}, { x: '2' }, null, { x: 9007199254740991 }],
  });
});

test('dynamic integer strings retain ambiguous formats and mismatched types', () => {
  api.reset(true);
  api.delta(['data', 0, 'x'], 1, '12');
  const input = { data: [{ x: '12' }, { x: '0012' }, { x: '1.20' }, { x: 12 }, { x: null }, {}] };
  assert.deepEqual(runJq(input, api.output()), {
    data: [{ x: '13' }, { x: '0012' }, { x: '2.20' }, { x: 12 }, { x: null }, {}],
  });
});

test('decimal string updates preserve scale and skip unrepresentable or unsafe values', () => {
  api.reset(true);
  api.delta(['data', 0, 'x'], 0.1, '1.20');
  const input = { data: [
    { x: '1.20' }, { x: '-0.10' }, { x: '12' }, { x: '01.20' },
    { x: '0.1234567' }, { x: '9007199254740991' }, { x: '1e3' },
  ] };
  assert.deepEqual(runJq(input, api.output()), { data: [
    { x: '1.30' }, { x: '0.00' }, { x: '12' }, { x: '01.20' },
    { x: '0.1234567' }, { x: '9007199254740991' }, { x: '1e3' },
  ] });
});

test('dynamic timestamps check type, precision, and unit', () => {
  for (const [sample, values, expected] of [
    [1700000000, [1700000000, 1700000000000, '1700000000', null], [1700003600, 1700000000000, '1700000000', null]],
    ['1700000000000', ['1700000000000', '1700000000', 1700000000000, null], ['1700003600000', '1700000000', 1700000000000, null]],
  ]) {
    api.reset(true);
    api.delta(['data', 0], sample.toString().length === 13 ? 3600000 : 3600, sample);
    assert.deepEqual(runJq({ data: values }, api.output()), { data: expected });
  }
});

test('date shifts validate real dates and preserve UTC and offset suffixes', () => {
  for (const suffix of ['', 'Z', '+08:00', '.123Z', '.123456+05:30']) {
    const sample = '2026-02-28T10:00:00' + suffix;
    api.reset(true);
    api.delta(['data', 0, 'x'], 86400, sample);
    const input = { data: [{ x: sample }, { x: '2026-02-31T10:00:00' + suffix }, { x: null }, {}, { x: 123 }] };
    assert.deepEqual(runJq(input, api.output()), {
      data: [{ x: '2026-03-01T10:00:00' + suffix }, { x: '2026-02-31T10:00:00' + suffix }, { x: null }, {}, { x: 123 }],
    });
  }
  assert.equal(api.classify('2026-02-31').kind, 'str');
  api.reset(true);
  api.delta(['data', 0], 86400, '2026-02-28T10:00:00Z');
  assert.deepEqual(runJq({ data: [
    '2026-02-28T10:00:00Z', '2026-02-28T10:00:00.456+08:00',
    '2026-02-28T10:00:00', '2026-02-28T10:00:00+25:00',
  ] }, api.output()), { data: [
    '2026-03-01T10:00:00Z', '2026-03-01T10:00:00.456+08:00',
    '2026-03-01T10:00:00', '2026-02-28T10:00:00+25:00',
  ] });
});

test('changing mode does not rewrite existing operations', () => {
  api.reset(true);
  api.set(['data', 0, 'test'], 1);
  const before = api.operations();
  vm.runInContext('all = false', context);
  assert.deepEqual(api.operations(), before);
  api.set(['data', 0, 'test'], 2);
  assert.equal(api.output(), '.data[].test = 1 | .data[0].test = 2');
});

test('settings panel displays and updates its actual target path', () => {
  const ui = vm.createContext({});
  vm.runInContext(
    `
    const controls = { arrayAll: { checked: true } };
    const $ = (id) => controls[id];
    const labels = [];
    const document = { querySelectorAll: () => labels };
    function el(tag, attrs, ...children) {
      const element = {
        tag, attrs, children, textContent: children[0],
        dataset: { editPath: attrs?.['data-edit-path'] },
        addEventListener() {},
      };
      if (attrs?.class?.includes('edit-target-path')) labels.push(element);
      return element;
    }
    ${section('      const ID_RE =', '      function tryJSON')}
    ${section('      function advancedPanel(', '      function scalarControls(')}
    ${section("      $('arrayAll').onchange =", "      $('quote').onchange")}
    globalThis.api = {
      panel: advancedPanel,
      label: () => labels[0],
      toggle(value) {
        controls.arrayAll.checked = value;
        controls.arrayAll.onchange();
      },
    };
    `,
    ui,
  );
  ui.api.panel(['data', 0, 'items', 1, 'a'], 1, false, false);
  assert.equal(ui.api.label().textContent, '.data[].items[]?.a');
  ui.api.toggle(false);
  assert.equal(ui.api.label().textContent, '.data[0].items[1].a');
  ui.api.toggle(true);
  assert.equal(ui.api.label().textContent, '.data[].items[]?.a');
});

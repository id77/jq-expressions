const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('      const indentLines =');
const end = html.indexOf('      const wrap =', start);
assert.ok(start !== -1 && end !== -1, 'compiler source not found');
const context = vm.createContext({ ops: [], merge: true });
vm.runInContext(
  `
  const $ = () => ({ checked: merge });
  const tryJSON = (v) => {
    try { return { ok: true, v: JSON.parse(v) }; }
    catch { return { ok: false }; }
  };
  const isAssign = (o) => o.opr !== 'raw' && o.opr !== 'group';
  function joinPath(prefix, p) {
    p = (p || '').trim();
    if (!p || p === '.') return prefix;
    p = p.replace(/^\\.(?=\\[)/, '');
    return prefix === '.' ? (p[0] === '[' ? '.' + p : p) : prefix + p;
  }
  ${html.slice(start, end)}
  globalThis.compileForTest = (items, enabled) => {
    ops = items;
    merge = enabled;
    return compile(false);
  };
  globalThis.copyPathForTest = (items, target, source) => {
    ops = items;
    return relativePathAt(source, locateOperation(target).scope.prefix);
  };
  `,
  context,
);

function runJq(input, filter) {
  const result = spawnSync('jq', ['-c', filter], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout };
}
function compare(input, operations) {
  const unmerged = context.compileForTest(operations, false);
  const merged = context.compileForTest(operations, true);
  assert.deepEqual(runJq(input, merged), runJq(input, unmerged), merged);
  return merged;
}
const op = (path, opr, val) => ({ path, opr, val });

test('repeated array copies rebase references at every merge level', () => {
  const input = { data: { nested: { items: [1, 2, 3] } } };
  const operations = [
    op('.data.nested.items', '+=', '[.data.nested.items[0]]'),
    op('.data.nested.items', '+=', '[.data.nested.items[2]]'),
    op('.data.nested.items', '+=', '[.data.nested.items[3]]'),
  ];
  const merged = compare(input, operations);
  assert.match(merged, /\.data\.nested \|= \(/);
  assert.match(merged, /\[\.items\[0\]\]/);
  assert.deepEqual(
    JSON.parse(runJq(input, merged).stdout).data.nested.items,
    [1, 2, 3, 1, 3, 1],
  );
});

test('array references to the merged object become [.]', () => {
  const input = { data: { items: [] } };
  const merged = compare(input, [
    op('.data.items', '+=', '[.data]'),
    op('.data.items', '+=', '[.data]'),
  ]);
  assert.match(merged, /\[\.\]/);
});

test('quoted keys, array indexes and nested groups retain references', () => {
  const input = { 'data.key': [{ items: ['a', 'b'] }] };
  const merged = compare(input, [
    op('.["data.key"][0].items', '+=', '[.["data.key"][0].items[0]]'),
    op('.["data.key"][0].items', '+=', '[.["data.key"][0].items[1]]'),
  ]);
  assert.match(merged, /\[\.items\[0\]\]/);
});

test('literal values merge without changing results', () => {
  for (const input of [{}, { data: { a: 10, b: null } }]) {
    const merged = compare(input, [
      op('.data.a', '=', '1'),
      op('.data.b', '//=', '{"x":[1,2]}'),
      op('.data.c', '=', '"hello"'),
    ]);
    assert.match(merged, /^\.data \|=/);
  }
});

test('unrelated references and arbitrary expressions remain unmerged', () => {
  const input = { data: { a: 1, b: 2, items: [] }, other: 42 };
  for (const value of ['.other', '[.other]', '{x: .other}', '.data.a + 1']) {
    const operations = [
      op('.data.a', '=', value),
      op('.data.b', '=', '4'),
    ];
    assert.doesNotMatch(compare(input, operations), /^\.data \|=/);
  }
});

test('update expressions, deletions and unsafe array references remain unmerged', () => {
  const cases = [
    [{ data: { a: 1, b: 2 } }, [op('.data.a', '|=', '. + 1'), op('.data.b', '=', '3')]],
    [{}, [op('.data.a', 'del'), op('.data.b', 'del')]],
    [{ data: [{ a: 1, items: [] }] }, [op('.data[].items', '+=', '[.data[].a]'), op('.data[].a', '=', '3')]],
  ];
  for (const [input, operations] of cases)
    assert.doesNotMatch(compare(input, operations), /^\.data(?:\[\]|\?)? \|=/);
});

test('literal sibling edits merge across array and optional field paths', () => {
  for (const [input, operations, expected] of [
    [
      { data: [{ a: 1 }, { b: 2 }] },
      [op('.data[].a', '=', '2'), op('.data[].b', '=', '3')],
      '.data[] |= (.a = 2 | .b = 3)',
    ],
    [
      { data: [{ items: [{ a: 1 }, { b: 2 }] }, { items: null }, {}] },
      [op('.data[].items[]?.a', '=', '2'), op('.data[].items[]?.b', '=', '3')],
      '.data[].items[]? |= (.a = 2 | .b = 3)',
    ],
    [
      {},
      [op('.data?.a', '=', '2'), op('.data?.b', '=', '3')],
      '.data? |= (.a = 2 | .b = 3)',
    ],
  ]) {
    assert.equal(compare(input, operations), expected);
  }
});

test('optional branches do not create missing parents when merging', () => {
  const operations = [
    op('.data.first[]?.a', '=', '1'),
    op('.data.second[]?.b', '=', '2'),
  ];
  for (const input of [{}, { data: null }, { data: {} }, { data: { first: [], second: null } }]) {
    const merged = compare(input, operations);
    assert.doesNotMatch(merged, /^\.data \|=/);
  }
});

test('nested sibling branches merge at the nearest safe array traversal', () => {
  const base = '.data.pageModuleList[].moduleDataList[]?.specilPurchase';
  const operations = [
    op(base + '.specialPurchaseCrowInfos[]?.productList[]?.surplusStock', '=', '0'),
    op(base + '.specialPurchaseCrowInfos[]?.productList[]?.saleStatus', '=', '2'),
    op(base + '.periodConfig[]?.startTime', '=', '"08:00:00"'),
  ];
  const variants = [
    {},
    { specilPurchase: null },
    { specilPurchase: { specialPurchaseCrowInfos: null } },
    {
      specilPurchase: {
        specialPurchaseCrowInfos: [{ productList: [{ surplusStock: 5, saleStatus: 1 }] }, {}],
        periodConfig: [{ startTime: 'old' }, {}],
      },
    },
  ];
  const input = {
    data: { pageModuleList: [{ moduleDataList: variants }, { moduleDataList: null }, {}] },
  };
  const merged = compare(input, operations);
  assert.match(merged, /^\.data\.pageModuleList\[\]\.moduleDataList\[\]\? \|= \(/);
  assert.match(merged, /productList\[\]\? \|= \(\.surplusStock = 0 \| \.saleStatus = 2\)/);
  const result = runJq(input, merged);
  assert.equal(result.status, 0);
  const list = JSON.parse(result.stdout).data.pageModuleList[0].moduleDataList;
  assert.deepEqual(list.slice(0, 3), variants.slice(0, 3));
  assert.deepEqual(list[3].specilPurchase.periodConfig, [
    { startTime: '08:00:00' },
    { startTime: '08:00:00' },
  ]);
});

test('unsafe references remain separate when an outer traversal could otherwise merge', () => {
  const operations = [
    op('.data[].left[]?.x', '=', '1'),
    op('.data[].right[]?.x', '=', '.other'),
  ];
  const input = { other: 2, data: [{ left: [{ x: 0 }], right: [{ x: 0 }] }] };
  const merged = compare(input, operations);
  assert.doesNotMatch(merged, /^\.data\[\] \|=/);
});

test('optional path markers are never split from their preceding segment', () => {
  const operations = [
    op('.data.items[]?.a', '=', '1'),
    op('.data.items[].b', '=', '2'),
  ];
  const merged = compare({ data: { items: [{ a: 0 }] } }, operations);
  assert.doesNotMatch(merged, /^\.data\.items\[\] \|=/);
});

test('a shorter shared prefix cannot invalidate an earlier reference', () => {
  const operations = [
    op('.data.a.items', '+=', '[.data.a.items[0]]'),
    op('.data.a.items', '+=', '[.data.a.items[1]]'),
    op('.data.b.items', '+=', '[.other]'),
  ];
  const input = { data: { a: { items: [1, 2] }, b: { items: [] } }, other: 3 };
  compare(input, operations);
});

test('imported group keeps relative copy references when merging', () => {
  const input = { data: { items: [1, 2, 3] } };
  const group = {
    opr: 'group',
    path: '.data',
    wrapper: '',
    children: [
      op('.items', '+=', '[.items[0]]'),
      op('.items', '+=', '[.items[2]]'),
    ],
  };
  const merged = compare(input, [group]);
  assert.deepEqual(JSON.parse(runJq(input, merged).stdout).data.items, [1, 2, 3, 1, 3]);
  assert.equal(
    context.copyPathForTest([group], '.data.items', '.data.items[0]'),
    '.items[0]',
  );
  assert.equal(
    context.copyPathForTest([], '.data.items', '.data.items[0]'),
    '.data.items[0]',
  );
});

test('mixed operations preserve order and context across merge boundaries', () => {
  const input = { data: { a: 2, b: 3, c: 4, items: [7, 8] }, other: 9 };
  const operations = [
    op('.data.a', '=', '10'),
    op('.data.b', '=', '20'),
    op('.data.c', '=', '.other'),
    op('.data.items', '+=', '[.data.items[0]]'),
    op('.data.items', '+=', '[.data.items[2]]'),
    op('.data.b', 'del'),
    op('.data.a', '|=', '. + 1'),
  ];
  const merged = compare(input, operations);
  assert.deepEqual(JSON.parse(runJq(input, merged).stdout), {
    data: { a: 11, c: 9, items: [7, 8, 7, 7] },
    other: 9,
  });
});

test('references stay correct when a later operation shortens the shared prefix', () => {
  const input = { data: { a: { items: [1, 2] }, b: 0 } };
  const merged = compare(input, [
    op('.data.a.items', '+=', '[.data.a.items[0]]'),
    op('.data.a.items', '+=', '[.data.a.items[1]]'),
    op('.data.b', '=', '5'),
  ]);
  assert.deepEqual(JSON.parse(runJq(input, merged).stdout), {
    data: { a: { items: [1, 2, 1, 2] }, b: 5 },
  });
});

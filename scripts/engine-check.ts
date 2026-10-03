import {
  buildSnapshot,
  conflictsAgainstApplied,
  planImport,
  resolveRef,
  type RawLookup,
  type ResolvedRef,
  type ThemePackage
} from '../src/sync/engine.ts';

let passed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (!cond) {
    console.error(`✗ ${name} ${detail}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${name}`);
  }
}

// 初始工作区：light / dark / ops / contrast
const tokens: Record<string, Record<string, string>> = {
  'color.base.blue.600': { light: '#2864dc', dark: '#6f96ff', ops: '#24786a', contrast: '#0b4dba' },
  'color.base.blue.400': { light: '#6f96ff', dark: '#6f96ff', ops: '#58a99a', contrast: '#2878e8' },
  'color.base.green.600': { light: '#24786a', dark: '#54b2a0', ops: '#24786a', contrast: '#0d5a4d' },
  'color.semantic.primary': { light: '{color.base.blue.600}', dark: '{color.base.blue.400}', ops: '{color.base.green.600}', contrast: '{color.base.blue.800}' },
  'color.base.blue.800': { light: '#0b4dba', dark: '#9ab9ff', ops: '#145c51', contrast: '#06358a' },
  'color.text.primary': { light: '#17202b', dark: '#f5f7fa', ops: '#152a25', contrast: '#000000' },
  'color.text.secondary': { light: '#667582', dark: '#a8b2bd', ops: '#62766f', contrast: '#303b46' },
  'color.surface.canvas': { light: '#f2f5f7', dark: '#121821', ops: '#f1f6f4', contrast: '#ffffff' },
  'component.button.primary.bg': { light: '{color.semantic.primary}', dark: '{color.semantic.primary}', ops: '{color.semantic.primary}', contrast: '{color.semantic.primary}' },
  'component.button.primary.text': { light: '#ffffff', dark: '#ffffff', ops: '#ffffff', contrast: '#ffffff' }
};
const allIds = Object.keys(tokens);
const lookup: RawLookup = (theme, id) => tokens[id]?.[theme];
const brand: Record<string, boolean> = {};
const hasBrand = (theme: string, id: string) => brand[`${theme}:${id}`] === true;

// 1. 引用链解析
const r1 = resolveRef('light', 'component.button.primary.bg', lookup);
assert('引用链解析到字面值', r1.literal === '#2864dc' && r1.chain.join(',') === 'component.button.primary.bg,color.semantic.primary,color.base.blue.600', JSON.stringify(r1));
const r2 = resolveRef('light', 'color.text.primary', lookup);
assert('字面值直接命中', r2.literal === '#17202b' && r2.chain.length === 1);

// 悬空引用
const dangling: ThemePackage = {
  packageId: 'P1', theme: 'dark', sourceVersion: 'v1', submittedAt: 1,
  entries: [{ id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.teal.500}' }]
};
const plan1 = planImport(dangling, lookup, {}, hasBrand, allIds).plan;
assert('悬空引用整包报错', plan1.errors.some((e) => e.code === 'unresolved'));

// 循环引用
tokens['a.x'] = { light: '{a.y}' };
tokens['a.y'] = { light: '{a.x}' };
allIds.push('a.x', 'a.y');
const cycle: ThemePackage = {
  packageId: 'P2', theme: 'light', sourceVersion: 'v1', submittedAt: 1,
  entries: [{ id: 'a.x', kind: 'semantic', value: '{a.y}' }]
};
const planCycle = planImport(cycle, lookup, {}, hasBrand, allIds).plan;
assert('循环引用整包报错', planCycle.errors.some((e) => e.code === 'cycle'));

// 2. 基础令牌改动 + 未覆盖别名重算 + 品牌覆盖保留待复核
brand['ops:component.button.primary.bg'] = true;
const opsPkg: ThemePackage = {
  packageId: 'P3', theme: 'ops', sourceVersion: 'ops-1', submittedAt: 2,
  entries: [
    { id: 'color.base.green.600', kind: 'base', value: '#1f7a5c' },
    { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' },
    { id: 'component.button.primary.bg', kind: 'component', value: '{color.semantic.primary}', brandOverride: true }
  ]
};
let cache: Record<string, ResolvedRef> = {};
const imp3 = planImport(opsPkg, lookup, cache, hasBrand, allIds);
const plan3 = imp3.plan;
assert('基础变更不报错（绿色与白字达标）', !plan3.errors.length, plan3.errors.map((e) => e.message).join(';'));
const bgUpdate = plan3.updates.find((u) => u.id === 'component.button.primary.bg')!;
assert('品牌覆盖别名保留待复核', bgUpdate.needsReview === true && bgUpdate.brandOverride === true);
assert('组件别名解析链经新基础色', bgUpdate.resolved.literal === '#1f7a5c');

// 3. 对比度不达标整包拒绝
const lightBad: ThemePackage = {
  packageId: 'P4', theme: 'light', sourceVersion: 'lb', submittedAt: 3,
  entries: [
    { id: 'color.base.blue.600', kind: 'base', value: '#9db8f5' },
    { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.blue.600}' }
  ]
};
const plan4 = planImport(lightBad, lookup, {}, hasBrand, allIds).plan;
assert('按钮白字对比不足整包拒绝', plan4.errors.some((e) => e.code === 'contrast'), plan4.errors.map((e) => e.message).join(';'));

// 4. 失败包不写缓存
const failedNewCache = planImport(lightBad, lookup, cache, hasBrand, allIds).newCache;
assert('失败包不产生缓存条目', Object.keys(failedNewCache).length === 0);

// 5. 应用 opsPkg
for (const u of plan3.updates) {
  if (u.needsReview) continue;
  tokens[u.id][u.theme] = u.raw;
}
Object.assign(cache, imp3.newCache);

// 重复来源版本：相同 theme+id+sourceVersion 走缓存
const dup: ThemePackage = {
  packageId: 'P5', theme: 'ops', sourceVersion: 'ops-1', submittedAt: 5,
  entries: [{ id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' }]
};
const plan5 = planImport(dup, lookup, cache, hasBrand, allIds).plan;
assert('重复来源版本沿用第一次解析结果（缓存命中）', plan5.cacheHits === 1);

// 6. 先到者生效，后到者只留冲突项
const winner: ThemePackage = {
  packageId: 'P6', theme: 'ops', sourceVersion: 'a', submittedAt: 9,
  entries: [
    { id: 'color.base.green.600', kind: 'base', value: '#206f57' },
    { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' }
  ]
};
const winPlan = planImport(winner, lookup, cache, hasBrand, allIds).plan;
assert('并发 A 包可通过', winPlan.errors.length === 0);
// 模拟 A 生效
for (const u of winPlan.updates) if (!u.needsReview) tokens[u.id][u.theme] = u.raw;

const loser: ThemePackage = {
  packageId: 'P7', theme: 'ops', sourceVersion: 'b', submittedAt: 9,
  entries: [
    { id: 'color.base.green.600', kind: 'base', value: '#3a8a6d' },
    { id: 'color.text.secondary', kind: 'base', value: '#5d756d' },
    { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' }
  ]
};
const conflicts = conflictsAgainstApplied(loser, lookup, 9);
assert('后到包只保留值不同的冲突项（语义别名引用相同值不算冲突）',
  conflicts.length === 2 && conflicts.map((c) => c.id).sort().join(',') === 'color.base.green.600,color.text.secondary',
  conflicts.map((c) => c.id).join(','));

// 7. 快照应含最终值与引用链
const snap = buildSnapshot('4.6.0', ['P3', 'P6'], ['ops'], allIds.map((id) => ({ id, name: id, category: id.split('.')[0] })), lookup);
const row = snap.rows.find((x) => x.id === 'component.button.primary.bg')!;
assert('快照包含引用链与最终值', row.themes.ops!.chain.length === 3 && typeof row.themes.ops!.literal === 'string');
assert('快照记录主题列表', snap.themes.join(',') === 'ops');

console.log(`\n${passed} 项断言全部通过`);

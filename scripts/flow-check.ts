// 端到端逻辑冒烟：在 Node 中以最小 localStorage shim 驱动 Pinia store。
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
};

import { createPinia, setActivePinia } from 'pinia';
setActivePinia(createPinia());

import { useTokenStore } from '../src/store.ts';
import { useSyncStore } from '../src/sync/syncStore.ts';
import { concurrentPair, sampleInbox } from '../src/sync/samples.ts';

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

const tokens = useTokenStore();
const sync = useSyncStore();

// 提交收件箱中的 4 个样例包：2 通过、2 拒绝（悬空引用、对比度）
const inbox = sampleInbox();
sync.submitBatch([...inbox]);
const applied = sync.records.filter((r) => r.status === 'applied');
const rejected = sync.records.filter((r) => r.status === 'rejected');
assert('4 个样例包：2 生效 2 拒绝', applied.length === 2 && rejected.length === 2, `${applied.length}/${rejected.length}`);

// 失败包的主题值必须保持原样
const darkToken = tokens.tokens.find((t) => t.id === 'color.semantic.primary')!;
assert('悬空引用包未写入暗色值', darkToken.themes.dark === '{color.base.blue.400}', darkToken.themes.dark);
const lightBlue = tokens.tokens.find((t) => t.id === 'color.base.blue.600')!;
assert('对比度失败包未写入亮色值', lightBlue.themes.light === '#2864dc', lightBlue.themes.light);

// 运营绿基础色已更新
const green = tokens.tokens.find((t) => t.id === 'color.base.green.600')!;
assert('运营绿基础令牌已更新', green.themes.ops === '#1f7a5c', green.themes.ops);

// 品牌覆盖组件别名保留旧值并待复核
const btnBg = tokens.tokens.find((t) => t.id === 'component.button.primary.bg')!;
assert('品牌覆盖保留原值（不重算）', btnBg.themes.ops === '{color.semantic.primary}');
assert('品牌覆盖标记待复核', tokens.reviewQueue.some((r) => r.theme === 'ops' && r.token.id === 'component.button.primary.bg'));

// 重复来源版本缓存命中
const beforeHits = sync.cache ? Object.keys(sync.cache).length : 0;
sync.loadDemo('duplicate');
const dup = sync.inbox.find((p) => p.note?.includes('重发同版本'))!;
const plan = sync.preview(dup);
assert('重复来源版本预检命中缓存', plan.cacheHits === 1, `hits=${plan.cacheHits}`);
sync.submitOne(dup);
void beforeHits;

// 处理待复核（重算）
sync.resolveReview('ops', 'component.button.primary.bg', 'recompute');
assert('重算后解除待复核', tokens.reviewQueue.length === 0);

// 同主题并发：先到生效，后到只留冲突
const [a, b] = concurrentPair();
sync.submitBatch([a, b]);
const recA = sync.records.find((r) => r.packageId === a.packageId);
const recB = sync.records.find((r) => r.packageId === b.packageId);
assert('并发 A（包号先到）生效', recA?.status === 'applied');
assert('并发 B 整包拒绝', recB?.status === 'rejected');
assert('冲突项保留 2 条（绿色基色 + 次文色）', sync.conflicts.filter((c) => c.loserPackageId === b.packageId).length === 2);
// B 包的值不得进入工作区
assert('后到包值未写入工作区', green.themes.ops !== '#3a8a6d', green.themes.ops);

// 跨主题并发：两者都生效
sync.loadDemo('different');
const cross = sync.inbox.filter((p) => /dark-3\.4|a11y\/contrast-2/.test(p.sourceVersion));
sync.submitBatch([...cross]);
assert('跨主题并发包均生效', cross.every((p) => sync.records.find((r) => r.packageId === p.packageId)?.status === 'applied'));

// 发布：校验 → 逐包写入 → 第 2 包失败 → 恢复 → 续传 → 快照
const start = sync.startPublish('4.6.0-rc.9');
assert('发布校验通过', start.ok, start.error ?? '');
assert('日志含逐包检查点', (sync.journal?.writes.length ?? 0) >= 4);

await sync.writeNextPackage(false);
assert('第 1 包写入成功', sync.journal?.appliedUpTo === 1);
await sync.writeNextPackage(true);
assert('第 2 包失败后状态为 failed', sync.journal?.status === 'failed' && sync.journal.failedAtPackage === 1);
assert('失败后已应用计数保留为 1', sync.journal?.appliedUpTo === 1);

// 重开续传（模拟刷新：新建 store 实例从 localStorage 恢复）
setActivePinia(createPinia());
const sync2 = useSyncStore();
const tokens2 = useTokenStore();
assert('重开后仍能识别未完成发布', sync2.hasOpenJournal && sync2.journal?.status === 'failed');
sync2.resumePublish();
assert('从失败包号（第 2 包）续传', sync2.journal?.appliedUpTo === 1);
while (sync2.journal?.status === 'writing') {
  await sync2.writeNextPackage(false);
}
assert('续传完成后生成快照', sync2.journal?.status === 'done' && !!sync2.journal.snapshot);
const snap = sync2.journal!.snapshot!;
assert('快照含多个主题', snap.themes.length >= 3, snap.themes.join(','));
const opsRow = snap.rows.find((r) => r.id === 'component.button.primary.bg')!;
assert('快照行包含引用链与最终值', opsRow.themes.ops?.chain.length === 3 && !!opsRow.themes.ops.literal, JSON.stringify(opsRow.themes.ops));
assert('发布后工作区锁定并更新版本', tokens2.locked && tokens2.lastPublished === 'DS 4.6.0-rc.9');
assert('日志持久化到 localStorage', mem.has('yy63-brand-sync'));

console.log(`\n${passed} 项断言全部通过`);

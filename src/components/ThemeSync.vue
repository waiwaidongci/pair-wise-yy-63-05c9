<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import {
  CheckCircleIcon,
  ErrorCircleIcon,
  InfoCircleIcon,
  RefreshIcon
} from 'tdesign-icons-vue-next';
import { useTokenStore } from '../store';
import { THEME_LABELS, THEME_NAMES, type ConflictItem, type ThemePackage, type TxRecord } from '../themeSync';

const store = useTokenStore();

const packageId = ref('@brand/tokens');
const version = ref('2.5.0');
const actor = ref('品牌设计组');
const jsonText = ref('');
const simulateFailure = ref(false);
const snapshotVersion = ref(store.releaseVersion);

const themeOptions = THEME_NAMES.map((theme) => ({ label: THEME_LABELS[theme], value: theme }));

function parsePackage(): ThemePackage | null {
  try {
    const parsed = JSON.parse(jsonText.value) as ThemePackage;
    if (!parsed.packageId || !parsed.version || !Array.isArray(parsed.tokens)) {
      MessagePlugin.error('包结构不完整：需要 packageId、version 与 tokens 数组');
      return null;
    }
    return parsed;
  } catch {
    MessagePlugin.error('JSON 解析失败，请检查格式');
    return null;
  }
}

function doImport() {
  const pkg = parsePackage();
  if (!pkg) return;
  pkg.submittedAt = Date.now();
  const result = store.importThemePackage(pkg, { simulateWriteFailure: simulateFailure.value });
  if (result.ok) {
    if (result.deduped) MessagePlugin.info(store.importInfo);
    else MessagePlugin.success(store.importInfo);
  } else if (result.recoverable) {
    MessagePlugin.warning(store.importError);
  } else {
    MessagePlugin.error(`整包未写入：${store.importError}`);
  }
}

function loadSample() {
  jsonText.value = JSON.stringify({
    packageId: '@brand/tokens',
    version: '2.5.0',
    actor: '品牌设计组',
    tokens: [
      { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#2864dc', themes: { light: '#2864dc', dark: '#7a9eff', ops: '#24786a', contrast: '#0b4dba' }, kind: 'base', description: '主操作、链接和重点状态' },
      { id: 'color.base.blue.400', name: '品牌蓝 400', category: 'color', value: '#6f96ff', themes: { light: '#6f96ff', dark: '#6f96ff', ops: '#58a99a', contrast: '#2878e8' }, kind: 'base' },
      { id: 'color.semantic.primary', name: '语义主色', category: 'color', value: '{color.base.blue.600}', themes: { light: '{color.base.blue.600}', dark: '{color.base.blue.400}', ops: '{color.base.green.600}', contrast: '{color.base.blue.800}' }, kind: 'semantic' },
      { id: 'component.button.primary.bg', name: '主按钮背景', category: 'component', value: '{color.semantic.primary}', themes: { light: '{color.semantic.primary}', dark: '{color.semantic.primary}', ops: '{color.semantic.primary}', contrast: '{color.semantic.primary}' }, kind: 'component' }
    ]
  }, null, 2);
}

function loadBadRef() {
  jsonText.value = JSON.stringify({
    packageId: '@brand/tokens',
    version: '2.5.1-badref',
    actor: '品牌设计组',
    tokens: [
      { id: 'color.semantic.primary', name: '语义主色', category: 'color', value: '{color.base.missing.900}', themes: { light: '{color.base.missing.900}', dark: '{color.base.blue.400}', ops: '{color.base.green.600}', contrast: '{color.base.blue.800}' }, kind: 'semantic' }
    ]
  }, null, 2);
}

function loadBadContrast() {
  jsonText.value = JSON.stringify({
    packageId: '@brand/tokens',
    version: '2.5.2-badcontrast',
    actor: '品牌设计组',
    tokens: [
      { id: 'color.text.primary', name: '正文主色', category: 'color', value: '#aaaaaa', themes: { light: '#aaaaaa', dark: '#f5f7fa', ops: '#152a25', contrast: '#000000' }, kind: 'base' },
      { id: 'color.surface.canvas', name: '页面背景', category: 'color', value: '#ffffff', themes: { light: '#ffffff', dark: '#121821', ops: '#f1f6f4', contrast: '#ffffff' }, kind: 'base' }
    ]
  }, null, 2);
}

function recover(seq: number) {
  const result = store.recoverTransaction(seq);
  if (result.ok) MessagePlugin.success(store.importInfo);
  else MessagePlugin.error(`恢复失败：${store.importError}`);
}

function runConcurrent() {
  const first: ThemePackage = {
    packageId: '@brand/theme-light',
    version: '3.0.0',
    actor: '品牌设计组',
    submittedAt: 1000,
    tokens: [
      { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#1f6fe0', themes: { light: '#1f6fe0', dark: '#7a9eff', ops: '#24786a', contrast: '#0b4dba' }, kind: 'base' }
    ]
  };
  const later: ThemePackage = {
    packageId: '@brand/theme-dark',
    version: '3.0.0',
    actor: '品牌设计组',
    submittedAt: 2000,
    tokens: [
      { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#1f6fe0', themes: { light: '#1f6fe0', dark: '#8aabff', ops: '#24786a', contrast: '#0b4dba' }, kind: 'base' }
    ]
  };
  store.submitConcurrent(first, later);
  MessagePlugin.info(store.importInfo);
}

const conflictTx = computed<TxRecord | undefined>(() =>
  store.transactions.find((tx) => tx.conflicts && tx.conflicts.length > 0)
);

function resolveConflict(item: ConflictItem, accept: boolean) {
  if (!conflictTx.value) return;
  store.resolveConflict(conflictTx.value.seq, item, accept);
}

function publishSnapshot() {
  const snapshot = store.publishSnapshot();
  snapshotVersion.value = snapshot.version;
  MessagePlugin.success(`快照已生成：${snapshot.version}`);
}

const snapshotRows = computed(() => {
  const snapshot = store.latestSnapshot;
  if (!snapshot) return [];
  return store.tokens.map((token) => {
    const perTheme: Record<string, { value: string; chain: string[] }> = {};
    for (const theme of THEME_NAMES) {
      const resolved = snapshot.byTheme[theme]?.[token.id];
      if (resolved) perTheme[theme] = resolved;
    }
    return { token, perTheme };
  });
});

function kindLabel(kind?: string) {
  return kind === 'base' ? '基础' : kind === 'semantic' ? '语义' : kind === 'component' ? '组件' : '—';
}
</script>

<template>
  <div class="sync-page">
    <section class="panel sync-import">
      <div class="panel-head">
        <div><strong>导入主题包</strong><span>外部设计包增量同步 · 先按主题解析引用 · 整包原子写入</span></div>
        <t-tag theme="primary" variant="light-outline">WAL 恢复</t-tag>
      </div>
      <div class="import-form">
        <div class="import-row">
          <label><span>包 ID</span><t-input v-model="packageId" /></label>
          <label><span>版本</span><t-input v-model="version" /></label>
          <label><span>来源</span><t-input v-model="actor" /></label>
        </div>
        <label class="import-json">
          <span>主题包 JSON（含 packageId、version、tokens，每个令牌带 kind 与各主题值）</span>
          <t-textarea v-model="jsonText" :autosize="{ minRows: 7, maxRows: 14 }" placeholder='{"packageId":"@brand/tokens","version":"2.5.0","tokens":[...]}' />
        </label>
        <div class="import-actions">
          <t-checkbox v-model="simulateFailure">模拟写入失败（演示按包号恢复）</t-checkbox>
          <div class="import-spacer" />
          <t-button size="small" variant="outline" @click="loadSample">载入示例包</t-button>
          <t-button size="small" variant="outline" @click="loadBadRef">失败场景：引用缺失</t-button>
          <t-button size="small" variant="outline" @click="loadBadContrast">失败场景：对比度不足</t-button>
          <t-button theme="primary" :icon="RefreshIcon" @click="doImport">导入并校验</t-button>
        </div>
        <div v-if="store.importError" class="import-msg error"><ErrorCircleIcon /><span>{{ store.importError }}</span></div>
        <div v-if="store.importInfo" class="import-msg success"><InfoCircleIcon /><span>{{ store.importInfo }}</span></div>
      </div>
    </section>

    <div class="sync-grid">
      <section class="panel">
        <div class="panel-head"><div><strong>已导入包</strong><span>重复来源版本沿用第一次结果</span></div></div>
        <div class="pkg-list">
          <div v-for="pkg in store.packages" :key="pkg.key" class="pkg-row">
            <t-tag size="small" :theme="pkg.outcome === 'committed' ? 'success' : 'danger'" variant="light">{{ pkg.outcome === 'committed' ? '已提交' : '已拒绝' }}</t-tag>
            <div class="pkg-main"><strong>{{ pkg.key }}</strong><span>{{ pkg.actor }} · {{ pkg.tokenCount }} 个令牌 · 包号 #{{ pkg.seq }}</span></div>
          </div>
          <p v-if="!store.packages.length" class="empty">暂无导入记录。</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><strong>事务与恢复</strong><span>写入失败后按包号恢复，重开继续</span></div></div>
        <div class="tx-list">
          <div v-for="tx in store.transactions" :key="tx.seq" class="tx-row">
            <t-tag size="small" :theme="tx.status === 'committed' ? 'success' : tx.status === 'pending' ? 'warning' : 'danger'" variant="light">{{ tx.status === 'committed' ? '已提交' : tx.status === 'pending' ? '待恢复' : '失败' }}</t-tag>
            <div class="pkg-main"><strong>#{{ tx.seq }} {{ tx.packageId }}@{{ tx.version }}</strong><span>尝试 {{ tx.attempts }} 次<template v-if="tx.lastError"> · {{ tx.lastError }}</template></span></div>
            <t-button v-if="tx.status === 'pending'" size="small" theme="primary" variant="outline" :icon="RefreshIcon" @click="recover(tx.seq)">恢复</t-button>
          </div>
          <p v-if="!store.transactions.length" class="empty">暂无事务。</p>
        </div>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><div><strong>并发提交归并</strong><span>两个主题包同时提交：先到者生效，后到者只留下冲突项</span></div>
        <t-button size="small" variant="outline" @click="runConcurrent">模拟并发提交</t-button>
      </div>
      <div class="conflict-list">
        <template v-if="conflictTx && conflictTx.conflicts && conflictTx.conflicts.length">
          <div v-for="item in conflictTx.conflicts" :key="`${item.tokenId}-${item.theme}`" class="conflict-row">
            <div class="conflict-id"><strong>{{ item.tokenId }}</strong><t-tag size="small">{{ THEME_LABELS[item.theme as keyof typeof THEME_LABELS] ?? item.theme }}</t-tag></div>
            <div class="conflict-vals"><span class="current">现值 <code>{{ item.current }}</code></span><t-icon name="arrow-right" /><span class="incoming">传入 <code>{{ item.incoming }}</code></span></div>
            <div class="conflict-actions">
              <t-button size="small" variant="outline" @click="resolveConflict(item, false)">保留现值</t-button>
              <t-button size="small" theme="primary" @click="resolveConflict(item, true)">采用传入</t-button>
            </div>
          </div>
        </template>
        <p v-else class="empty">暂无待处理冲突。点击右上角按钮模拟两个主题包并发提交。</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><strong>待复核品牌覆盖</strong><span>基础令牌改动后品牌覆盖保留，但需人工复核</span></div></div>
      <div class="review-list">
        <div v-for="token in store.pendingReviewTokens" :key="token.id" class="review-row">
          <div class="pkg-main"><strong>{{ token.name }}</strong><span>{{ token.id }} · 覆盖主题 {{ Object.keys(token.overrides ?? {}).filter((theme) => token.overrides?.[theme]).map((theme) => THEME_LABELS[theme as keyof typeof THEME_LABELS] ?? theme).join('、') }}</span></div>
          <t-button size="small" variant="outline" @click="store.clearReview(token.id)">标记复核通过</t-button>
        </div>
        <p v-if="!store.pendingReviewTokens.length" class="empty">暂无待复核项。改动基础令牌后，被覆盖的别名会进入待复核。</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><strong>发布快照</strong><span>各主题最终值与完整引用链</span></div>
        <t-button size="small" theme="primary" :icon="CheckCircleIcon" @click="publishSnapshot">生成快照</t-button>
      </div>
      <div class="snapshot-meta" v-if="store.latestSnapshot">
        <t-tag theme="success" variant="light-outline">{{ store.latestSnapshot.version }}</t-tag>
        <span>生成于 {{ new Date(store.latestSnapshot.releasedAt).toLocaleString('zh-CN') }}</span>
      </div>
      <div class="snapshot-table">
        <div class="snapshot-row snapshot-head">
          <div class="snap-id">令牌</div>
          <div v-for="theme in THEME_NAMES" :key="theme" class="snap-theme">{{ THEME_LABELS[theme] }}</div>
        </div>
        <div v-for="row in snapshotRows" :key="row.token.id" class="snapshot-row">
          <div class="snap-id"><strong>{{ row.token.name }}</strong><span>{{ row.token.id }}</span><t-tag size="small" variant="text">{{ kindLabel(row.token.kind) }}</t-tag></div>
          <div v-for="theme in THEME_NAMES" :key="theme" class="snap-theme">
            <template v-if="row.perTheme[theme]">
              <code>{{ row.perTheme[theme].value }}</code>
              <div class="chain"><span v-for="(link, index) in row.perTheme[theme].chain" :key="link" class="chain-link">{{ link }}<em v-if="index < row.perTheme[theme].chain.length - 1">→</em></span></div>
            </template>
            <span v-else class="chain-empty">—</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sync-page { display: grid; gap: 13px; }
.sync-import .import-form { padding: 14px 16px; display: grid; gap: 12px; }
.import-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.import-form label { color: #4d5f6d; font-size: 10px; }
.import-form label > span { display: block; margin-bottom: 6px; font-weight: 700; }
.import-actions { display: flex; align-items: center; gap: 8px; }
.import-spacer { flex: 1; }
.import-msg { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 5px; font-size: 11px; }
.import-msg.error { background: #fdeceb; color: #a34a48; }
.import-msg.success { background: #e7f5ef; color: #17664b; }
.sync-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; align-items: start; }
.pkg-list, .tx-list, .conflict-list, .review-list { padding: 8px 0; }
.pkg-row, .tx-row, .conflict-row, .review-row { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid #edf1f3; }
.pkg-main { flex: 1; min-width: 0; }
.pkg-main strong, .pkg-main span { display: block; }
.pkg-main strong { font-size: 11px; }
.pkg-main span { font-size: 9px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
.conflict-row { flex-wrap: wrap; }
.conflict-id { display: flex; align-items: center; gap: 8px; min-width: 200px; }
.conflict-id strong { font-size: 11px; }
.conflict-vals { flex: 1; display: flex; align-items: center; gap: 8px; font-size: 10px; }
.conflict-vals code { background: #f6f8fa; padding: 2px 6px; border-radius: 3px; font-size: 10px; }
.conflict-vals .current code { color: #a34a48; }
.conflict-vals .incoming code { color: #17664b; }
.conflict-actions { display: flex; gap: 6px; }
.review-row .pkg-main { flex: 1; }
.snapshot-meta { display: flex; align-items: center; gap: 10px; padding: 10px 14px; font-size: 10px; color: var(--muted); }
.snapshot-table { padding: 0 14px 14px; overflow-x: auto; }
.snapshot-row { display: grid; grid-template-columns: 240px repeat(4, minmax(160px, 1fr)); gap: 10px; padding: 10px 0; border-bottom: 1px solid #edf1f3; }
.snapshot-head { font-size: 9px; color: var(--muted); font-weight: 700; }
.snap-id strong, .snap-id span { display: block; }
.snap-id strong { font-size: 11px; }
.snap-id span { font-size: 8.5px; color: var(--muted); font-family: ui-monospace, monospace; margin: 2px 0; }
.snap-theme code { font-size: 10px; background: #f6f8fa; padding: 2px 6px; border-radius: 3px; }
.chain { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 3px; }
.chain-link { font-size: 8px; color: var(--muted); font-family: ui-monospace, monospace; }
.chain-link em { font-style: normal; margin: 0 2px; color: #b6c2cb; }
.chain-empty { color: #c4ccd3; }
.empty { color: var(--muted); font-size: 10px; padding: 12px 14px; }
@media (max-width: 1100px) {
  .sync-grid { grid-template-columns: 1fr; }
  .snapshot-row { grid-template-columns: 180px repeat(4, minmax(140px, 1fr)); }
}
@media (max-width: 700px) {
  .import-row { grid-template-columns: 1fr; }
  .snapshot-row { grid-template-columns: 1fr; }
}
</style>

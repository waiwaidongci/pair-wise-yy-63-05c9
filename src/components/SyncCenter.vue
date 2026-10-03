<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import {
  CheckCircleIcon,
  CloseCircleIcon,
  DownloadIcon,
  RefreshIcon,
  UploadIcon
} from 'tdesign-icons-vue-next';
import { useSyncStore } from '../sync/syncStore';
import { useTokenStore } from '../store';
import type { ThemePackage } from '../sync/engine';

const sync = useSyncStore();
const tokens = useTokenStore();

const themeLabels: Record<string, string> = {
  light: '明亮',
  dark: '暗色',
  ops: '运营',
  contrast: '高对比'
};

const selectedId = ref<string>(sync.inbox[0]?.packageId ?? '');
const selected = computed(() => sync.inbox.find((item) => item.packageId === selectedId.value));
const previewPlan = computed(() => (selected.value ? sync.preview(selected.value) : null));

const importJson = ref('');
const importError = ref('');

function submit(pkg: ThemePackage) {
  const result = sync.submitOne(pkg);
  if (result.plan.errors.length) {
    MessagePlugin.error(`整包未写入：${result.plan.errors[0].message}`);
  } else {
    MessagePlugin.success(
      `${pkg.packageId} 已导入：${result.plan.updates.length} 项更新，缓存命中 ${result.plan.cacheHits} 次${result.plan.reviews.length ? `，${result.plan.reviews.length} 项品牌覆盖待复核` : ''}`
    );
  }
  const next = sync.inbox[0];
  if (next) selectedId.value = next.packageId;
}

function submitConcurrent() {
  const pair = sync.inbox.filter((item) => /2026\.10\.2-[ab]/.test(item.sourceVersion));
  if (pair.length < 2) {
    MessagePlugin.warning('请先载入并发场景包（顶部按钮）');
    return;
  }
  sync.submitBatch(pair as ThemePackage[]);
  const loser = pair[1];
  const clashes = sync.conflicts.filter((c) => c.loserPackageId === loser.packageId);
  if (clashes.length) MessagePlugin.warning(`先到者 ${pair[0].packageId} 生效；${loser.packageId} 整包未写入，保留 ${clashes.length} 个冲突项`);
}

function submitAllInbox() {
  if (!sync.inbox.length) return;
  sync.submitBatch([...sync.inbox] as ThemePackage[]);
  const applied = sync.records.filter((r) => ['applied'].includes(r.status)).length;
  const rejected = sync.records.filter((r) => r.status === 'rejected').length;
  MessagePlugin.info(`提交完成：${applied} 个生效，${rejected} 个拒绝（含冲突与门禁失败）`);
}

function importFromJson() {
  importError.value = '';
  try {
    const parsed = JSON.parse(importJson.value) as ThemePackage;
    if (!parsed.packageId || !parsed.theme || !parsed.sourceVersion || !Array.isArray(parsed.entries)) {
      throw new Error('缺少 packageId / theme / sourceVersion / entries');
    }
    parsed.submittedAt = Date.now();
    sync.inbox.unshift(parsed);
    sync.persist();
    selectedId.value = parsed.packageId;
    importJson.value = '';
    MessagePlugin.success('外部包已进入收件箱，预检通过后可提交');
  } catch (error) {
    importError.value = error instanceof Error ? error.message : 'JSON 解析失败';
  }
}

function fmtTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function keepReview(theme: string, id: string) {
  sync.resolveReview(theme, id, 'keep');
  MessagePlugin.success('已确认保留品牌覆盖，解除待复核');
}
function recomputeReview(theme: string, id: string) {
  sync.resolveReview(theme, id, 'recompute');
  MessagePlugin.success('别名已按引用链重算');
}
</script>

<template>
  <div class="sync-page">
    <div class="sync-toolbar panel">
      <div class="toolbar-info">
        <strong>外部品牌主题包收件箱</strong>
        <span>基础令牌 / 语义别名 / 组件别名带来源版本 · 引用按主题解析 · 解析结果按来源版本缓存复用</span>
      </div>
      <div class="toolbar-actions">
        <t-button variant="outline" :icon="DownloadIcon" @click="sync.loadDemo('duplicate')">载入重复版本包</t-button>
        <t-button variant="outline" :icon="DownloadIcon" @click="sync.loadDemo('concurrent')">载入同主题并发包</t-button>
        <t-button variant="outline" :icon="DownloadIcon" @click="sync.loadDemo('different')">载入跨主题并发包</t-button>
        <t-button variant="outline" :icon="RefreshIcon" @click="sync.resetInbox()">重置收件箱</t-button>
        <t-button theme="primary" :icon="UploadIcon" @click="submitAllInbox">按顺序提交全部</t-button>
      </div>
    </div>

    <div class="sync-grid">
      <!-- 左：收件包列表 -->
      <section class="panel inbox-panel">
        <div class="panel-head">
          <div><strong>待导入包</strong><span>{{ sync.inbox.length }} 个等待处理</span></div>
        </div>
        <div class="inbox-list">
          <button
            v-for="pkg in [...sync.inbox].sort((a, b) => a.submittedAt - b.submittedAt || a.packageId.localeCompare(b.packageId))"
            :key="pkg.packageId"
            :class="{ active: pkg.packageId === selectedId }"
            @click="selectedId = pkg.packageId"
          >
            <div class="inbox-row-head">
              <t-tag size="small" theme="primary" variant="light">{{ themeLabels[pkg.theme] ?? pkg.theme }}</t-tag>
              <code>{{ pkg.packageId }}</code>
              <span class="inbox-time">{{ fmtTime(pkg.submittedAt) }}</span>
            </div>
            <strong>{{ pkg.scenario ?? pkg.note ?? pkg.sourceVersion }}</strong>
            <span class="inbox-version">来源版本 {{ pkg.sourceVersion }} · {{ pkg.entries.length }} 条目</span>
          </button>
          <p v-if="!sync.inbox.length" class="empty">收件箱已清空，可从顶部载入演示包或粘贴 JSON。</p>
        </div>
        <div class="json-import">
          <div class="panel-head"><div><strong>粘贴外部包 JSON</strong><span>增量同步到当前工作区</span></div></div>
          <t-textarea v-model="importJson" :autosize="{ minRows: 4 }" placeholder='{"packageId":"PKG-x","theme":"light","sourceVersion":"brand/x","entries":[...]}' />
          <p v-if="importError" class="import-error">{{ importError }}</p>
          <t-button size="small" theme="primary" variant="outline" @click="importFromJson">加入收件箱</t-button>
        </div>
      </section>

      <!-- 中：预检与解析计划 -->
      <section class="panel plan-panel">
        <div class="panel-head">
          <div><strong>提交前预检（按主题解析，不写入）</strong><span v-if="selected">{{ selected.packageId }} · {{ selected.sourceVersion }}</span></div>
          <div v-if="selected" class="plan-actions">
            <t-button size="small" variant="outline" @click="submitConcurrent">并发提交选中组</t-button>
            <t-button size="small" theme="primary" :icon="UploadIcon" @click="submit(selected)">提交整包</t-button>
          </div>
        </div>

        <template v-if="selected && previewPlan">
          <div class="gate-summary">
            <div :class="['gate', previewPlan.errors.length ? 'bad' : 'good']">
              <component :is="previewPlan.errors.length ? CloseCircleIcon : CheckCircleIcon" />
              <strong>{{ previewPlan.errors.length ? '整包拒绝写入' : '门禁通过，可提交' }}</strong>
              <span>{{ previewPlan.errors.length ? '引用 / 对比度错误阻断提交' : '悬空引用、循环引用、AA 对比度均通过' }}</span>
            </div>
            <div class="gate-metrics">
              <div><span>计划更新</span><strong>{{ previewPlan.updates.filter(u => !u.recomputed).length }}</strong></div>
              <div><span>自动重算</span><strong>{{ previewPlan.updates.filter(u => u.recomputed).length }}</strong></div>
              <div><span>缓存命中</span><strong>{{ previewPlan.cacheHits }}</strong></div>
              <div><span>待复核</span><strong :class="{ warn: previewPlan.reviews.length }">{{ previewPlan.reviews.length }}</strong></div>
            </div>
          </div>

          <div v-if="previewPlan.errors.length" class="issue-list error">
            <div v-for="(issue, i) in previewPlan.errors" :key="i" class="issue-row">
              <CloseCircleIcon />
              <div><strong>{{ themeLabels[issue.theme] ?? issue.theme }} 主题 · {{ issue.id }}</strong><span>{{ issue.message }}</span></div>
            </div>
          </div>
          <div v-if="previewPlan.warnings.length" class="issue-list warning">
            <div v-for="(issue, i) in previewPlan.warnings" :key="i" class="issue-row">
              <CheckCircleIcon />
              <div><strong>品牌覆盖保留 · {{ issue.id }}</strong><span>{{ issue.message }}</span></div>
            </div>
          </div>

          <div class="update-list">
            <div v-for="update in previewPlan.updates" :key="`${update.id}-${update.kind}`" class="update-row" :class="{ review: update.needsReview, recompute: update.recomputed }">
              <div class="update-main">
                <div class="update-id">
                  <t-tag size="small" :variant="update.kind === 'base' ? 'dark' : 'light'">{{ update.kind === 'base' ? '基础令牌' : update.kind === 'semantic' ? '语义别名' : '组件别名' }}</t-tag>
                  <code>{{ update.id }}</code>
                  <t-tag v-if="update.recomputed" size="small" theme="warning" variant="light">自动重算</t-tag>
                  <t-tag v-if="update.brandOverride" size="small" theme="primary" variant="light">品牌覆盖</t-tag>
                  <t-tag v-if="update.fromCache" size="small" theme="success" variant="light">缓存结果</t-tag>
                  <t-tag v-if="update.isBaseChange" size="small" theme="danger" variant="light">基础值变更</t-tag>
                </div>
                <div class="chain">
                  <template v-for="(node, idx) in update.resolved.chain" :key="node">
                    <code>{{ node }}</code>
                    <span v-if="idx < update.resolved.chain.length - 1">→</span>
                  </template>
                  <strong v-if="update.resolved.literal" class="literal">= {{ update.resolved.literal }}</strong>
                </div>
              </div>
              <div class="update-side">
                <del v-if="update.oldRaw !== undefined && update.oldRaw !== update.raw">{{ update.oldRaw }}</del>
                <ins>{{ update.needsReview ? '保留原值 · 待复核' : update.raw }}</ins>
              </div>
            </div>
          </div>
        </template>
        <p v-else class="empty">从左侧选择一个主题包查看解析计划。</p>
      </section>

      <!-- 右：复核、冲突、记录 -->
      <aside class="sync-side">
        <div class="panel review-panel">
          <div class="panel-head"><div><strong>品牌覆盖待复核</strong><span>基础令牌改动后覆盖保留</span></div><t-tag :theme="tokens.reviewQueue.length ? 'warning' : 'success'">{{ tokens.reviewQueue.length }}</t-tag></div>
          <div v-for="row in tokens.reviewQueue" :key="`${row.theme}-${row.token.id}`" class="review-item">
            <div><t-tag size="small" theme="warning" variant="light">{{ themeLabels[row.theme] }}</t-tag><code>{{ row.token.id }}</code><span class="review-ver">{{ row.sourceVersion }}</span></div>
            <div class="review-actions">
              <t-button size="small" variant="outline" @click="recomputeReview(row.theme, row.token.id)">按引用重算</t-button>
              <t-button size="small" theme="primary" variant="outline" @click="keepReview(row.theme, row.token.id)">保留覆盖</t-button>
            </div>
          </div>
          <p v-if="!tokens.reviewQueue.length" class="empty">没有待复核的品牌覆盖。</p>
        </div>

        <div class="panel conflict-panel">
          <div class="panel-head"><div><strong>并发冲突项</strong><span>后到包只留下这些差异</span></div><t-tag theme="danger">{{ sync.recentConflicts.length }}</t-tag></div>
          <div v-for="conflict in sync.recentConflicts" :key="`${conflict.loserPackageId}-${conflict.id}`" class="conflict-item">
            <code>{{ conflict.id }}</code>
            <div class="conflict-values"><span>生效 <ins>{{ conflict.winnerValue }}</ins></span><span>后到 <del>{{ conflict.loserValue }}</del></span></div>
            <small>{{ conflict.winnerPackageId }} 胜 · {{ conflict.loserPackageId }} 拒绝</small>
            <t-button size="small" variant="text" @click="sync.dismissConflict(`${conflict.loserPackageId}:${conflict.id}`)">忽略</t-button>
          </div>
          <p v-if="!sync.recentConflicts.length" class="empty">暂无冲突。同主题并发提交时此处会保留差异。</p>
        </div>

        <div class="panel record-panel">
          <div class="panel-head"><div><strong>导入记录</strong><span>先到生效 / 失败整包不写入</span></div></div>
          <div v-for="record in sync.records.slice(0, 8)" :key="`${record.packageId}-${record.at}`" class="record-row">
            <component :is="record.status === 'applied' ? CheckCircleIcon : CloseCircleIcon" :class="record.status" />
            <div>
              <strong>{{ record.packageId }} · {{ themeLabels[record.theme] }}</strong>
              <span>{{ record.sourceVersion }} · 更新 {{ record.updateCount }} · 冲突 {{ record.conflictCount }}</span>
              <small v-if="record.reason">{{ record.reason }}</small>
            </div>
          </div>
          <p v-if="!sync.records.length" class="empty">尚无提交记录。</p>
        </div>
      </aside>
    </div>
  </div>
</template>

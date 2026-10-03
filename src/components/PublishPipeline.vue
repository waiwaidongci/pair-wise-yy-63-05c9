<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useSyncStore } from '../sync/syncStore';
import { useTokenStore } from '../store';

const sync = useSyncStore();
const tokens = useTokenStore();

const version = ref(tokens.releaseVersion);
const writing = ref(false);
const snapshotTheme = ref('ops');
const expandedSnapshot = ref<string | null>(null);

const themeLabels: Record<string, string> = {
  light: '明亮',
  dark: '暗色',
  ops: '运营',
  contrast: '高对比'
};

const contrastRows = computed(() => {
  const themes = sync.journal?.themes?.length
    ? sync.journal.themes
    : [...new Set(sync.records.filter((r) => r.status === 'applied').map((r) => r.theme))];
  return themes.map((theme) => ({
    theme,
    rows: tokens.themeContrast(theme)
  }));
});

const appliedRecords = computed(() => sync.records.filter((r) => r.status === 'applied'));

async function start() {
  const result = sync.startPublish(version.value);
  if (!result.ok) {
    MessagePlugin.error(result.error ?? '发布校验未通过');
    return;
  }
  MessagePlugin.success('快照校验通过，开始按包号写入发布目标');
  await autoWrite(false);
}

async function autoWrite(fail: boolean) {
  if (!sync.journal) return;
  writing.value = true;
  try {
    while (sync.journal && sync.journal.status === 'writing') {
      const failThis = fail && sync.journal.appliedUpTo === 1; // 第 2 包模拟失败
      await sync.writeNextPackage(failThis);
      if (failThis) break;
    }
    if (sync.journal?.status === 'failed') MessagePlugin.warning(sync.journal.error ?? '写入失败');
    if (sync.journal?.status === 'done') MessagePlugin.success(`快照 ${sync.journal.snapshot?.snapshotId} 已生成`);
  } finally {
    writing.value = false;
  }
}

async function step(fail: boolean) {
  writing.value = true;
  try {
    await sync.writeNextPackage(fail);
    if (sync.journal?.status === 'failed') MessagePlugin.warning(sync.journal.error ?? '写入失败');
    if (sync.journal?.status === 'done') MessagePlugin.success('全部包写入完成，快照已生成');
  } finally {
    writing.value = false;
  }
}

function resume() {
  sync.resumePublish();
  MessagePlugin.success('已重开，从失败包号继续写入');
}
function abandon() {
  sync.abandonPublish();
  MessagePlugin.info('已放弃本次发布');
}

function fmt(at: number) {
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="pipeline-page">
    <div class="panel pipeline-main">
      <div class="panel-head">
        <div><strong>发布快照流水线</strong><span>校验引用与对比度 → 按包号逐包写入 → 失败按包号恢复，重开续传</span></div>
        <t-tag :theme="sync.hasOpenJournal ? (sync.journal?.status === 'failed' ? 'danger' : 'warning') : 'success'">
          {{ sync.journal?.status === 'failed' ? '写入失败 · 待恢复' : sync.journal?.status === 'writing' ? '写入中' : sync.journal?.status === 'done' ? '已完成' : '空闲' }}
        </t-tag>
      </div>

      <!-- 阶段一：校验 -->
      <div class="stage">
        <h4><i class="stage-no">1</i> 发布前校验（所有已导入主题）</h4>
        <div class="contrast-grid">
          <div v-for="group in contrastRows" :key="group.theme" class="contrast-card">
            <strong>{{ themeLabels[group.theme] ?? group.theme }} 主题</strong>
            <div v-for="row in group.rows" :key="row.label" class="contrast-line">
              <span>{{ row.label }}</span>
              <t-tag size="small" :theme="row.pass ? 'success' : 'danger'">{{ row.ratio === null ? '非颜色' : `${row.ratio.toFixed(2)}:1` }}</t-tag>
            </div>
          </div>
          <p v-if="!contrastRows.length" class="empty">尚未导入任何主题包。</p>
        </div>
        <div class="review-gate">
          <t-tag size="small" :theme="sync.pendingReviews.length ? 'warning' : 'success'">
            {{ sync.pendingReviews.length ? `${sync.pendingReviews.length} 项待复核，发布将被阻断` : '品牌覆盖复核已清空' }}
          </t-tag>
        </div>
      </div>

      <!-- 阶段二：写入 -->
      <div class="stage">
        <h4><i class="stage-no">2</i> 按包号写入（{{ appliedRecords.length }} 个已导入包）</h4>
        <div v-if="!sync.journal" class="publish-start">
          <t-input v-model="version" style="width: 200px" />
          <t-button theme="primary" :loading="writing" :disabled="!appliedRecords.length" @click="start">校验并开始发布</t-button>
          <t-button variant="outline" :disabled="!appliedRecords.length" @click="autoWrite(true)">模拟：第 2 包写入失败</t-button>
        </div>

        <div v-else class="journal">
          <div class="package-progress">
            <template v-for="(packageId, index) in sync.journal.packageIds" :key="packageId">
              <div class="pkg-step" :class="{
                done: index < sync.journal.appliedUpTo,
                active: index === sync.journal.appliedUpTo && sync.journal.status === 'writing',
                failed: index === sync.journal.failedAtPackage
              }">
                <i>{{ index + 1 }}</i>
                <code>{{ packageId }}</code>
                <small>{{ themeLabels[sync.journal.themes[index]] ?? sync.journal.themes[index] }}</small>
                <span>{{ index < sync.journal.appliedUpTo ? '已写入' : index === sync.journal.failedAtPackage ? '失败已回滚' : '等待' }}</span>
              </div>
              <span v-if="index < sync.journal.packageIds.length - 1" class="pkg-arrow">—</span>
            </template>
          </div>

          <div v-if="sync.journal.status === 'failed'" class="failure-box">
            <strong>写入失败，已按包号恢复检查点</strong>
            <p>{{ sync.journal.error }}</p>
            <p class="hint">前 {{ sync.journal.failedAtPackage }} 个包的写入结果保留；关闭页面重开后仍可从第 {{ (sync.journal.failedAtPackage ?? 0) + 1 }} 包继续。</p>
            <div>
              <t-button theme="primary" @click="resume">重开续传（从失败包号继续）</t-button>
              <t-button variant="outline" :loading="writing" @click="step(false)">手动写入当前包</t-button>
              <t-button theme="danger" variant="outline" @click="abandon">放弃发布</t-button>
            </div>
          </div>

          <div v-else-if="sync.journal.status === 'writing'" class="write-controls">
            <t-button :loading="writing" theme="primary" @click="step(false)">写入第 {{ sync.journal.appliedUpTo + 1 }} 包</t-button>
            <t-button :loading="writing" variant="outline" @click="step(true)">该包写入失败（演示恢复）</t-button>
            <span class="hint">每个包落盘前记录检查点，失败只回滚当前包。</span>
          </div>

          <div v-else class="success-box">
            <strong>全部包写入完成</strong>
            <span>快照 ID {{ sync.journal.snapshot?.snapshotId }} · 生成于 {{ fmt(sync.journal.snapshot?.createdAt ?? Date.now()) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 快照内容：各主题最终值 + 引用链 -->
    <div class="panel snapshot-panel">
      <div class="panel-head">
        <div><strong>发布快照</strong><span>每个主题的最终值、来源版本与完整引用链</span></div>
        <t-select v-if="sync.snapshots.length" :value="sync.snapshots[0].snapshotId" style="width: 260px"
          :options="sync.snapshots.map(s => ({ label: `${s.version} · ${s.snapshotId}`, value: s.snapshotId }))" />
      </div>
      <div v-if="sync.journal?.status === 'done' && sync.journal.snapshot" class="snapshot-body">
        <div class="snapshot-meta">
          <t-tag v-for="theme in sync.journal.snapshot.themes" :key="theme" theme="primary" variant="light">{{ themeLabels[theme] ?? theme }}</t-tag>
          <span>包含包：{{ sync.journal.snapshot.packageIds.join('、') }}</span>
        </div>
        <t-radio-group v-model="snapshotTheme" size="small" class="snapshot-theme-tabs">
          <t-radio-button v-for="theme in sync.journal.snapshot.themes" :key="theme" :value="theme">{{ themeLabels[theme] ?? theme }}</t-radio-button>
        </t-radio-group>
        <div class="snapshot-rows">
          <div v-for="row in sync.journal.snapshot.rows" :key="row.id" class="snapshot-row" v-show="row.themes[snapshotTheme]">
            <code>{{ row.id }}</code>
            <template v-if="row.themes[snapshotTheme]">
              <ins class="snap-literal">{{ row.themes[snapshotTheme].literal ?? '（未解析）' }}</ins>
              <span class="snap-chain">{{ row.themes[snapshotTheme].chain.join(' → ') }}</span>
              <t-tag size="small" variant="light">{{ row.themes[snapshotTheme].sourceVersion ?? '本地' }}</t-tag>
              <t-tag v-if="row.themes[snapshotTheme].brandOverride" size="small" theme="primary" variant="light">品牌覆盖</t-tag>
            </template>
          </div>
        </div>
      </div>
      <p v-else class="empty">完成一次发布后，这里展示只读快照（各主题最终值与引用链）。</p>
    </div>
  </div>
</template>

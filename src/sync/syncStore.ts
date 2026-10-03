import { defineStore } from 'pinia';
import { useTokenStore } from '../store';
import {
  buildSnapshot,
  planImport,
  type ConflictItem,
  type ImportIssue,
  type ImportPlan,
  type PackageRecord,
  type ResolvedRef,
  type Snapshot,
  type ThemePackage
} from './engine';
import { concurrentDifferentThemes, concurrentPair, duplicateVersionPackage, sampleInbox } from './samples';

type QueuePackage = ThemePackage & { scenario?: string };

type PackageWrite = {
  packageId: string;
  theme: string;
  /** 该包要写入发布目标的条目（按应用顺序） */
  updates: { id: string; raw: string }[];
};

export type PublishJournal = {
  version: string;
  status: 'writing' | 'failed' | 'done';
  packageIds: string[];
  themes: string[];
  /** 每个包的写入内容（第 n 包的检查点：恢复到它开写之前只需丢弃包内已写条目） */
  writes: PackageWrite[];
  /** 发布目标已收到的内容：theme -> id -> raw */
  target: Record<string, Record<string, string>>;
  appliedUpTo: number;
  failedAtPackage: number | null;
  error?: string;
  snapshot?: Snapshot;
  startedAt: number;
};

const storageKey = 'yy63-brand-sync';

type PersistShape = {
  inbox: QueuePackage[];
  records: PackageRecord[];
  conflicts: ConflictItem[];
  cache: Record<string, ResolvedRef>;
  journal?: PublishJournal | null;
  snapshots: Snapshot[];
};

function load(): PersistShape {
  const inbox = sampleInbox();
  const base: PersistShape = {
    inbox,
    records: [],
    conflicts: [],
    cache: {},
    journal: null,
    snapshots: []
  };
  if (typeof localStorage === 'undefined') return base;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return base;
  try {
    const saved = JSON.parse(raw) as PersistShape;
    return { ...base, ...saved, inbox: saved.inbox?.length ? saved.inbox : inbox };
  } catch {
    return base;
  }
}

export const useSyncStore = defineStore('brand-sync', {
  state: () => ({
    ...load(),
    previewing: null as ImportPlan | null,
    previewError: '' as string,
    simulatingWriteFailure: false,
    simulatingFailureCount: 0
  }),
  getters: {
    pendingReviews: () => {
      const tokens = useTokenStore();
      return tokens.reviewQueue;
    },
    hasOpenJournal(state): boolean {
      return state.journal?.status === 'writing' || state.journal?.status === 'failed';
    },
    recentConflicts(state): ConflictItem[] {
      return state.conflicts.filter((item) => !item.dismissed);
    }
  },
  actions: {
    persist() {
      if (typeof localStorage === 'undefined') return;
      const payload: PersistShape = {
        inbox: this.inbox,
        records: this.records,
        conflicts: this.conflicts,
        cache: this.cache,
        journal: this.journal,
        snapshots: this.snapshots
      };
      localStorage.setItem(storageKey, JSON.stringify(payload));
    },

    lookup() {
      const tokens = useTokenStore();
      return (theme: string, id: string) => {
        const token = tokens.tokens.find((item) => item.id === id);
        return token ? (token.themes[theme] ?? token.value) : undefined;
      };
    },

    allIds(): string[] {
      return useTokenStore().tokens.map((token) => token.id);
    },

    hasBrandOverride(theme: string, id: string): boolean {
      const token = useTokenStore().tokens.find((item) => item.id === id);
      return token?.provenance?.[theme]?.brandOverride === true;
    },

    /** 预检（不落库）：打开提交前的解析计划，展示解析结果、缓存命中与门禁错误。 */
    preview(pkg: ThemePackage) {
      const { plan } = planImport(pkg, this.lookup(), this.cache, this.hasBrandOverride.bind(this), this.allIds());
      this.previewing = plan;
      this.previewError = plan.errors.length ? plan.errors.map((e) => e.message).join('；') : '';
      return plan;
    },

    clearPreview() {
      this.previewing = null;
      this.previewError = '';
    },

    /** 单包提交：失败整包拒绝写入（解析缓存也不保留成功条目）。 */
    submitOne(pkg: ThemePackage): { ok: boolean; plan: ImportPlan } {
      return this.runBatch([pkg]);
    },

    /**
     * 批量提交（含两包同时到达）：
     * - 同 submittedAt 的包按包号排序，先到者生效；
     * - 同批中后到者若与先到者同主题、同令牌且取值不同，整包拒绝，只留冲突项；
     * - 不同主题的并发包互不影响，各自校验生效。
     */
    submitBatch(packages: ThemePackage[], removeFromInbox = true): void {
      this.runBatch(packages, removeFromInbox);
    },

    runBatch(packages: ThemePackage[], removeFromInbox = true): { ok: boolean; plan: ImportPlan } {
      const ordered = [...packages].sort((a, b) =>
        a.submittedAt === b.submittedAt ? a.packageId.localeCompare(b.packageId) : a.submittedAt - b.submittedAt
      );

      // 识别同时间分组，用于先到/后到判定。
      const timeGroups = new Map<number, ThemePackage[]>();
      ordered.forEach((pkg) => {
        const list = timeGroups.get(pkg.submittedAt) ?? [];
        list.push(pkg);
        timeGroups.set(pkg.submittedAt, list);
      });

      let lastPlan: ImportPlan | null = null;

      for (const pkg of ordered) {
        const sameTime = (timeGroups.get(pkg.submittedAt) ?? []).filter((item) => item.packageId !== pkg.packageId);
        const earlier = sameTime
          .slice()
          .sort((a, b) => a.packageId.localeCompare(b.packageId))
          .filter((item) => item.packageId.localeCompare(pkg.packageId) < 0);

        // 与本批先到者逐条比较：同主题 + 同令牌 + 不同值 => 冲突，后到包整体不生效。
        const clashes: ConflictItem[] = [];
        if (earlier.some((item) => item.theme === pkg.theme)) {
          for (const entry of pkg.entries) {
            for (const winner of earlier) {
              if (winner.theme !== pkg.theme) continue;
              const winnerEntry = winner.entries.find((item) => item.id === entry.id);
              if (winnerEntry && winnerEntry.value !== entry.value) {
                clashes.push({
                  id: entry.id,
                  theme: pkg.theme,
                  winnerPackageId: winner.packageId,
                  loserPackageId: pkg.packageId,
                  winnerValue: winnerEntry.value,
                  loserValue: entry.value,
                  at: pkg.submittedAt
                });
              }
            }
          }
        }

        if (clashes.length) {
          this.conflicts.unshift(...clashes);
          this.records.unshift({
            packageId: pkg.packageId,
            theme: pkg.theme,
            sourceVersion: pkg.sourceVersion,
            status: 'rejected',
            reason: `与先到包 ${clashes[0].winnerPackageId} 冲突，整包未写入，保留 ${clashes.length} 个冲突项`,
            updateCount: 0,
            reviewCount: 0,
            conflictCount: clashes.length,
            at: pkg.submittedAt,
            note: pkg.note
          });
          this.removeInbox(pkg.packageId, removeFromInbox);
          this.persist();
          const { plan } = planImport(pkg, this.lookup(), this.cache, this.hasBrandOverride.bind(this), this.allIds());
          lastPlan = plan;
          continue;
        }

        const { plan, newCache } = planImport(
          pkg,
          this.lookup(),
          this.cache,
          this.hasBrandOverride.bind(this),
          this.allIds()
        );
        lastPlan = plan;

        if (plan.errors.length) {
          // 整包不写入：newCache 直接丢弃，成功条目也不保留解析结果。
          this.records.unshift({
            packageId: pkg.packageId,
            theme: pkg.theme,
            sourceVersion: pkg.sourceVersion,
            status: 'rejected',
            reason: plan.errors.map((e) => e.message).join('；'),
            updateCount: 0,
            reviewCount: 0,
            conflictCount: 0,
            at: pkg.submittedAt,
            note: pkg.note
          });
          this.removeInbox(pkg.packageId, removeFromInbox);
          this.persist();
          continue;
        }

        this.applyPlan(plan, newCache);
        this.records.unshift({
          packageId: pkg.packageId,
          theme: pkg.theme,
          sourceVersion: pkg.sourceVersion,
          status: 'applied',
          updateCount: plan.updates.filter((u) => !u.recomputed).length,
          reviewCount: plan.reviews.length,
          conflictCount: 0,
          at: pkg.submittedAt,
          note: pkg.note
        });
        this.removeInbox(pkg.packageId, removeFromInbox);
        this.persist();
      }

      const tokens = useTokenStore();
      tokens.persist();
      return { ok: !lastPlan?.errors.length, plan: lastPlan! };
    },

    applyPlan(plan: ImportPlan, newCache: Record<string, ResolvedRef>) {
      const tokenStore = useTokenStore();
      for (const update of plan.updates) {
        const token = tokenStore.tokens.find((item) => item.id === update.id);
        if (!token) continue;
        if (!token.themes) token.themes = {};
        if (!token.provenance) token.provenance = {};

        if (update.needsReview) {
          // 品牌覆盖保留：不改动主题原始值，仅标记待复核。
          token.provenance[update.theme] = {
            ...(token.provenance[update.theme] ?? {}),
            packageId: plan.pkg.packageId,
            sourceVersion: plan.pkg.sourceVersion,
            importedAt: plan.pkg.submittedAt,
            brandOverride: true,
            needsReview: true
          };
          continue;
        }

        token.themes[update.theme] = update.raw;
        token.provenance[update.theme] = {
          packageId: plan.pkg.packageId,
          sourceVersion: plan.pkg.sourceVersion,
          importedAt: plan.pkg.submittedAt,
          brandOverride: update.brandOverride || undefined,
          needsReview: false
        };
      }
      Object.assign(this.cache, newCache);
    },

    /** 待复核处理：保留覆盖（继续挂起）或按引用重算。 */
    resolveReview(theme: string, id: string, action: 'keep' | 'recompute') {
      const tokenStore = useTokenStore();
      const token = tokenStore.tokens.find((item) => item.id === id);
      const source = token?.provenance?.[theme];
      if (!token || !source) return;
      if (action === 'keep') {
        source.needsReview = false;
      } else {
        const suggested = suggestedRaw(id);
        if (suggested) token.themes[theme] = suggested;
        source.needsReview = false;
        source.brandOverride = false;
        source.sourceVersion = `${source.sourceVersion ?? ''} · 已重算`;
      }
      tokenStore.persist();
      this.persist();
    },

    removeInbox(packageId: string, remove: boolean) {
      if (!remove) return;
      this.inbox = this.inbox.filter((item) => item.packageId !== packageId);
    },

    dismissConflict(indexKey: string) {
      const item = this.conflicts.find((c) => `${c.loserPackageId}:${c.id}` === indexKey);
      if (item) item.dismissed = true;
      this.persist();
    },

    loadDemo(kind: 'duplicate' | 'concurrent' | 'different') {
      if (kind === 'duplicate') this.inbox.push(duplicateVersionPackage() as QueuePackage);
      if (kind === 'concurrent') concurrentPair().forEach((pkg) => this.inbox.push(pkg as QueuePackage));
      if (kind === 'different') concurrentDifferentThemes().forEach((pkg) => this.inbox.push(pkg as QueuePackage));
      this.persist();
    },

    resetInbox() {
      this.inbox = sampleInbox();
      this.persist();
    },

    // ---- 发布快照：校验 → 逐包写入 → 失败按包号恢复 -----------------------

    startPublish(version: string): { ok: boolean; error?: string } {
      if (this.hasOpenJournal) return { ok: false, error: '存在未完成的发布，请先恢复或放弃后再发布' };
      if (this.pendingReviews.length) {
        return { ok: false, error: `仍有 ${this.pendingReviews.length} 项品牌覆盖待复核，请处理后再发布` };
      }

      const applied = this.records.filter((record) => record.status === 'applied');
      if (!applied.length) return { ok: false, error: '尚无已导入的主题包，无法生成快照' };

      const themes = [...new Set(applied.map((record) => record.theme))];
      const packageIds = applied.map((record) => record.packageId);

      // 快照校验阶段：所有已生效主题都要过引用与 AA 门禁。
      const tokenStore = useTokenStore();
      const errors: ImportIssue[] = [];
      themes.forEach((theme) => {
        tokenStore.themeContrast(theme).forEach((item) => {
          if (!item.pass) {
            errors.push({
              level: 'error',
              code: 'contrast',
              theme,
              message: `${theme} 主题${item.label}对比度 ${item.ratio?.toFixed(2)}:1，低于 4.5:1`
            });
          }
        });
        tokenStore.tokens.forEach((token) => {
          const raw = token.themes[theme];
          if (!raw) return;
          const ref = raw.trim().match(/^\{([^{}]+)\}$/);
          if (ref && !tokenStore.tokens.some((item) => item.id === ref[1].trim())) {
            errors.push({ level: 'error', code: 'unresolved', theme, id: token.id, message: `${theme} 主题 ${token.id} 引用悬空` });
          }
        });
      });
      if (errors.length) return { ok: false, error: errors.map((e) => e.message).join('；') };

      // 每个包重放为一次写入：按包号逐包写入发布目标，失败只回滚该包。
      const writes: PackageWrite[] = packageIds.map((packageId) => {
        const record = this.records.find((item) => item.packageId === packageId)!;
        const tokenStore = useTokenStore();
        const updates: { id: string; raw: string }[] = [];
        tokenStore.tokens.forEach((token) => {
          const raw = token.themes[record.theme];
          if (raw !== undefined) updates.push({ id: token.id, raw });
        });
        return { packageId, theme: record.theme, updates };
      });

      this.journal = {
        version,
        status: 'writing',
        packageIds,
        themes,
        writes,
        target: {},
        appliedUpTo: 0,
        failedAtPackage: null,
        startedAt: Date.now()
      };
      this.persist();
      return { ok: true };
    },

    /** 模拟逐包写入。failNext=true 时下一包写入失败，按包号恢复后可续传。 */
    async writeNextPackage(failNext = false): Promise<void> {
      if (!this.journal || this.journal.status !== 'writing') return;
      await new Promise((resolve) => setTimeout(resolve, 420));
      const index = this.journal.appliedUpTo;
      if (index >= this.journal.packageIds.length) {
        this.finishPublish();
        return;
      }
      const write = this.journal.writes[index];
      if (failNext) {
        // 该包部分写入后失败：先模拟落了一半，再按包号恢复到该包开写前。
        if (!this.journal.target[write.theme]) this.journal.target[write.theme] = {};
        const half = write.updates.slice(0, Math.max(1, Math.floor(write.updates.length / 2)));
        half.forEach(({ id, raw }) => {
          this.journal!.target[write.theme][id] = raw;
        });
        half.forEach(({ id }) => {
          delete this.journal!.target[write.theme][id];
        });
        this.journal.status = 'failed';
        this.journal.failedAtPackage = index;
        this.journal.error = `第 ${index + 1}/${this.journal.packageIds.length} 包（${write.packageId} · ${write.theme}）写入失败：目标存储不可用，已按包号恢复检查点，前 ${index} 包保留，可重开续传`;
        this.persist();
        return;
      }
      if (!this.journal.target[write.theme]) this.journal.target[write.theme] = {};
      write.updates.forEach(({ id, raw }) => {
        this.journal!.target[write.theme][id] = raw;
      });
      this.journal.appliedUpTo = index + 1;
      this.persist();
      if (this.journal.appliedUpTo >= this.journal.packageIds.length) this.finishPublish();
    },

    targetLookup() {
      const journal = this.journal;
      const workspace = this.lookup();
      return (theme: string, id: string): string | undefined =>
        journal?.target[theme]?.[id] ?? workspace(theme, id);
    },

    finishPublish() {
      if (!this.journal) return;
      const tokenStore = useTokenStore();
      const snapshot = buildSnapshot(
        this.journal.version,
        this.journal.packageIds,
        this.journal.themes,
        tokenStore.tokens.map((token) => ({
          id: token.id,
          name: token.name,
          category: token.category,
          provenance: token.provenance
        })),
        this.targetLookup()
      );
      this.journal.status = 'done';
      this.journal.snapshot = snapshot;
      this.snapshots.unshift(snapshot);
      tokenStore.locked = true;
      tokenStore.lastPublished = `DS ${this.journal.version}`;
      tokenStore.persist();
      this.persist();
    },

    /** 写入失败后续传：从失败包号重开继续，已成功的包不重写。 */
    resumePublish() {
      if (!this.journal || this.journal.status !== 'failed') return;
      this.journal.status = 'writing';
      this.journal.error = undefined;
      this.journal.failedAtPackage = null;
      this.persist();
    },

    abandonPublish() {
      this.journal = null;
      this.persist();
    }
  }
});

/** 重算建议：按别名约定回到标准引用。 */
function suggestedRaw(id: string): string | null {
  if (id === 'component.button.primary.bg') return '{color.semantic.primary}';
  if (id === 'color.semantic.primary') return '{color.base.blue.600}';
  return null;
}

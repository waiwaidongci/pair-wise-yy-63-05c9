import { defineStore } from 'pinia';
import {
  buildSnapshot,
  contrastRatio,
  inferKind,
  mergePackage,
  packageKey,
  recomputeDependents,
  reduceToConflicts,
  THEME_NAMES,
  validatePackage,
  type ConflictItem,
  type PackageRecord,
  type Snapshot,
  type ThemePackage,
  type TxRecord
} from './themeSync';

export type TokenCategory = 'color' | 'font' | 'spacing' | 'radius' | 'shadow' | 'component';
export type Token = {
  id: string;
  name: string;
  category: TokenCategory;
  value: string;
  ref?: string;
  themes: Record<string, string>;
  usage: number;
  status: 'stable' | 'deprecated' | 'proposed';
  description: string;
  kind?: 'base' | 'semantic' | 'component';
  sourceVersion?: string;
  overrides?: Record<string, boolean>;
  reviewStatus?: 'ok' | 'pending';
};

export type ChangeRequest = {
  id: string;
  title: string;
  requester: string;
  scope: string;
  impact: number;
  status: '待评审' | '已接受' | '已退回';
  diff: { token: string; before: string; after: string };
};

const initialTokens: Token[] = [
  { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#2864dc', themes: { light: '#2864dc', dark: '#6f96ff', ops: '#24786a', contrast: '#0b4dba' }, usage: 184, status: 'stable', description: '主操作、链接和重点状态' },
  { id: 'color.semantic.primary', name: '语义主色', category: 'color', value: '{color.base.blue.600}', ref: 'color.base.blue.600', themes: { light: '{color.base.blue.600}', dark: '{color.base.blue.400}', ops: '{color.base.green.600}', contrast: '{color.base.blue.800}' }, usage: 126, status: 'stable', description: '组件库统一主色别名' },
  { id: 'color.base.blue.400', name: '品牌蓝 400', category: 'color', value: '#6f96ff', themes: { light: '#6f96ff', dark: '#6f96ff', ops: '#58a99a', contrast: '#2878e8' }, usage: 42, status: 'stable', description: '暗色主题主色' },
  { id: 'color.base.blue.800', name: '品牌蓝 800', category: 'color', value: '#0b4dba', themes: { light: '#0b4dba', dark: '#9ab9ff', ops: '#145c51', contrast: '#06358a' }, usage: 31, status: 'stable', description: '高对比主题主色' },
  { id: 'color.base.green.600', name: '运营绿 600', category: 'color', value: '#24786a', themes: { light: '#24786a', dark: '#54b2a0', ops: '#24786a', contrast: '#0d5a4d' }, usage: 67, status: 'proposed', description: '运营产品品牌替换色' },
  { id: 'color.text.primary', name: '正文主色', category: 'color', value: '#17202b', themes: { light: '#17202b', dark: '#f5f7fa', ops: '#152a25', contrast: '#000000' }, usage: 293, status: 'stable', description: '主要正文和标题' },
  { id: 'color.text.secondary', name: '正文次色', category: 'color', value: '#667582', themes: { light: '#667582', dark: '#a8b2bd', ops: '#62766f', contrast: '#303b46' }, usage: 211, status: 'stable', description: '辅助信息和说明' },
  { id: 'color.surface.canvas', name: '页面背景', category: 'color', value: '#f2f5f7', themes: { light: '#f2f5f7', dark: '#121821', ops: '#f1f6f4', contrast: '#ffffff' }, usage: 54, status: 'stable', description: '应用一级背景' },
  { id: 'font.family.sans', name: '无衬线字体', category: 'font', value: '"Noto Sans SC", sans-serif', themes: { light: '"Noto Sans SC", sans-serif', dark: '"Noto Sans SC", sans-serif', ops: '"Noto Sans SC", sans-serif', contrast: 'system-ui, sans-serif' }, usage: 388, status: 'stable', description: '产品界面默认真体' },
  { id: 'font.size.body', name: '正文字号', category: 'font', value: '14px', themes: { light: '14px', dark: '14px', ops: '14px', contrast: '16px' }, usage: 255, status: 'stable', description: '正文与表单文本' },
  { id: 'spacing.base.2', name: '基础间距 2', category: 'spacing', value: '8px', themes: { light: '8px', dark: '8px', ops: '8px', contrast: '8px' }, usage: 312, status: 'stable', description: '紧凑布局基础间距' },
  { id: 'radius.control', name: '控件圆角', category: 'radius', value: '6px', themes: { light: '6px', dark: '6px', ops: '4px', contrast: '4px' }, usage: 167, status: 'stable', description: '按钮、输入框和卡片' },
  { id: 'shadow.raised', name: '浮层阴影', category: 'shadow', value: '0 8px 28px rgba(22,35,48,.14)', themes: { light: '0 8px 28px rgba(22,35,48,.14)', dark: '0 8px 28px rgba(0,0,0,.42)', ops: '0 8px 28px rgba(21,54,45,.14)', contrast: '0 0 0 2px #303b46' }, usage: 36, status: 'stable', description: '菜单、弹窗和浮层' },
  { id: 'component.button.primary.bg', name: '主按钮背景', category: 'component', value: '{color.semantic.primary}', ref: 'color.semantic.primary', themes: { light: '{color.semantic.primary}', dark: '{color.semantic.primary}', ops: '{color.semantic.primary}', contrast: '{color.semantic.primary}' }, usage: 98, status: 'stable', description: '主要操作按钮' },
  { id: 'component.button.primary.text', name: '主按钮文字', category: 'component', value: '#ffffff', themes: { light: '#ffffff', dark: '#ffffff', ops: '#ffffff', contrast: '#ffffff' }, usage: 98, status: 'stable', description: '主要操作按钮文字' }
];

const changes: ChangeRequest[] = [
  { id: 'CR-412', title: '运营产品切换语义主色', requester: '运营设计组', scope: '4 个产品 · 238 处引用', impact: 86, status: '待评审', diff: { token: 'color.semantic.primary', before: '{color.base.blue.600}', after: '{color.base.green.600}' } },
  { id: 'CR-418', title: '高对比度正文尺寸调整', requester: '无障碍专项组', scope: '2 个产品 · 74 处引用', impact: 42, status: '待评审', diff: { token: 'font.size.body', before: '14px', after: '16px' } },
  { id: 'CR-423', title: '统一浮层圆角', requester: '组件维护组', scope: '12 个组件 · 36 处引用', impact: 28, status: '待评审', diff: { token: 'radius.control', before: '8px', after: '6px' } }
];

const storageKey = 'yy63-token-governance';
const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
const saved = raw ? JSON.parse(raw) : null;

function normalize(tokens: Token[]): Token[] {
  return tokens.map((token) => ({
    ...token,
    kind: token.kind ?? inferKind(token.id),
    reviewStatus: token.reviewStatus ?? 'ok',
    overrides: token.overrides ?? {}
  }));
}

export const useTokenStore = defineStore('tokens', {
  state: () => ({
    tokens: normalize(saved?.tokens as Token[] ?? initialTokens),
    changes: (saved?.changes as ChangeRequest[]) ?? changes,
    activeTheme: (saved?.activeTheme as string) ?? 'light',
    selectedTokenId: (saved?.selectedTokenId as string) ?? 'color.semantic.primary',
    search: (saved?.search as string) ?? '',
    category: (saved?.category as string) ?? '全部',
    releaseVersion: '4.6.0-rc.2',
    locked: (saved?.locked as boolean) ?? false,
    lastPublished: (saved?.lastPublished as string) ?? 'DS 4.5.2',
    baseline: initialTokens.map((token) => ({ id: token.id, value: token.value })),
    // 主题包增量同步
    packages: (saved?.packages as PackageRecord[]) ?? [],
    transactions: (saved?.transactions as TxRecord[]) ?? [],
    snapshots: (saved?.snapshots as Snapshot[]) ?? [],
    importError: '' as string,
    importInfo: '' as string
  }),
  getters: {
    selectedToken(state): Token | undefined {
      return state.tokens.find((token) => token.id === state.selectedTokenId);
    },
    filteredTokens(state): Token[] {
      const query = state.search.toLowerCase();
      return state.tokens.filter((token) => {
        const matchesSearch = !query || token.id.toLowerCase().includes(query) || token.name.includes(state.search);
        const matchesCategory = state.category === '全部' || token.category === state.category;
        return matchesSearch && matchesCategory;
      });
    },
    dependencyEdges(state) {
      return state.tokens.filter((token) => token.ref).map((token) => ({ from: token.ref!, to: token.id }));
    },
    cycleNodes(state): string[] {
      const graph = new Map<string, string>();
      state.tokens.filter((token) => token.ref).forEach((token) => graph.set(token.id, token.ref!));
      const cycle = new Set<string>();
      graph.forEach((_, start) => {
        const path: string[] = [];
        let current: string | undefined = start;
        while (current && !path.includes(current)) {
          path.push(current);
          current = graph.get(current);
        }
        if (current && path.includes(current)) path.slice(path.indexOf(current)).forEach((id) => cycle.add(id));
      });
      return [...cycle];
    },
    invalidReferences(state) {
      const ids = new Set(state.tokens.map((token) => token.id));
      return state.tokens.filter((token) => token.ref && !ids.has(token.ref));
    },
    contrastIssues(state) {
      const text = state.tokens.find((token) => token.id === 'color.text.primary');
      const surface = state.tokens.find((token) => token.id === 'color.surface.canvas');
      const values = [text?.themes[state.activeTheme], surface?.themes[state.activeTheme]].filter(Boolean) as string[];
      if (values.length < 2) return [];
      const ratio = contrastRatio(values[0], values[1]);
      return ratio < 4.5 ? [{ title: '正文与页面背景对比度不足', detail: `当前 ${ratio.toFixed(2)}:1，要求至少 4.5:1。` }] : [];
    },
    diffRows(state) {
      return state.tokens.filter((token) => {
        const base = state.baseline.find((item) => item.id === token.id);
        return !base || base.value !== token.value;
      }).map((token) => {
        const base = state.baseline.find((item) => item.id === token.id);
        return { id: token.id, before: base?.value ?? '新增', after: token.value, name: token.name };
      });
    },
    releaseReadiness(state): number {
      const base = 100 - this.cycleNodes.length * 25 - this.invalidReferences.length * 20 - this.contrastIssues.length * 15;
      return Math.max(0, base);
    },
    pendingTransactions(state): TxRecord[] {
      return state.transactions.filter((tx) => tx.status === 'pending');
    },
    failedTransactions(state): TxRecord[] {
      return state.transactions.filter((tx) => tx.status === 'failed');
    },
    pendingReviewTokens(state): Token[] {
      return state.tokens.filter((token) => token.reviewStatus === 'pending');
    },
    latestSnapshot(state): Snapshot | undefined {
      return state.snapshots[0];
    }
  },
  actions: {
    selectToken(id: string) {
      this.selectedTokenId = id;
      this.persist();
    },
    updateTokenValue(id: string, value: string) {
      const token = this.tokens.find((item) => item.id === id);
      if (!token) return;
      const wasRef = !!token.ref;
      token.value = value;
      token.themes[this.activeTheme] = value;
      if (value.startsWith('{') && value.endsWith('}')) token.ref = value.slice(1, -1);
      else delete token.ref;

      // 别名被显式改成字面量 → 品牌覆盖，标记待复核
      if (wasRef && !value.startsWith('{') && token.kind !== 'base') {
        token.overrides = { ...(token.overrides ?? {}), [this.activeTheme]: true };
        token.reviewStatus = 'pending';
      }

      // 基础令牌改动后：未覆盖的别名重算，品牌覆盖保留但待复核
      const result = recomputeDependents(this.tokens, id, this.activeTheme);
      this.tokens = result.tokens;
      this.persist();
    },
    addToken(token: Token) {
      if (!this.tokens.some((item) => item.id === token.id)) this.tokens.push(token);
      this.persist();
    },
    setTheme(theme: string) {
      this.activeTheme = theme;
      this.persist();
    },
    setSearch(value: string) { this.search = value; this.persist(); },
    setCategory(value: string) { this.category = value; this.persist(); },
    acceptChange(id: string) {
      const change = this.changes.find((item) => item.id === id);
      if (!change) return;
      const token = this.tokens.find((item) => item.id === change.diff.token);
      if (token) this.updateTokenValue(token.id, change.diff.after);
      change.status = '已接受';
      this.persist();
    },
    rejectChange(id: string) {
      const change = this.changes.find((item) => item.id === id);
      if (change) change.status = '已退回';
      this.persist();
    },
    rollback() {
      this.baseline.forEach((base) => {
        const token = this.tokens.find((item) => item.id === base.id);
        if (token) token.value = base.value;
      });
      this.persist();
    },
    lockRelease() {
      if (this.cycleNodes.length === 0 && this.invalidReferences.length === 0 && this.contrastIssues.length === 0 && this.changes.every((item) => item.status !== '待评审')) {
        this.locked = true;
        this.lastPublished = `DS ${this.releaseVersion}`;
      }
      this.persist();
    },

    // ---- 主题包增量同步 ----

    nextSeq(): number {
      return this.transactions.length ? Math.max(...this.transactions.map((tx) => tx.seq)) + 1 : 1;
    },

    commitPackage(tx: TxRecord) {
      this.tokens = mergePackage(this.tokens, tx.pkg);
      tx.status = 'committed';
      tx.lastError = undefined;
      const key = packageKey(tx.pkg);
      if (!this.packages.some((pkg) => pkg.key === key)) {
        this.packages.push({
          key,
          packageId: tx.packageId,
          version: tx.version,
          actor: tx.actor,
          submittedAt: tx.submittedAt,
          tokenCount: tx.pkg.tokens.length,
          outcome: 'committed',
          seq: tx.seq
        });
      }
    },

    // 导入主题包：先校验（引用解析 + 对比度门禁），通过后整包写入。
    // 重复来源版本沿用第一次结果，不重复写入。
    importThemePackage(pkg: ThemePackage, opts: { simulateWriteFailure?: boolean } = {}): { ok: boolean; deduped?: boolean; recoverable?: boolean; seq?: number; errors?: string[] } {
      this.importError = '';
      this.importInfo = '';
      const key = packageKey(pkg);
      const existing = this.packages.find((item) => item.key === key);
      if (existing) {
        this.importInfo = `包 ${key} 已导入（包号 #${existing.seq}），沿用第一次结果，本次不重复写入。`;
        return { ok: true, deduped: true };
      }

      const seq = this.nextSeq();
      const tx: TxRecord = {
        seq,
        packageId: pkg.packageId,
        version: pkg.version,
        actor: pkg.actor,
        submittedAt: pkg.submittedAt,
        status: 'pending',
        attempts: 0,
        simulateWriteFailure: opts.simulateWriteFailure,
        pkg
      };
      this.transactions.push(tx);
      this.persist();

      const validation = validatePackage(this.tokens, pkg);
      if (!validation.ok) {
        tx.status = 'failed';
        tx.attempts = 1;
        tx.lastError = validation.errors.join('；');
        this.importError = tx.lastError;
        this.packages.push({
          key, packageId: pkg.packageId, version: pkg.version, actor: pkg.actor,
          submittedAt: pkg.submittedAt, tokenCount: pkg.tokens.length,
          outcome: 'rejected', reason: tx.lastError, seq
        });
        this.persist();
        return { ok: false, errors: validation.errors };
      }

      tx.attempts += 1;
      if (opts.simulateWriteFailure) {
        tx.lastError = '模拟写入失败：本地存储写入中断，事务保持待恢复状态';
        this.importError = tx.lastError;
        this.persist();
        return { ok: false, recoverable: true, seq };
      }

      this.commitPackage(tx);
      this.importInfo = `包 ${key} 已提交（包号 #${seq}），写入 ${pkg.tokens.length} 个令牌。`;
      this.persist();
      return { ok: true, seq };
    },

    // 写入失败后按包号恢复：重开后对待恢复事务重新校验并补写入。
    recoverTransaction(seq: number): { ok: boolean; errors?: string[] } {
      const tx = this.transactions.find((item) => item.seq === seq);
      if (!tx || tx.status !== 'pending') return { ok: false };
      tx.attempts += 1;
      const validation = validatePackage(this.tokens, tx.pkg);
      if (!validation.ok) {
        tx.status = 'failed';
        tx.lastError = validation.errors.join('；');
        this.importError = tx.lastError;
        this.persist();
        return { ok: false, errors: validation.errors };
      }
      this.commitPackage(tx);
      this.importInfo = `包号 #${seq} 恢复成功，已补写入 ${tx.pkg.tokens.length} 个令牌。`;
      this.persist();
      return { ok: true };
    },

    // 并发提交：先到者生效，后到者只留下冲突项。
    submitConcurrent(first: ThemePackage, later: ThemePackage): { conflicts: ConflictItem[] } {
      this.importError = '';
      this.importInfo = '';
      this.importThemePackage(first);
      const conflicts = reduceToConflicts(this.tokens, later);
      const seq = this.nextSeq();
      const tx: TxRecord = {
        seq,
        packageId: later.packageId,
        version: later.version,
        actor: later.actor,
        submittedAt: later.submittedAt,
        status: 'pending',
        attempts: 0,
        pkg: later,
        conflicts
      };
      this.transactions.push(tx);
      this.importInfo = `并发提交：先到包 ${packageKey(first)} 已生效；后到包 ${packageKey(later)} 保留 ${conflicts.length} 个冲突项待处理。`;
      this.persist();
      return { conflicts };
    },

    // 接受/拒绝后到包留下的冲突项。
    resolveConflict(seq: number, item: ConflictItem, accept: boolean) {
      const tx = this.transactions.find((txItem) => txItem.seq === seq);
      if (!tx || !tx.conflicts) return;
      if (accept) {
        const token = this.tokens.find((tokenItem) => tokenItem.id === item.tokenId);
        if (token) {
          token.themes[item.theme] = item.incoming;
          if (item.theme === 'light') token.value = item.incoming;
          token.sourceVersion = `${tx.packageId}@${tx.version}`;
        }
      }
      tx.conflicts = tx.conflicts.filter((conflict) => !(conflict.tokenId === item.tokenId && conflict.theme === item.theme));
      this.persist();
    },

    // 发布快照：各主题最终值与引用链。
    publishSnapshot(): Snapshot {
      const snapshot = buildSnapshot(this.tokens, this.releaseVersion);
      this.snapshots.unshift(snapshot);
      this.persist();
      return snapshot;
    },

    clearReview(tokenId: string) {
      const token = this.tokens.find((item) => item.id === tokenId);
      if (token) {
        token.reviewStatus = 'ok';
        this.persist();
      }
    },

    persist() {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, JSON.stringify({
          tokens: this.tokens,
          changes: this.changes,
          activeTheme: this.activeTheme,
          selectedTokenId: this.selectedTokenId,
          search: this.search,
          category: this.category,
          locked: this.locked,
          lastPublished: this.lastPublished,
          packages: this.packages,
          transactions: this.transactions,
          snapshots: this.snapshots
        }));
      }
    }
  }
});

export { THEME_NAMES };

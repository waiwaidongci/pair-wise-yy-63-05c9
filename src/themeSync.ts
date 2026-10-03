// 主题包增量同步的纯领域逻辑。
// 覆盖需求：
// 1. 导入时先按主题解析引用，重复来源版本沿用第一次结果；
// 2. 基础令牌改动后，未覆盖的别名重算，品牌覆盖保留但待复核；
// 3. 解析失败或对比度不达标时整包不写入；
// 4. 两个主题包同时提交时先到者生效，后到者只留下冲突项；
// 5. 发布快照带各主题最终值和引用链；
// 6. 写入失败后按包号恢复，重开还能继续（WAL）。

import type { Token } from './store';

export type ThemeName = 'light' | 'dark' | 'ops' | 'contrast';
export const THEME_NAMES: ThemeName[] = ['light', 'dark', 'ops', 'contrast'];
export const THEME_LABELS: Record<ThemeName, string> = {
  light: '明亮',
  dark: '暗色',
  ops: '运营',
  contrast: '高对比度'
};

export type TokenKind = 'base' | 'semantic' | 'component';

export type PackageToken = {
  id: string;
  name: string;
  category: Token['category'];
  value: string;
  ref?: string;
  themes: Record<string, string>;
  usage?: number;
  status?: Token['status'];
  description?: string;
  kind?: TokenKind;
};

export type ThemePackage = {
  packageId: string;
  version: string;
  submittedAt: number;
  actor?: string;
  tokens: PackageToken[];
};

export type ResolvedTheme = { value: string; chain: string[] };

export type Snapshot = {
  version: string;
  releasedAt: number;
  byTheme: Record<string, Record<string, ResolvedTheme>>;
};

export type ConflictItem = {
  tokenId: string;
  theme: string;
  current: string;
  incoming: string;
};

export type PackageRecord = {
  key: string;
  packageId: string;
  version: string;
  actor?: string;
  submittedAt: number;
  tokenCount: number;
  outcome: 'committed' | 'rejected';
  reason?: string;
  seq: number;
};

export type TxStatus = 'pending' | 'committed' | 'failed';
export type TxRecord = {
  seq: number;
  packageId: string;
  version: string;
  actor?: string;
  submittedAt: number;
  status: TxStatus;
  attempts: number;
  lastError?: string;
  simulateWriteFailure?: boolean;
  conflicts?: ConflictItem[];
  pkg: ThemePackage;
};

const REF_RE = /^\{([^{}]+)\}$/;

export function parseRef(value: string): string | null {
  const match = value.match(REF_RE);
  return match ? match[1] : null;
}

export function isRef(value: string): boolean {
  return REF_RE.test(value);
}

export function packageKey(pkg: ThemePackage): string {
  return `${pkg.packageId}@${pkg.version}`;
}

export function inferKind(id: string): TokenKind {
  if (id.startsWith('component.')) return 'component';
  if (id.startsWith('color.base.') || id.startsWith('font.') || id.startsWith('spacing.') || id.startsWith('radius.') || id.startsWith('shadow.')) return 'base';
  return 'semantic';
}

type Node = { themes?: Record<string, string>; value: string };

function buildMergedMap(current: Token[], pkg: ThemePackage): Map<string, Node> {
  const byId = new Map<string, Node>();
  current.forEach((token) => byId.set(token.id, { themes: token.themes, value: token.value }));
  pkg.tokens.forEach((token) => byId.set(token.id, { themes: token.themes, value: token.value }));
  return byId;
}

// 按主题解析单个令牌的引用链，返回最终值与引用链。
export function resolveThemeValue(
  id: string,
  theme: string,
  byId: Map<string, Node>,
  seen: string[] = []
): { ok: true; value: string; chain: string[] } | { ok: false; error: string } {
  const node = byId.get(id);
  if (!node) return { ok: false, error: `引用 ${id} 在主题「${theme}」中不存在` };
  if (seen.includes(id)) return { ok: false, error: `循环引用 ${[...seen, id].join(' → ')}` };
  const raw = node.themes?.[theme] ?? node.value;
  const target = parseRef(raw);
  if (!target) return { ok: true, value: raw, chain: [id] };
  const resolved = resolveThemeValue(target, theme, byId, [...seen, id]);
  if (!resolved.ok) return resolved;
  return { ok: true, value: resolved.value, chain: [id, ...resolved.chain] };
}

export type Validation = {
  ok: boolean;
  errors: string[];
  resolved: Map<string, Record<string, ResolvedTheme>>;
};

// 导入前的整包校验：先按主题解析引用，再做对比度门禁。任一失败则整包不写入。
export function validatePackage(current: Token[], pkg: ThemePackage): Validation {
  const errors: string[] = [];
  const byId = buildMergedMap(current, pkg);
  const resolved = new Map<string, Record<string, ResolvedTheme>>();

  for (const token of pkg.tokens) {
    const themes = Object.keys(token.themes ?? {});
    const perTheme: Record<string, ResolvedTheme> = {};
    for (const theme of themes) {
      const result = resolveThemeValue(token.id, theme, byId);
      if (!result.ok) {
        errors.push(`[${THEME_LABELS[theme as ThemeName] ?? theme}] ${result.error}`);
      } else {
        perTheme[theme] = { value: result.value, chain: result.chain };
      }
    }
    resolved.set(token.id, perTheme);
  }

  // 对比度门禁：每个主题的正文与背景对比度须达到 WCAG AA（4.5:1）。
  for (const theme of THEME_NAMES) {
    const text = resolveThemeValue('color.text.primary', theme, byId);
    const surface = resolveThemeValue('color.surface.canvas', theme, byId);
    if (text.ok && surface.ok) {
      const ratio = contrastRatio(text.value, surface.value);
      if (ratio < 4.5) {
        errors.push(`[${THEME_LABELS[theme]}] 正文与背景对比度 ${ratio.toFixed(2)}:1，低于 4.5:1`);
      }
    }
  }

  return { ok: errors.length === 0, errors, resolved };
}

// 将主题包合并进当前令牌集合并打上来历版本与品牌覆盖标记。
export function mergePackage(current: Token[], pkg: ThemePackage): Token[] {
  const byId = new Map<string, Token>();
  current.forEach((token) => byId.set(token.id, token));

  for (const pt of pkg.tokens) {
    const existing = byId.get(pt.id);
    const kind = pt.kind ?? existing?.kind ?? inferKind(pt.id);
    const ref = parseRef(pt.value) ?? undefined;
    const overrides: Record<string, boolean> = { ...(existing?.overrides ?? {}) };
    if (kind !== 'base') {
      for (const theme of Object.keys(pt.themes ?? {})) {
        if (isRef(pt.themes[theme])) delete overrides[theme];
        else overrides[theme] = true; // 别名在某主题下显式写成字面量 = 品牌覆盖
      }
    }
    byId.set(pt.id, {
      id: pt.id,
      name: pt.name || existing?.name || pt.id,
      category: pt.category,
      value: pt.value,
      ref,
      themes: { ...(existing?.themes ?? {}), ...pt.themes },
      usage: pt.usage ?? existing?.usage ?? 0,
      status: pt.status ?? existing?.status ?? 'proposed',
      description: pt.description ?? existing?.description ?? '',
      kind,
      sourceVersion: `${pkg.packageId}@${pkg.version}`,
      overrides,
      reviewStatus: 'ok'
    });
  }
  return [...byId.values()];
}

export type RecomputeResult = {
  tokens: Token[];
  pendingReview: string[];
  recomputed: string[];
};

// 基础令牌改动后：未覆盖的别名重算（保留引用、动态解析），品牌覆盖保留但标记待复核。
// 依赖沿 ref 结构传播；品牌覆盖会阻断该主题的解析，但结构传播继续，
// 以便下游别名仍能跟随被覆盖别名的现值。
export function recomputeDependents(tokens: Token[], changedId: string, theme?: string): RecomputeResult {
  const byId = new Map<string, Token>();
  tokens.forEach((token) => byId.set(token.id, { ...token, themes: { ...token.themes }, overrides: { ...(token.overrides ?? {}) } }));
  const pendingReview: string[] = [];
  const recomputed: string[] = [];
  const visited = new Set<string>();

  const propagate = (id: string) => {
    const dependents = tokens.filter((token) => token.id !== id && token.ref === id && !visited.has(token.id));
    for (const dep of dependents) {
      visited.add(dep.id);
      const node = byId.get(dep.id)!;
      const themes = theme ? [theme] : Object.keys(node.themes);
      let overridden = false;
      for (const th of themes) {
        if (node.overrides?.[th]) {
          node.reviewStatus = 'pending';
          pendingReview.push(node.id);
          overridden = true;
        }
      }
      if (!overridden) recomputed.push(node.id);
      propagate(dep.id);
    }
  };

  propagate(changedId);
  return {
    tokens: [...byId.values()],
    pendingReview: [...new Set(pendingReview)],
    recomputed: [...new Set(recomputed)]
  };
}

// 发布快照：每个主题下每个令牌的最终值与完整引用链。
export function buildSnapshot(tokens: Token[], version: string): Snapshot {
  const byId = new Map<string, Node>();
  tokens.forEach((token) => byId.set(token.id, { themes: token.themes, value: token.value }));
  const byTheme: Snapshot['byTheme'] = {};
  for (const theme of THEME_NAMES) {
    const perToken: Record<string, ResolvedTheme> = {};
    for (const token of tokens) {
      const result = resolveThemeValue(token.id, theme, byId);
      if (result.ok) perToken[token.id] = { value: result.value, chain: result.chain };
    }
    byTheme[theme] = perToken;
  }
  return { version, releasedAt: Date.now(), byTheme };
}

// 并发归并：后到包只保留与现值冲突的项，相同项丢弃。
export function reduceToConflicts(current: Token[], incoming: ThemePackage): ConflictItem[] {
  const conflicts: ConflictItem[] = [];
  const byId = new Map(current.map((token) => [token.id, token]));
  for (const pt of incoming.tokens) {
    const existing = byId.get(pt.id);
    for (const theme of Object.keys(pt.themes)) {
      const currentValue = existing?.themes?.[theme];
      if (currentValue !== undefined && currentValue !== pt.themes[theme]) {
        conflicts.push({ tokenId: pt.id, theme, current: currentValue, incoming: pt.themes[theme] });
      }
    }
  }
  return conflicts;
}

export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return 0.5;
    const channels = [0, 2, 4]
      .map((index) => parseInt(clean.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

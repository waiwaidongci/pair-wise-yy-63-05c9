// 外部主题包增量同步引擎（纯逻辑）
// 规则：
// 1. 基础令牌 / 语义别名 / 组件别名条目均带来源版本；
// 2. 导入时先按主题解析引用，重复的「主题 + 令牌 + 来源版本」沿用第一次解析结果（解析缓存）；
// 3. 基础令牌改动后，未被品牌覆盖的别名自动重算，品牌覆盖保留但标记待复核；
// 4. 解析失败（悬空引用 / 循环引用）或对比度不达 AA，整包不写入（含解析缓存）；
// 5. 两个主题包并发提交：按提交时间先到者生效，后到者整包不落库，仅保留冲突项；
// 6. 发布快照带各主题最终值与完整引用链；写入失败按包号恢复，重开可继续。

export type EntryKind = 'base' | 'semantic' | 'component';

export type PackageEntry = {
  id: string;
  kind?: EntryKind;
  /** 字面值，或形如 {token.id} 的引用 */
  value: string;
  /** 品牌团队显式覆盖：基础令牌变更时保留该别名的值，但要求人工复核 */
  brandOverride?: boolean;
};

export type ThemePackage = {
  packageId: string;
  theme: string;
  sourceVersion: string;
  submittedAt: number;
  note?: string;
  entries: PackageEntry[];
};

export type Provenance = {
  sourceVersion?: string;
  packageId?: string;
  importedAt?: number;
  brandOverride?: boolean;
  /** 基础令牌已变更，品牌覆盖别名保留原值，等待人工复核 */
  needsReview?: boolean;
};

export type ResolvedRef = {
  literal: string | null;
  /** 引用链：起点别名 -> ... -> 基础令牌 */
  chain: string[];
  error?: 'unresolved' | 'cycle';
};

export type PlannedUpdate = {
  id: string;
  theme: string;
  kind: EntryKind;
  raw: string;
  oldRaw?: string;
  resolved: ResolvedRef;
  brandOverride: boolean;
  needsReview: boolean;
  fromCache: boolean;
  recomputed: boolean;
  isBaseChange: boolean;
};

export type ImportIssue = {
  level: 'error' | 'warning';
  code: 'unresolved' | 'cycle' | 'contrast' | 'review';
  theme: string;
  id?: string;
  message: string;
};

export type ImportPlan = {
  pkg: ThemePackage;
  updates: PlannedUpdate[];
  reviews: PlannedUpdate[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** 本包实际触及（含自动重算）的令牌 id */
  touched: string[];
  cacheHits: number;
};

export type ConflictItem = {
  id: string;
  theme: string;
  winnerPackageId: string;
  loserPackageId: string;
  winnerValue: string;
  loserValue: string;
  at: number;
  dismissed?: boolean;
};

export type PackageRecord = {
  packageId: string;
  theme: string;
  sourceVersion: string;
  status: 'applied' | 'rejected';
  reason?: string;
  updateCount: number;
  reviewCount: number;
  conflictCount: number;
  at: number;
  note?: string;
};

export type SnapshotValue = {
  raw: string;
  literal: string | null;
  chain: string[];
  sourceVersion?: string;
  brandOverride?: boolean;
  needsReview?: boolean;
};

export type SnapshotRow = {
  id: string;
  name: string;
  category: string;
  themes: Record<string, SnapshotValue>;
};

export type Snapshot = {
  snapshotId: string;
  version: string;
  createdAt: number;
  packageIds: string[];
  themes: string[];
  rows: SnapshotRow[];
};

const REF_PATTERN = /^\{([^{}]+)\}$/;

export function asRef(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = value.trim().match(REF_PATTERN);
  return match ? match[1].trim() : null;
}

export function kindOf(id: string): EntryKind {
  if (id.startsWith('component.')) return 'component';
  if (id.includes('.semantic.')) return 'semantic';
  return 'base';
}

export function cacheKey(theme: string, id: string, sourceVersion: string): string {
  return `${theme}|${id}|${sourceVersion}`;
}

export type RawLookup = (theme: string, id: string) => string | undefined;

/** 沿引用链解析到字面值，记录完整链路，检出悬空引用与循环引用。 */
export function resolveRef(theme: string, startId: string, lookup: RawLookup): ResolvedRef {
  const chain: string[] = [];
  let current = startId;
  for (;;) {
    if (chain.includes(current)) {
      chain.push(current);
      return { literal: null, chain, error: 'cycle' };
    }
    chain.push(current);
    const raw = lookup(theme, current);
    if (raw === undefined) return { literal: null, chain, error: 'unresolved' };
    const ref = asRef(raw);
    if (!ref) return { literal: raw.trim(), chain };
    current = ref;
    if (chain.length > 64) return { literal: null, chain, error: 'cycle' };
  }
}

/** 构建导入计划：整包在草稿值上解析，任何错误都会阻断提交（原子性）。 */
export function planImport(
  pkg: ThemePackage,
  lookup: RawLookup,
  cache: Record<string, ResolvedRef>,
  hasBrandOverride: (theme: string, id: string) => boolean,
  allIds: string[]
): { plan: ImportPlan; newCache: Record<string, ResolvedRef> } {
  const theme = pkg.theme;
  const incoming = new Map<string, PackageEntry>();
  pkg.entries.forEach((entry) => incoming.set(entry.id, entry));

  // 草稿：先放入本包全部原始值，保证包内前向引用也能解析。
  const draft = new Map<string, string>();
  const draftLookup: RawLookup = (th, id) => (th === theme && draft.has(id) ? draft.get(id) : lookup(th, id));
  incoming.forEach((entry) => draft.set(entry.id, entry.value));
  // 其余令牌从现状取值。
  const seed = (id: string) => {
    if (!draft.has(id)) {
      const value = lookup(theme, id);
      if (value !== undefined) draft.set(id, value);
    }
  };

  const updates: PlannedUpdate[] = [];
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const newCache: Record<string, ResolvedRef> = {};
  let cacheHits = 0;
  const changedBase = new Set<string>();

  incoming.forEach((entry) => seed(entry.id));

  for (const entry of pkg.entries) {
    const kind = entry.kind ?? kindOf(entry.id);
    const oldRaw = lookup(theme, entry.id);
    seed(entry.id);
    const key = cacheKey(theme, entry.id, pkg.sourceVersion);
    let resolved: ResolvedRef;
    let fromCache = false;
    const cached = cache[key];
    if (cached) {
      resolved = cached;
      fromCache = true;
      cacheHits += 1;
    } else {
      resolved = resolveRef(theme, entry.id, draftLookup);
      if (!resolved.error) newCache[key] = resolved;
    }

    const isBaseChange =
      kind === 'base' && !asRef(entry.value) && oldRaw !== undefined && oldRaw !== entry.value;
    if (isBaseChange) changedBase.add(entry.id);

    if (resolved.error === 'unresolved') {
      errors.push({
        level: 'error',
        code: 'unresolved',
        theme,
        id: entry.id,
        message: `${entry.id} 引用了不存在的令牌（${resolved.chain[resolved.chain.length - 1]}），来源版本 ${pkg.sourceVersion}`
      });
    } else if (resolved.error === 'cycle') {
      errors.push({
        level: 'error',
        code: 'cycle',
        theme,
        id: entry.id,
        message: `引用链存在循环：${resolved.chain.join(' → ')}`
      });
    }

    const isBrand = entry.brandOverride === true || hasBrandOverride(theme, entry.id);
    updates.push({
      id: entry.id,
      theme,
      kind,
      raw: entry.value,
      oldRaw,
      resolved,
      brandOverride: isBrand,
      // 品牌覆盖别名遇到同包基础令牌变更：保留原值，挂起待复核。
      needsReview: isBrand && kind !== 'base' && (isBaseChange || chainHits(resolved, changedBase)),
      fromCache,
      recomputed: false,
      isBaseChange
    });
  }

  // 基础令牌改动后，重算所有引用到它、且未被品牌覆盖、且本包未直接携带的别名。
  const reviews: PlannedUpdate[] = [];
  if (changedBase.size) {
    const aliasIds = collectAliasIds(allIds, lookup, theme, changedBase);
    for (const id of aliasIds) {
      if (incoming.has(id)) continue; // 包内已显式携带的条目按上面的结果处理
      const raw = draftLookup(theme, id)!;
      const resolved = resolveRef(theme, id, draftLookup);
      const brand = hasBrandOverride(theme, id);
      const update: PlannedUpdate = {
        id,
        theme,
        kind: kindOf(id),
        raw,
        oldRaw: lookup(theme, id),
        resolved,
        brandOverride: brand,
        needsReview: brand,
        fromCache: false,
        recomputed: true,
        isBaseChange: false
      };
      if (resolved.error) {
        errors.push({
          level: 'error',
          code: resolved.error,
          theme,
          id,
          message:
            resolved.error === 'cycle'
              ? `重算 ${id} 时发现循环引用：${resolved.chain.join(' → ')}`
              : `重算 ${id} 时引用悬空：${resolved.chain[resolved.chain.length - 1]}`
        });
      }
      updates.push(update);
      if (brand) {
        reviews.push(update);
        warnings.push({
          level: 'warning',
          code: 'review',
          theme,
          id,
          message: `品牌覆盖别名 ${id} 已保留原值，基础令牌变更后需人工复核`
        });
      }
    }
  }

  updates.filter((u) => u.needsReview).forEach((u) => {
    if (!reviews.includes(u)) reviews.push(u);
  });

  // 对比度门禁（WCAG AA 4.5:1）：正文/背景、主按钮背景/文字。
  if (!errors.some((e) => e.code !== 'contrast')) {
    checkContrast(draftLookup, theme, 'color.text.primary', 'color.surface.canvas', '正文与页面背景', errors);
    checkContrast(draftLookup, theme, 'component.button.primary.bg', 'component.button.primary.text', '主按钮背景与文字', errors);
  }

  const touched = [...new Set(updates.map((u) => u.id))];
  return {
    plan: { pkg, updates, reviews, errors, warnings, touched, cacheHits },
    // 整包失败时解析缓存也不写入：重复来源版本只沿用「成功提交」的第一次结果。
    newCache: errors.length ? {} : newCache
  };
}

function chainHits(resolved: ResolvedRef, baseIds: Set<string>): boolean {
  return resolved.chain.some((id) => baseIds.has(id));
}

/** 找出主题内引用链经过任一已变更基础令牌的语义/组件别名。 */
function collectAliasIds(allIds: string[], lookup: RawLookup, theme: string, changedBase: Set<string>): string[] {
  const result: string[] = [];
  for (const id of allIds) {
    const kind = kindOf(id);
    if (kind === 'base') continue;
    const raw = lookup(theme, id);
    if (raw === undefined || !asRef(raw)) continue;
    const resolved = resolveRef(theme, id, lookup);
    if (!resolved.error && resolved.chain.some((chainId) => changedBase.has(chainId))) result.push(id);
  }
  return result;
}

function checkContrast(
  lookup: RawLookup,
  theme: string,
  fgId: string,
  bgId: string,
  label: string,
  errors: ImportIssue[]
) {
  const fg = resolveRef(theme, fgId, lookup);
  const bg = resolveRef(theme, bgId, lookup);
  if (fg.error || bg.error || !fg.literal || !bg.literal) return;
  const ratio = contrastRatio(fg.literal, bg.literal);
  if (ratio !== null && ratio < 4.5) {
    errors.push({
      level: 'error',
      code: 'contrast',
      theme,
      id: `${fgId} / ${bgId}`,
      message: `${label}对比度 ${ratio.toFixed(2)}:1，低于 AA 4.5:1，整包拒绝写入`
    });
  }
}

/**
 * 后到包与先到者（已提交生效）同主题、同令牌且原始值不同的条目即为冲突项。
 * 后到包整包不落库，只返回这些冲突项。
 */
export function conflictsAgainstApplied(loser: ThemePackage, lookup: RawLookup, at: number): ConflictItem[] {
  const conflicts: ConflictItem[] = [];
  for (const entry of loser.entries) {
    const winnerValue = lookup(loser.theme, entry.id);
    if (winnerValue !== undefined && winnerValue !== entry.value) {
      conflicts.push({
        id: entry.id,
        theme: loser.theme,
        winnerPackageId: `applied:${loser.theme}`,
        loserPackageId: loser.packageId,
        winnerValue,
        loserValue: entry.value,
        at
      });
    }
  }
  return conflicts;
}

// ---- 颜色与对比度 ----------------------------------------------------------

export function parseHex(value: string): [number, number, number] | null {
  const clean = value.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16)) as [number, number, number];
}

export function contrastRatio(a: string, b: string): number | null {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  const luminance = ([r, g, b]: [number, number, number]) => {
    const channels = [r, g, b]
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const l1 = luminance(ca);
  const l2 = luminance(cb);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---- 发布快照 --------------------------------------------------------------

export function buildSnapshot(
  version: string,
  packageIds: string[],
  themes: string[],
  rows: { id: string; name: string; category: string; provenance?: Record<string, Provenance> }[],
  lookup: RawLookup
): Snapshot {
  return {
    snapshotId: `SNAP-${version.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now().toString(36)}`,
    version,
    createdAt: Date.now(),
    packageIds,
    themes,
    rows: rows.map((row) => {
      const values: Record<string, SnapshotValue> = {};
      themes.forEach((theme) => {
        const raw = lookup(theme, row.id);
        if (raw === undefined) return;
        const resolved = resolveRef(theme, row.id, lookup);
        const source = row.provenance?.[theme];
        values[theme] = {
          raw,
          literal: resolved.literal,
          chain: resolved.chain,
          sourceVersion: source?.sourceVersion,
          brandOverride: source?.brandOverride,
          needsReview: source?.needsReview
        };
      });
      return { id: row.id, name: row.name, category: row.category, themes: values };
    })
  };
}

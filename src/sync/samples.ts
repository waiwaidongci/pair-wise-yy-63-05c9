import type { ThemePackage } from './engine';

// 外部品牌设计包样例：每个条目都带来源版本。
// 主题：light / dark / ops / contrast

let seq = 0;
const at = (minute: number) => new Date(2026, 9, 3, 10, minute).getTime();
const nextId = () => `PKG-${String(++seq).padStart(3, '0')}`;

export function sampleInbox(): (ThemePackage & { scenario: string })[] {
  seq = 0;
  return [
    {
      scenario: '正常增量 · 运营绿品牌包（基础令牌变更 + 品牌覆盖待复核）',
      packageId: nextId(),
      theme: 'ops',
      sourceVersion: 'brand-ops/2026.10.1',
      submittedAt: at(0),
      note: '品牌团队 10 月运营主题包，更新绿色基色',
      entries: [
        { id: 'color.base.green.600', kind: 'base', value: '#1f7a5c' },
        { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' },
        { id: 'component.button.primary.bg', kind: 'component', value: '{color.semantic.primary}', brandOverride: true }
      ]
    },
    {
      scenario: '正常增量 · 暗色品牌蓝（含按钮文字配套覆盖以满足 AA）',
      packageId: nextId(),
      theme: 'dark',
      sourceVersion: 'brand-blue/dark-3.2',
      submittedAt: at(1),
      note: '暗色主题主色提亮，按钮文字改用深色保证对比',
      entries: [
        { id: 'color.base.blue.400', kind: 'base', value: '#7aa0ff' },
        { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.blue.400}' },
        { id: 'component.button.primary.text', kind: 'component', value: '#0d1b33' }
      ]
    },
    {
      scenario: '解析失败 · 暗色包引用了不存在的基础令牌（整包拒绝）',
      packageId: nextId(),
      theme: 'dark',
      sourceVersion: 'brand-blue/dark-3.3-beta',
      submittedAt: at(2),
      note: '设计侧漏发 color.base.teal.500',
      entries: [
        { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.teal.500}' }
      ]
    },
    {
      scenario: '对比度不达标 · 亮色品牌蓝过浅，白字按钮不达 AA（整包拒绝）',
      packageId: nextId(),
      theme: 'light',
      sourceVersion: 'brand-blue/light-9.1',
      submittedAt: at(3),
      note: '新品牌蓝偏浅，未配套按钮文字色',
      entries: [
        { id: 'color.base.blue.600', kind: 'base', value: '#9db8f5' },
        { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.blue.600}' }
      ]
    }
  ];
}

/** 与运营绿包相同来源版本的重复提交：解析结果应直接走缓存。 */
export function duplicateVersionPackage(): ThemePackage {
  return {
    packageId: nextId(),
    theme: 'ops',
    sourceVersion: 'brand-ops/2026.10.1',
    submittedAt: at(5),
    note: '设计侧重发同版本包（仅携带语义别名）',
    entries: [
      { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' }
    ]
  };
}

/** 两个同主题包同时到达：先到者生效，后到者只留下冲突项。 */
export function concurrentPair(): [ThemePackage, ThemePackage] {
  const time = at(8);
  return [
    {
      packageId: nextId(),
      theme: 'ops',
      sourceVersion: 'brand-ops/2026.10.2-a',
      submittedAt: time,
      note: '并发提交 A 包（按包号先到）',
      entries: [
        { id: 'color.base.green.600', kind: 'base', value: '#206f57' },
        { id: 'color.text.secondary', kind: 'base', value: '#66807a' },
        { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' }
      ]
    },
    {
      packageId: nextId(),
      theme: 'ops',
      sourceVersion: 'brand-ops/2026.10.2-b',
      submittedAt: time,
      note: '并发提交 B 包（后到，仅保留冲突项）',
      entries: [
        { id: 'color.base.green.600', kind: 'base', value: '#3a8a6d' },
        { id: 'color.text.secondary', kind: 'base', value: '#5d756d' },
        { id: 'color.semantic.primary', kind: 'semantic', value: '{color.base.green.600}' }
      ]
    }
  ];
}

/** 不同主题但同时到达：两者主题不重叠，都应生效。 */
export function concurrentDifferentThemes(): [ThemePackage, ThemePackage] {
  const time = at(9);
  return [
    {
      packageId: nextId(),
      theme: 'dark',
      sourceVersion: 'brand-blue/dark-3.4',
      submittedAt: time,
      entries: [
        { id: 'color.base.blue.400', kind: 'base', value: '#86a8ff' },
        { id: 'component.button.primary.text', kind: 'component', value: '#102036' }
      ]
    },
    {
      packageId: nextId(),
      theme: 'contrast',
      sourceVersion: 'brand-a11y/contrast-2.0',
      submittedAt: time,
      entries: [
        { id: 'color.base.blue.600', kind: 'base', value: '#073ea8' }
      ]
    }
  ];
}

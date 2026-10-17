import type { IconName } from '../components/Ui';

export type SettingsSection = 'general' | 'models' | 'extensions' | 'appearance';
export const settingsNavigation: readonly { section: SettingsSection; label: string; subtitle: string; icon: IconName }[] = [
  { section: 'general', label: '本地工作区', subtitle: '运行状态与数据存储', icon: 'workspace' },
  { section: 'models', label: '模型设置', subtitle: '连接与生成参数', icon: 'modelChip' },
  { section: 'extensions', label: '工具与 Skills', subtitle: 'MCP、技能与子任务', icon: 'extensions' },
  { section: 'appearance', label: '外观', subtitle: '主题、字体与配色', icon: 'palette' },
];

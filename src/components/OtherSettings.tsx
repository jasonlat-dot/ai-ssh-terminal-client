import { TerminalCompletionSettings } from './TerminalCompletionSettings';
import { NetworkSettings } from './NetworkSettings';
import { IconHeading } from './Ui';
import './OtherSettings.css';
export function OtherSettings() {
  return <section className="other-settings" aria-labelledby="other-settings-title">
    <header className="other-settings-heading"><IconHeading as="h2" id="other-settings-title" icon="settings" tone="blue">其他设置</IconHeading><p>终端输入偏好与应用网络连接。</p></header>
    <TerminalCompletionSettings />
    <NetworkSettings />
  </section>;
}

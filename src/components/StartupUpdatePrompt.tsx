import { useState } from 'react';
import { useClientUpdater, useStartupUpdateCheck } from '../state/useClientUpdater';
import { Badge, Icon, Modal } from './Ui';
import './StartupUpdatePrompt.css';

export function StartupUpdatePrompt({ onViewUpdate }: { onViewUpdate: () => void }) {
  const state = useClientUpdater();
  const [announcedVersion, setAnnouncedVersion] = useState('');
  useStartupUpdateCheck(setAnnouncedVersion);
  // If a manual check/discard supersedes the startup result, don't show stale details.
  if (!announcedVersion || announcedVersion !== state.version || state.phase !== 'available') return null;
  const dismiss = () => setAnnouncedVersion('');
  return <Modal title="发现客户端新版本" className="startup-update-prompt" onClose={dismiss}>
    <div className="startup-update-content">
      <div className="startup-update-version"><Icon name="refresh" size={22} />
        <strong>Agent SSH</strong><Badge tone="blue">v{announcedVersion}</Badge></div>
      <p>当前版本 v{state.config?.version}，新版本已发布。</p>
      <pre className="startup-update-notes">{state.notes || '此版本未提供更新说明。'}</pre>
      <small>不会自动下载或安装，安装并重启前还需要你确认。</small>
      <div className="dialog-actions">
        <button data-autofocus type="button" className="outlined-button" onClick={dismiss}>稍后再说</button>
        <button type="button" className="primary-button" onClick={() => {
          dismiss(); onViewUpdate();
        }}><Icon name="down" size={14} />查看并下载更新</button>
      </div>
    </div>
  </Modal>;
}

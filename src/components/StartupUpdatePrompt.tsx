import { useEffect, useState } from 'react';
import { useClientUpdater, useStartupUpdateCheck } from '../state/useClientUpdater';
import { CURRENT_RELEASE } from '../config/currentRelease';
import { isTauriRuntime } from '../state/runtime';
import { acknowledgeReleaseNotes, shouldShowReleaseNotes } from '../state/releaseNotes';
import { Badge, Icon, Modal } from './Ui';
import { MarkdownMessage } from './MarkdownMessage';
import './StartupUpdatePrompt.css';

export function StartupUpdatePrompt({ onViewUpdate }: { onViewUpdate: () => void }) {
  const state = useClientUpdater();
  const [announcedVersion, setAnnouncedVersion] = useState('');
  const [showCurrentNotes, setShowCurrentNotes] = useState(false);
  useStartupUpdateCheck(setAnnouncedVersion);
  useEffect(() => {
    if (!isTauriRuntime() || !state.config || state.config.development || state.config.version !== CURRENT_RELEASE.version) return;
    setShowCurrentNotes(shouldShowReleaseNotes(CURRENT_RELEASE.version, localStorage));
  }, [state.config?.version, state.config?.development]);
  if (showCurrentNotes) {
    const dismissCurrent = () => {
      acknowledgeReleaseNotes(CURRENT_RELEASE.version, localStorage);
      setShowCurrentNotes(false);
    };
    return <Modal icon="file" iconTone="blue" title="本次更新内容" className="startup-update-prompt" onClose={dismissCurrent}>
      <div className="startup-update-content">
        <div className="startup-update-version"><strong>ShellPilot</strong><Badge tone="blue">v{CURRENT_RELEASE.version}</Badge></div>
        <div className="startup-update-notes"><MarkdownMessage>{CURRENT_RELEASE.notes}</MarkdownMessage></div>
        <small>关闭后仍可在“关于与更新”中查看当前版本说明。</small>
        <div className="dialog-actions">
          <button data-autofocus type="button" className="primary-button" onClick={dismissCurrent}>知道了</button>
          <button type="button" className="outlined-button" onClick={() => { dismissCurrent(); onViewUpdate(); }}>查看版本说明</button>
        </div>
      </div>
    </Modal>;
  }
  // If a manual check/discard supersedes the startup result, don't show stale details.
  if (!announcedVersion || announcedVersion !== state.version || state.phase !== 'available') return null;
  const dismiss = () => setAnnouncedVersion('');
  return <Modal icon="refresh" iconTone="blue" title="发现客户端新版本" className="startup-update-prompt" onClose={dismiss}>
    <div className="startup-update-content">
      <div className="startup-update-version"><Icon name="refresh" size={22} />
        <strong>ShellPilot</strong><Badge tone="blue">v{announcedVersion}</Badge></div>
      <p>当前版本 v{state.config?.version}，新版本已发布。</p>
      <div className="startup-update-notes"><MarkdownMessage>{state.notes || '此版本未提供更新说明。'}</MarkdownMessage></div>
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

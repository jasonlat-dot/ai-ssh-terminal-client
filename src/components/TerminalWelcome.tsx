import { useState } from 'react';
import { Icon, Modal } from './Ui';
import welcomeArt from '../assets/terminal-welcome-light.png';
import './TerminalWelcome.css';

export function TerminalWelcome({ add, connections }: { add: () => void; connections: () => void }) {
  const [guideOpen, setGuideOpen] = useState(false);

  return <>
    <section className="terminal-welcome" aria-labelledby="terminal-welcome-title">
      <div className="terminal-welcome-content">
        <div className="terminal-welcome-art" aria-hidden="true">
          <img src={welcomeArt} alt="" draggable={false} />
          <span className="welcome-art-label remote">远程主机</span>
          <span className="welcome-art-label cloud">云服务器</span>
          <span className="welcome-art-label welcome-art-transfer">文件传输</span>
        </div>
        <span className="welcome-ready"><i />SSH 工作区已就绪</span>
        <h2 id="terminal-welcome-title">开始一个终端会话</h2>
        <p className="welcome-description">连接远程主机，执行命令、传输文件，并让 SSH Agent 协助你完成日常运维任务</p>
        <div className="welcome-actions">
          <button className="welcome-create" onClick={add}><Icon name="plus" size={23} />新建终端</button>
          <button className="welcome-guide" onClick={() => setGuideOpen(true)}><Icon name="book" size={22} />查看连接指引</button>
        </div>
        <div className="welcome-features">
          <article><span className="welcome-feature-icon"><Icon name="bolt" size={29} /></span><div><h3>快速连接</h3><p>多主机管理，便捷切换终端</p></div></article>
          <article><span className="welcome-feature-icon blue"><Icon name="bot" size={29} /></span><div><h3>智能诊断</h3><p>SSH Agent 协助分析日志</p></div></article>
          <article><span className="welcome-feature-icon"><Icon name="shield" size={29} /></span><div><h3>安全会话</h3><p>会话独立管理，执行前可确认</p></div></article>
        </div>
        <p className="welcome-demo-note">SSH 连接管理与远程终端已接入后端；文件传输与 Agent 回复仍为模拟。</p>
      </div>
    </section>
    {guideOpen && <Modal title="终端连接指引" onClose={() => setGuideOpen(false)}>
      <div className="connection-guide-content">
        <p>添加云服务器或远程主机后，即可建立真实的 SSH 终端会话。</p>
        <ol>
          <li><strong>配置远程主机</strong><span>点击“新建终端”或连接页的“新建连接”，填写地址、端口、用户名和认证方式。</span></li>
          <li><strong>进入终端会话</strong><span>从终端入口保存后会直接建立连接；已保存的主机可从连接管理页再次进入。</span></li>
          <li><strong>管理文件与命令</strong><span>终端右上角可打开文件面板；每个会话独立保留文件状态。终端右侧可按分类使用常用命令，并与 Agent 对话。</span></li>
        </ol>
        <p className="muted">SSH 连接配置保存在后端，收藏偏好保存在本地。远程终端命令真实执行；SFTP 和 AI 回复仍为模拟。</p>
        <div className="dialog-actions"><button className="outlined-button" onClick={() => setGuideOpen(false)}>知道了</button><button className="primary-button" onClick={() => { setGuideOpen(false); connections(); }}>打开连接管理<Icon name="right" size={16} /></button></div>
      </div>
    </Modal>}
  </>;
}

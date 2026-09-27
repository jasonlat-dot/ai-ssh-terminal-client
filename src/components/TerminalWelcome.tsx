import { useState } from 'react';
import { Icon, Modal } from './Ui';
import welcomeArtDark from '../assets/terminal-welcome.png';
import welcomeArtLight from '../assets/terminal-welcome-light.png';
import './TerminalWelcome.css';

export function TerminalWelcome({ add, connections }: { add: () => void; connections: () => void }) {
  const [guideOpen, setGuideOpen] = useState(false);

  return <>
    <section className="terminal-welcome" aria-labelledby="terminal-welcome-title">
      <div className="terminal-welcome-content">
        <div className="terminal-welcome-art" aria-hidden="true">
          <img className="welcome-art-light" src={welcomeArtLight} alt="" draggable={false} />
          <img className="welcome-art-dark" src={welcomeArtDark} alt="" draggable={false} />
          <span className="welcome-art-label remote">远程主机</span>
          <span className="welcome-art-label cloud">云服务器</span>
          <span className="welcome-art-label welcome-art-transfer">文件传输</span>
        </div>
        <span className="welcome-ready"><i />终端工作区已就绪</span>
        <h2 id="terminal-welcome-title">开始一个终端会话</h2>
        <p className="welcome-description">新建终端会直接打开本地 CMD；需要远程操作时，从连接管理进入 SSH 主机</p>
        <div className="welcome-actions">
          <button className="welcome-create" onClick={add}><Icon name="plus" size={23} />打开本地 CMD</button>
          <button className="welcome-guide" onClick={() => setGuideOpen(true)}><Icon name="book" size={22} />查看连接指引</button>
        </div>
        <div className="welcome-features">
          <article><span className="welcome-feature-icon"><Icon name="bolt" size={29} /></span><div><h3>本地终端</h3><p>默认打开 CMD，快速执行命令</p></div></article>
          <article><span className="welcome-feature-icon blue"><Icon name="bot" size={29} /></span><div><h3>智能诊断</h3><p>SSH Agent 协助分析日志</p></div></article>
          <article><span className="welcome-feature-icon"><Icon name="shield" size={29} /></span><div><h3>安全会话</h3><p>会话独立管理，执行前可确认</p></div></article>
        </div>
        <p className="welcome-demo-note">远程终端和文件管理仍从左侧连接管理中的服务器进入。</p>
      </div>
    </section>
    {guideOpen && <Modal title="终端连接指引" onClose={() => setGuideOpen(false)}>
      <div className="connection-guide-content">
        <p>添加云服务器或远程主机后，即可建立真实的 SSH 终端会话。</p>
        <ol>
          <li><strong>打开本地终端</strong><span>点击“新建终端”直接启动 Windows CMD，无需创建 SSH 连接。</span></li>
          <li><strong>配置远程主机</strong><span>在连接管理中点击“新建连接”，填写地址、端口、用户名和认证方式。</span></li>
          <li><strong>进入远程会话</strong><span>点击已保存主机旁的终端图标，建立新的 SSH 终端会话。</span></li>
          <li><strong>上传与下载文件</strong><span>点击服务器下方的“文件管理”，连接后在双栏中浏览本地和服务器目录。选中文件或目录，点击箭头即可上传或下载。</span></li>
        </ol>
        <p className="muted">SSH 连接配置保存在后端，收藏偏好保存在本地。文件管理使用独立连接，收起窗口或关闭终端后传输仍可继续。</p>
        <div className="dialog-actions"><button className="outlined-button" onClick={() => setGuideOpen(false)}>知道了</button><button className="primary-button" onClick={() => { setGuideOpen(false); connections(); }}>打开连接管理<Icon name="right" size={16} /></button></div>
      </div>
    </Modal>}
  </>;
}

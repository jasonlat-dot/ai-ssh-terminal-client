import { useState } from 'react';
import { Icon, Modal } from './Ui';
import { TerminalWelcomeDemo } from './TerminalWelcomeDemo';
import './TerminalWelcome.css';

export function TerminalWelcome({ add, connections }: { add: () => void; connections: () => void }) {
  const [guideOpen, setGuideOpen] = useState(false);

  return <>
    <section className="terminal-welcome" aria-labelledby="terminal-welcome-title">
      <div className="terminal-welcome-content">
        <TerminalWelcomeDemo />
        <div className="terminal-welcome-intro">
        <span className="welcome-ready"><i />终端工作区已就绪</span>
        <h2 id="terminal-welcome-title">开始一个终端会话</h2>
        <p className="welcome-description">新建终端会直接打开本地 CMD；需要远程操作时，从连接管理进入 SSH 主机</p>
        <div className="welcome-actions">
          <button className="welcome-create" onClick={add}><Icon name="plus" size={23} />打开本地 CMD</button>
          <button className="welcome-guide" onClick={() => setGuideOpen(true)}><Icon name="book" size={22} />查看连接指引</button>
        </div>
        </div>
      </div>
    </section>
    {guideOpen && <Modal icon="book" iconTone="blue" title="终端连接指引" onClose={() => setGuideOpen(false)}>
      <div className="connection-guide-content">
        <p>添加云服务器或远程主机后，即可建立真实的 SSH 终端会话。</p>
        <ol>
          <li><strong>打开本地终端</strong><span>点击“新建终端”直接启动 Windows CMD，无需创建 SSH 连接。</span></li>
          <li><strong>配置远程主机</strong><span>在连接管理中点击“新建连接”，填写地址、端口、用户名和认证方式。</span></li>
          <li><strong>进入远程会话</strong><span>点击已保存主机旁的终端图标，建立新的 SSH 终端会话。</span></li>
          <li><strong>上传与下载文件</strong><span>点击服务器下方的“文件管理”，连接后在双栏中浏览本地和服务器目录。选中文件或目录，点击箭头即可上传或下载。</span></li>
        </ol>
        <p className="muted">SSH 连接配置保存在后端。文件管理使用独立连接，收起窗口或关闭终端后传输仍可继续。</p>
        <div className="dialog-actions"><button className="outlined-button" onClick={() => setGuideOpen(false)}>知道了</button><button className="primary-button" onClick={() => { setGuideOpen(false); connections(); }}>打开连接管理<Icon name="right" size={16} /></button></div>
      </div>
    </Modal>}
  </>;
}

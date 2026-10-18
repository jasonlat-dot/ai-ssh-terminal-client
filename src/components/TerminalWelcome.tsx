import { Icon } from './Ui';
import { TerminalWelcomeDemo } from './TerminalWelcomeDemo';
import './TerminalWelcome.css';

export function TerminalWelcome({ add, guide }: { add: () => void; guide: () => void }) {

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
          <button className="welcome-guide" onClick={guide}><Icon name="book" size={22} />查看连接指引</button>
        </div>
        </div>
      </div>
    </section>
  </>;
}

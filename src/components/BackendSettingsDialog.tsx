import { useState } from 'react';
import { normalizeBackendUrl } from '../config/backend';
import { Icon, Modal } from './Ui';
import './BackendSettingsDialog.css';

export function BackendSettingsDialog({ currentUrl, required = false, onClose, onSave }: {
  currentUrl: string;
  required?: boolean;
  onClose: () => void;
  onSave: (url: string) => void;
}) {
  const [url, setUrl] = useState(currentUrl);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [testing, setTesting] = useState(false);

  const testConnection = async () => {
    setError('');
    setResult('');
    let address: string;
    try {
      address = normalizeBackendUrl(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '地址无效。');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    setTesting(true);
    try {
      const response = await fetch(`${address}/agent/query_ai_agent_config_list`, { signal: controller.signal });
      if (!response.ok) throw new Error(`后端响应 HTTP ${response.status}。`);
      const body = await response.json() as { code?: string; info?: string };
      if (body.code !== 'SUCCESS_0000') throw new Error(body.info || '后端返回了非成功状态。');
      setResult('连接成功，Agent 接口可用。');
    } catch (cause) {
      setError(controller.signal.aborted
        ? '连接超时，请检查地址和网络。'
        : cause instanceof TypeError
          ? '无法访问后端；请检查地址、网络以及后端是否允许 Tauri 客户端跨域访问。'
          : cause instanceof Error ? cause.message : '连接测试失败。');
    } finally {
      clearTimeout(timeout);
      setTesting(false);
    }
  };

  const save = () => {
    setError('');
    try {
      onSave(normalizeBackendUrl(url));
      if (!required) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存后端地址失败。');
    }
  };

  return <Modal title={required ? '配置后端服务器' : '客户端设置'} onClose={onClose}
    dismissDisabled={required} className="backend-settings-modal">
    <form className="backend-settings-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="backend-settings-intro">
        <span><Icon name="settings" size={22} /></span>
        <p>{required
          ? '首次使用请填写后端服务器地址。保存后即可使用连接管理、终端和 Agent 对话。'
          : '修改后端地址后，客户端会重新加载连接和对话数据，无需重新安装。'}</p>
      </div>
      <label htmlFor="backend-server-url">后端服务器根地址</label>
      <input id="backend-server-url" type="url" required value={url} autoComplete="url"
        placeholder="https://api.example.com 或 http://192.168.1.10:8888"
        aria-describedby="backend-server-help"
        onChange={event => { setUrl(event.target.value); setError(''); setResult(''); }} />
      <p id="backend-server-help" className="backend-settings-help">
        不要填写 /agent 或 /api/v1/ssh；如通过反向代理部署在子路径下，可以填写该路径。
        地址只保存在这台客户端，不会修改安装包。
      </p>
      {error && <p className="backend-settings-error" role="alert">{error}</p>}
      {result && <p className="backend-settings-success" role="status">{result}</p>}
      <div className="dialog-actions">
        {!required && <button type="button" className="outlined-button" onClick={onClose}>取消</button>}
        <button type="button" className="outlined-button" disabled={testing} onClick={() => void testConnection()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button type="submit" className="primary-button">保存地址</button>
      </div>
    </form>
  </Modal>;
}

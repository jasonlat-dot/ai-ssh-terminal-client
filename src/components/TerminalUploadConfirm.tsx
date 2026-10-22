import type {TerminalUploadRequest} from '../state/terminalUpload';
import {Modal} from './Ui';
import './TerminalUpload.css';

export function TerminalUploadConfirm({request,onClose,onConfirm}:{request:TerminalUploadRequest;onClose:()=>void;onConfirm:()=>void}){
  return <Modal title="确认上传到终端" icon="upload" onClose={onClose} explicitActionsOnly className="terminal-upload-confirm">
    <div className="terminal-upload-confirm-content"><p>是否上传到以下目录？</p><dl><dt>服务器</dt><dd>{request.title}</dd><dt>目标目录</dt><dd className="terminal-upload-destination">{request.target.path}</dd></dl>
      <p>共 {request.paths.length} 个文件或文件夹</p><ul>{request.paths.map(path=><li key={path} title={path}>{path.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||path}</li>)}</ul>
      <p className="terminal-upload-note">同名文件默认停止上传，保留服务器原文件。上传进度和结果会显示在文件管理的“传输队列”。</p>
      <footer><button type="button" className="outlined-button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={onConfirm}>确认上传</button></footer>
    </div>
  </Modal>;
}

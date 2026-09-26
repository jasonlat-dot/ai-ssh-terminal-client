export class ChatRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.name = 'ChatRequestError'; this.code = code; }
}
export function chatErrorGuidance(code?: string): string {
  switch (code) {
    case 'CHAT_CONTENT_REQUIRED': return '请输入文字或附加文件后重新发送。';
    case 'CHAT_ATTACHMENT_INVALID': return '请移除无效或重复附件，重新选择文件或再次附加。';
    case 'CHAT_ATTACHMENT_FORBIDDEN': return '当前账户无权使用此附件，请移除并上传自己的文件。';
    case 'CHAT_ATTACHMENT_LIMIT': return '请减少附件数量、总大小或文本内容后重试。';
    case 'CHAT_ATTACHMENT_UNSUPPORTED': return '请移除暂不支持的附件格式。';
    case 'CHAT_ATTACHMENT_CONTENT_INVALID': return '请检查文件内容；文本附件需使用 UTF-8 编码。';
    case 'CHAT_MODEL_MEDIA_UNSUPPORTED': return '当前智能体不支持该媒体类型，请选择支持的智能体或手动移除附件。';
    case 'CHAT_ATTACHMENT_BUSY': return '附件对话繁忙，请稍后手动重试。';
    case 'FILE_READ_FAILED':
    case 'FILE_STORAGE_UNAVAILABLE': return '文件暂时无法读取，可保留附件引用，稍后重试。';
    default: return '本次文字和附件已保留，可在输入框中重试。';
  }
}

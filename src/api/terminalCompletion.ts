import { builtinRequest } from './builtin';
import { sshUserId } from './ssh';
export function requestTerminalCompletion(modelId:string,context:{prefix:string;cwd:string},signal:AbortSignal,backendUrl?:string) {
  return builtinRequest<{suffix:string}>('agent/terminal_completion','POST',{userId:sshUserId,modelId,context},{},signal,backendUrl);
}

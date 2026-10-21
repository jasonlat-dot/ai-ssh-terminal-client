export type CompletionPreferences = {enabled:boolean;aiEnabled:boolean;sendDirectory:boolean;modelId:string;delayMs:number};
export const COMPLETION_SETTINGS_EVENT = 'shellpilot:terminal-completion-settings';
const KEY = 'shellpilot:terminal-completion:v1';
export function readCompletionPreferences(): CompletionPreferences {
  try {
    const raw=JSON.parse(localStorage.getItem(KEY)??'{}');
    return {enabled:raw.enabled===true,aiEnabled:raw.aiEnabled===true || (raw.aiEnabled===undefined&&raw.enabled===true&&!!raw.modelId),
      sendDirectory:raw.sendDirectory===true,modelId:typeof raw.modelId==='string'?raw.modelId.slice(0,256):'',
      delayMs:[300,500,800,1000].includes(raw.delayMs)?raw.delayMs:500};
  } catch { return {enabled:false,aiEnabled:false,sendDirectory:false,modelId:'',delayMs:500}; }
}
export function saveCompletionPreferences(value:CompletionPreferences) {
  localStorage.setItem(KEY,JSON.stringify(value));
  window.dispatchEvent(new Event(COMPLETION_SETTINGS_EVENT));
}

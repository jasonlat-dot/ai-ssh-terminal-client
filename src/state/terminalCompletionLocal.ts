/** Candidate matching stays inside the app. No file bodies or history are model context. */
export type CompletionEntry={name:string;directory:boolean};
export function sensitiveCommand(value:string){
  return /(?:password|passwd|sshpass|authorization|api[_-]?key|secret|token)\s*(?:[=: ]|$)/i.test(value)
    || /[a-z0-9_]*(?:password|secret|token|private_key|access_key|api_key)[a-z0-9_]*\s*=/i.test(value)
    || /:\/\/[^/\s]+:[^/\s]+@/.test(value)
    || /(?:^|\s)(?:docker\s+login|mysql|redis-cli|sshpass)\b.*(?:\s-p\s*|\s-a\s+)/i.test(value);
}
type Token={text:string;quote:string};
function tokens(line:string):Token[]|null {
  const result:Token[]=[];let text='',quote='',escaped=false,started=false;
  for(const char of line){
    if(escaped){text+=char;escaped=false;started=true;continue;}
    if(char==='\\'&&quote!=="'"){escaped=true;started=true;continue;}
    if(quote){if(char===quote){quote='';}else{text+=char;}started=true;continue;}
    if(char==='"'||char==="'"){quote=char;started=true;continue;}
    if(/[\x00-\x1f\x7f$`;|&<>()]/.test(char))return null;
    if(char===' '){if(started){result.push({text,quote:''});text='';started=false;}continue;}
    text+=char;started=true;
  }
  if(escaped)return null;
  result.push({text,quote});return result;
}
function absolutePath(word:string,cwd:string,home:string):string|null {
  if(word.startsWith('~')&&!word.startsWith('~/'))return null;
  const base=word.startsWith('~/')?home+'/'+word.slice(2):word.startsWith('/')?word:cwd+'/'+word;
  if(!base.startsWith('/'))return null;
  const normalized:string[]=[];
  for(const component of base.split('/')){
    if(component==='..')normalized.pop();else if(component&&component!=='.')normalized.push(component);
  }
  return '/'+normalized.join('/');
}
export function pathQuery(prefix:string,cwd:string,home:string='') {
  const parts=tokens(prefix);if(!parts)return null;
  if(parts.length===1&&!parts[0].text.includes('/'))return null;
  const token=parts[parts.length-1],word=token.text;
  if(word.startsWith('-')||parts[0].text==='ssh'||parts[0].text==='scp')return null;
  const hasPath=word.includes('/')||word.startsWith('~');
  const fileCommand=['cat','cd','ls','less','more','head','tail','vi','vim','nano','bash','sh','source','.'].includes(parts[0].text);
  if(!hasPath&&!fileCommand)return null;
  const slash=word.lastIndexOf('/'),directory=slash<0?'':word.slice(0,slash+1),fragment=word.slice(slash+1);
  const path=absolutePath(directory,cwd,home);if(path===null)return null;
  // A trailing space starts another argument; do not suggest paths already supplied.
  // Normalize spellings locally without resolving symlinks or reading file bodies.
  const usedPaths=new Set(parts.slice(1,-1).filter(part=>part.text&&!part.text.startsWith('-'))
    .map(part=>absolutePath(part.text,cwd,home)).filter((value):value is string=>value!==null));
  return {path,fragment,quote:token.quote,directoriesOnly:parts[0].text==='cd',exclusive:hasPath||fileCommand,usedPaths};
}
export function pathSuffix(query:NonNullable<ReturnType<typeof pathQuery>>,entries:CompletionEntry[]):string {
  const candidates=entries.filter(entry=>entry.name.startsWith(query.fragment)&&(!query.directoriesOnly||entry.directory)
    &&!query.usedPaths.has((query.path==='/'?'':query.path)+'/'+entry.name)
    &&(query.fragment.startsWith('.')||!entry.name.startsWith('.'))&&!/[\x00-\x1f\x7f/]/.test(entry.name)).sort((a,b)=>a.name.localeCompare(b.name));
  if(!candidates.length)return '';
  const names=candidates.map(entry=>entry.name+(entry.directory?'/':''));let common=names[0];
  for(const name of names.slice(1)){let end=0;while(end<common.length&&common[end]===name[end])end++;common=common.slice(0,end);}
  const closeQuote=candidates.length===1&&!candidates[0].directory&&common===names[0]?query.quote:'';
  let suffix=common.slice(query.fragment.length);if(!suffix&&!closeQuote)return '';
  if(query.quote==="'")suffix=suffix.replace(/'/g,"'\\''");
  else if(query.quote==='"')suffix=suffix.replace(/["\\$`]/g,'\\$&');
  else suffix=suffix.replace(/[^a-zA-Z0-9_./~\-]/gu,'\\$&');
  return suffix+closeQuote;
}
export function historySuffix(prefix:string,history:readonly string[]) {
  if(prefix.trim().length<2||sensitiveCommand(prefix))return '';
  for(let i=history.length-1;i>=0;i--)if(history[i].startsWith(prefix)&&history[i].length>prefix.length)return history[i].slice(prefix.length);
  return '';
}

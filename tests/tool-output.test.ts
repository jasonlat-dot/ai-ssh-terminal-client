import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolOutput, readCompleteToolOutput } from '../src/state/toolOutput.ts';
import type { OutputRange, OutputReference } from '../src/api/agent.ts';

const reference = (size: number, channel: 'stdout' | 'stderr' = 'stdout'): OutputReference => ({ id: channel, channel, size, sha256: 'native-verified-hash' });
const parse = (data: unknown) => parseToolOutput(JSON.stringify({ok: false, error: 'exit_nonzero', data}));
const signal = () => new AbortController().signal;

test('输出文本剥离传输记录，保留 stdout、stderr、文字工具内容和原始空白', () => {
  assert.equal(parse({stdout:'  disk\n', stderr:'permission denied\n', exitCode:1}).text,'  disk\npermission denied\n');
  assert.equal(parse({stdout:'',stderr:''}).text,'');
  for (const field of ['text','report','preview']) assert.equal(parse({[field]:'汉🙂\n'}).text,'汉🙂\n');
  assert.equal(parse({content:[{type:'text',text:'actual result'},{type:'image',data:'omit'}]}).text,'actual result');
  assert.equal(parseToolOutput('raw shell\n').text,'raw shell\n');
  assert.equal(parseToolOutput('{"ordinary":"json result"}').text,'{"ordinary":"json result"}');
  assert.equal(parse({result:42}).text,'{\n  "result": 42\n}');
});

test('完整读取全部分页并在合并后解码，跨页中文和 emoji 不丢失，复制文本不含摘要或 JSON 外壳', async () => {
  const raw='x'.repeat(65535)+'汉🙂\nlast line';
  const bytes=new TextEncoder().encode(raw);
  const parsed=parse({stdout:'[... omitted; use read_tool_output ...]',stderr:'',outputs:[reference(bytes.length)]});
  const calls: number[][]=[];
  const result=await readCompleteToolOutput(parsed,async (ref,offset,limit):Promise<OutputRange>=>{
    calls.push([offset,limit]);const end=Math.min(offset+limit,bytes.length);
    return {offset,nextOffset:end,size:bytes.length,eof:end===bytes.length,channel:ref.channel,bytes:Array.from(bytes.slice(offset,end))};
  },signal());
  assert.equal(result.text,raw);assert.equal(result.lossy,false);
  assert.equal(calls.length,2);assert.deepEqual(calls[0],[0,65536]);
  assert.doesNotMatch(result.text,/omitted|exit_nonzero/);
});

test('失败命令的两种输出通道均完整读取，空通道不请求，保留无引用的已有通道',async()=>{
  const parsed=parse({stdout:'preview',stderr:'preview',outputs:[reference(0),reference(4,'stderr')]});
  const result=await readCompleteToolOutput(parsed,async(ref,offset)=>{
    assert.equal(ref.channel,'stderr');assert.equal(offset,0);
    return {offset:0,nextOffset:4,size:4,eof:true,channel:'stderr',bytes:[101,114,114,10]};
  },signal());
  assert.equal(result.text,'err\n');
  const single=parse({stdout:'preview',stderr:'retained error',outputs:[reference(3)]});
  assert.equal((await readCompleteToolOutput(single,async()=>({offset:0,nextOffset:3,size:3,eof:true,channel:'stdout',bytes:[111,107,10]}),signal())).text,'ok\nretained error');
});

test('引用或分页不一致时拒绝将部分结果冒充完整输出，存储失效原样返回错误',async()=>{
  const parsed=parse({outputs:[reference(4)]});
  const page={offset:0,nextOffset:4,size:4,eof:true,channel:'stdout' as const,bytes:[97,98,99,100]};
  for (const invalid of [{offset:1},{nextOffset:0},{size:3},{bytes:[97]},{eof:false},{channel:'stderr'}, {bytes:[97,98,99,999]}]) {
    await assert.rejects(readCompleteToolOutput(parsed,async()=>({...page,...invalid} as OutputRange),signal()),/不完整/);
  }
  await assert.rejects(readCompleteToolOutput(parsed,async()=>{throw new Error('output unavailable');},signal()),/output unavailable/);
  await assert.rejects(readCompleteToolOutput(parse({outputs:[reference(16*1024*1024+1)]}),async()=>assert.fail('oversize must not read'),signal()),/保存上限/);
});

test('取消后停止分页且不交付迟到结果，无效 UTF-8 明确标记',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(readCompleteToolOutput(parse({outputs:[reference(5)]}),async()=>{
    calls++;controller.abort();return {offset:0,nextOffset:2,size:5,eof:false,channel:'stdout',bytes:[97,98]};
  },controller.signal),/取消/);
  assert.equal(calls,1);
  const result=await readCompleteToolOutput(parse({outputs:[reference(2)]}),async()=>({offset:0,nextOffset:2,size:2,eof:true,channel:'stdout',bytes:[255,65]}),signal());
  assert.equal(result.lossy,true);assert.equal(result.text,'�A');
});

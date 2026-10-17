import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMcpConfig, parseMcpConfig, validateSavedMcpValues, savedMcpValue } from '../src/state/mcpConfig';
const parse = (servers: unknown) => parseMcpConfig(JSON.stringify({ mcpServers: servers }));

test('JSON accepts both supplied Baidu formats and preserves query credentials exactly', () => {
  const [http, legacy] = parse({
    'aisearch-mcp-server': { type: 'streamableHttp', description: '搜索实时信息，支持使用大模型进行总结回复。', baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/mcp', headers: { Authorization: 'Bearer fixture-token' } },
    AISearch: { url: 'http://appbuilder.baidu.com/v2/ai_search/mcp/sse?api_key=Bearer+fixture-key' },
  });
  assert.equal(http.transport, 'streamableHttp');
  assert.equal(http.connectionValues?.headers.Authorization, 'Bearer fixture-token');
  assert.equal(legacy.transport, 'sse');
  assert.ok(legacy.transport !== 'stdio' && legacy.url.endsWith('Bearer+fixture-key'));
  assert.equal(legacy.enabled, true);
});

test('stdio supports literal env maps, inherited env and saved value redaction without losing parameters', () => {
  const [server] = parse({ files: { command: 'node', args: ['C:/mcp/server.js', '--read-only'], env: { TOKEN: 'fixture-secret' }, inheritEnv: ['PATH'], disabled: true } });
  assert.equal(server.transport, 'stdio');
  assert.equal(server.enabled, false);
  const shown = formatMcpConfig([{ ...server, savedEnv: ['TOKEN'] }]);
  assert.ok(!shown.includes('fixture-secret'));
  const [roundtrip] = parseMcpConfig(shown);
  assert.equal(roundtrip.connectionValues?.env.TOKEN, savedMcpValue);
  assert.ok(roundtrip.transport === 'stdio');
  assert.deepEqual(roundtrip.env, ['PATH']); assert.deepEqual(roundtrip.args, ['C:/mcp/server.js', '--read-only']);
});

test('JSON rejects duplicates, concatenated documents and non-object configuration without exposing contents', () => {
  for (const source of ['{"mcpServers":{"docs":{},"docs":{}}}', '{"mcpServers":{"docs":{"headers":{"Authorization":"fixture-secret","Authorization":"other"}}}}', '{}{}', 'null', '{"mcpServers":[]}']) {
    assert.throws(() => parseMcpConfig(source), error => error instanceof Error && !error.message.includes('fixture-secret'));
  }
});

test('JSON rejects conflicting transports, ignored fields and invalid types instead of dropping configuration', () => {
  for (const service of [
    { type: 'socket', url: 'https://example.com' },
    { type: 'stdio', url: 'https://example.com', command: 'node' },
    { type: 'http', command: 'node', url: 'https://example.com' },
    { type: 'stdio', command: 'node', args: 'bad' },
    { command: 'node', env: { TOKEN: 123 } },
    { url: 'example.com/mcp' },
    { url: 'https://example.com', baseUrl: 'https://other.example.com' },
    { type: 'http', transport: 'sse', url: 'https://example.com' },
    { url: 'https://example.com', enabled: 'yes' },
    { url: 'https://example.com', enabled: false, disabled: false },
    { url: 'https://example.com', extraOption: true },
  ]) assert.throws(() => parse({ docs: service }));
});

test('Header validation rejects injection, duplicate casing and transport-managed headers', () => {
  for (const headers of [{ Authorization: 'Bearer fixture\r\nX-Injected: true' }, { Authorization: 'first', authorization: 'second' }, { Host: 'other.example' }, { 'Mcp-Session-Id': 'foreign' }, { 'Content-Length': '42' }]) {
    assert.throws(() => parse({ docs: { url: 'https://example.com/mcp', headers } }));
  }
});

test('JSON applies service count, name, size and environment bounds and treats empty config as removal', () => {
  assert.deepEqual(parse({}), []);
  assert.throws(() => parse(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`docs${i}`, { url: 'https://example.com' }]))));
  assert.throws(() => parse({ '中文': { url: 'https://example.com' } }));
  assert.throws(() => parse({ docs: { command: 'node', env: { 'BAD=NAME': 'x' } } }));
  assert.throws(() => parseMcpConfig(' '.repeat(262145)));
});

test('Saved placeholders cannot be reused for a renamed service, new endpoint or another stdio command', () => {
  const previous=parse({docs:{url:'https://example.com/mcp'},local:{command:'node',args:['server.js'],env:{}}});
  previous[0].savedHeaders=['authorization'];previous[1].savedEnv=['TOKEN'];
  const next=parseMcpConfig(formatMcpConfig(previous));
  assert.doesNotThrow(()=>validateSavedMcpValues(next,previous));
  const changed=parseMcpConfig(formatMcpConfig(previous));
  if (changed[0].transport!=='stdio') changed[0].url='https://other.example/mcp';
  assert.throws(()=>validateSavedMcpValues(changed,previous),/重新填写凭据/);
  next[1].name='other-process';
  assert.throws(()=>validateSavedMcpValues(next,previous),/重新填写环境变量/);
});

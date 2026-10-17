import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillDirectories } from '../src/state/skillDirectories';

test('Skill directories accept Windows drive and UNC paths, trim blanks and preserve spaces and Unicode', () => {
  const backslash=String.fromCharCode(92);
  const drive=['C:','Skills','one'].join(backslash);
  const unc=backslash+backslash+['server','share','skills'].join(backslash);
  assert.deepEqual(parseSkillDirectories([' '+drive+' ', '', 'D:/My Skills/技能', unc, '//server/share/skills']), [drive,'D:/My Skills/技能',unc,'//server/share/skills']);
  assert.deepEqual(parseSkillDirectories(['', '  ']), []);
});
test('Skill directories reject relative paths, drive-relative roots and control characters with the original row number', () => {
  const backslash=String.fromCharCode(92);
  for (const value of ['skills', 'C:skills', backslash+'skills', '/skills', backslash+backslash+'server', 'C:/a'+String.fromCharCode(0)+'b', 'C:/a'+String.fromCharCode(10)+'b']) assert.throws(() => parseSkillDirectories(['', value]), /第 2 个目录/);
});
test('Skill directories enforce count and UTF-8 byte limits', () => {
  assert.equal(parseSkillDirectories(Array.from({length:16},(_,i)=>`C:/Skills/${i}`)).length,16);
  assert.throws(()=>parseSkillDirectories(Array.from({length:17},(_,i)=>`C:/Skills/${i}`)),/16/);
  assert.throws(()=>parseSkillDirectories(['C:/'+ '目'.repeat(1400)]),/4096 字节/);
});

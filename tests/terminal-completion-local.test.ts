import assert from 'node:assert/strict';
import test from 'node:test';
import {pathQuery,pathSuffix,historySuffix,sensitiveCommand} from '../src/state/terminalCompletionLocal';
test('路径补全支持绝对/相对/父目录/家目录，并对目录和公共前缀筛选',()=>{
  assert.equal(pathQuery('cat /opt/shop/co','/root')!.path,'/opt/shop');
  assert.equal(pathQuery('cat ../co','/opt/shop')!.path,'/opt');
  assert.equal(pathQuery('cat ~/co','/opt/shop','/root')!.path,'/root');
  assert.equal(pathQuery('./scr','/opt/shop')!.path,'/opt/shop');
  assert.equal(pathQuery('docker ps --f','/opt/shop'),null);
  const query=pathQuery('cat co','/opt/shop')!;
  assert.equal(pathSuffix(query,[{name:'config.json',directory:false},{name:'compose.yaml',directory:false}]),'');
  assert.equal(pathSuffix(query,[{name:'compose.yaml',directory:false}]),'mpose.yaml');
  assert.equal(pathSuffix(pathQuery('cd s','/opt/shop')!,[{name:'secret.txt',directory:false},{name:'scripts',directory:true}]),'cripts/');
});
test('文件名空格及引号正确转义，控制字符与命令替换不参与候选',()=>{
  assert.equal(pathSuffix(pathQuery('cat my','/')!,[{name:'my file.txt',directory:false}]),'\\ file.txt');
  assert.equal(pathSuffix(pathQuery("cat 'my",'/')!,[{name:"my'file.txt",directory:false}]),"'\\''file.txt'");
  assert.equal(pathSuffix(pathQuery('cat x','/')!,[{name:'x\nwhoami',directory:false}]),'');
  assert.equal(pathQuery('cat $(whoami)','/'),null);
  assert.equal(pathQuery('cat a; rm /x','/'),null);
  assert.equal(pathSuffix(pathQuery('cat .','/')!,[{name:'.env',directory:false}]),'env');
});
test('本地历史只做前缀匹配，不修改大小写；敏感命令不生成候选',()=>{
  assert.equal(historySuffix('docker l',['docker logs old','docker logs api']),'ogs api');
  assert.equal(historySuffix('Docker',['docker logs api']),'');
  assert.equal(sensitiveCommand('curl --header Authorization: Bearer x'),true);
  assert.equal(sensitiveCommand('export AWS_SECRET_ACCESS_KEY=private'),true);
  assert.equal(sensitiveCommand('curl https://user:password@example.com'),true);
  assert.equal(sensitiveCommand('docker login -u user -p private'),true);
  assert.equal(historySuffix('curl token=',['curl token=secret']),'');
});

test('引号中的完整文件候选自动闭合，接受后可直接回车',()=>{
 const query=pathQuery('cat "my','/')!;
 assert.equal(pathSuffix(query,[{name:'my file.txt',directory:false}]),' file.txt"');
 assert.equal(pathSuffix(pathQuery('cat "my file.txt','/')!,[{name:'my file.txt',directory:false}]),'"');
});


test('完整文件名后空格不重复推荐已有路径，初始空参数仍可补全',()=>{
  const entries=[{name:'get-docker.sh',directory:false}];
  for(const prefix of ['cat get-docker.sh','cat get-docker.sh ','cat get-docker.sh g']){
    assert.equal(pathSuffix(pathQuery(prefix,'/root')!,entries),'',prefix);
  }
  assert.equal(pathSuffix(pathQuery('cat ','/root')!,entries),'get-docker.sh');
  assert.equal(pathSuffix(pathQuery('cat get-docker.sh ','/root')!,[...entries,{name:'README.md',directory:false}]),'README.md');
  assert.equal(pathSuffix(pathQuery('cat get-docker.sh g','/root')!,[...entries,{name:'get-docker.sh.bak',directory:false}]),'et-docker.sh.bak');
});

test('已输入路径按当前目录归一化，支持绝对/相对/家目录及带空格的参数',()=>{
  const entries=[{name:'get-docker.sh',directory:false},{name:'my file.txt',directory:false}];
  for(const prefix of ['cat ./get-docker.sh get-','cat /root/get-docker.sh ./get-','cat ~/get-docker.sh get-','cat ../root/get-docker.sh get-']){
    assert.equal(pathSuffix(pathQuery(prefix,'/root','/root')!,entries),'',prefix);
  }
  for(const prefix of ['cat "my file.txt" my',"cat 'my file.txt' my",'cat my\\ file.txt my']){
    assert.equal(pathSuffix(pathQuery(prefix,'/root')!,entries),'',prefix);
  }
  assert.equal(pathSuffix(pathQuery('cat /other/get-docker.sh get-','/root')!,entries),'docker.sh');
});

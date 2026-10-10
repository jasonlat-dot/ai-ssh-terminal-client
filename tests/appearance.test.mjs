import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/state/clientAppearance.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** 模拟 WebView 存储/图片解码，不访问用户文件、网络或实际客户端配置。 */
function environment() {
  const state = {
    record: undefined, preferences: new Map(), urls: new Map(), revoked: [],
    failWrite: null, failRead: null, failPreference: null, failDecode: false,
    dimensions: { width: 1920, height: 1080 }, dimensionsByMarker: new Map(), sequence: 0, holdWrite: null,
  };
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            const transaction = {};
            transaction.objectStore = () => {
              const operation = kind => value => {
                const request = {};
                queueMicrotask(async () => {
                  if (kind === 'put' && state.holdWrite) {
                    state.holdWrite.started();
                    await state.holdWrite.wait;
                  }
                  const error = kind === 'get' ? state.failRead : state.failWrite;
                  if (error) {
                    transaction.error = error;
                    transaction.onabort();
                    return;
                  }
                  if (kind === 'get') request.result = state.record;
                  if (kind === 'put') state.record = value;
                  if (kind === 'delete') state.record = undefined;
                  transaction.oncomplete();
                });
                return request;
              };
              return { get: operation('get'), put: operation('put'), delete: operation('delete') };
            };
            return transaction;
          },
        };
        request.onsuccess();
      });
      return request;
    },
  };
  const globals = {
    Blob, File, Error, DOMException, indexedDB,
    localStorage: {
      getItem: key => state.preferences.get(key) ?? null,
      setItem(key, value) {
        if (state.failPreference) throw state.failPreference;
        state.preferences.set(key, value);
      },
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:appearance-${++state.sequence}`;
        state.urls.set(url, blob);
        return url;
      },
      revokeObjectURL(url) { state.urls.delete(url); state.revoked.push(url); },
    },
    Image: class {
      async decode() {
        if (state.failDecode) throw new Error('decode failed');
        const bytes = new Uint8Array(await state.urls.get(this.src).slice(8, 9).arrayBuffer());
        const dimensions = state.dimensionsByMarker.get(bytes[0]) ?? state.dimensions;
        this.naturalWidth = dimensions.width;
        this.naturalHeight = dimensions.height;
      }
    },
  };
  // 新建模块模拟客户端重启；只共享持久存储，不共享内存快照或初始化 Promise。
  function load(context = vm.createContext(globals)) {
    // 每次模块求值有自己的局部变量，但热更新仍处于同一个 WebView 全局环境。
    return vm.runInContext(`(function () { const exports = {}; ${compiled}\nreturn exports; })()`, context);
  }
  function session() {
    const context = vm.createContext(globals);
    return { load: () => load(context) };
  }
  return { state, load, session };
}

function png(name = 'wallpaper.png', marker = 0) {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, marker, 0, 0, 0])], name, { type: 'image/png' });
}

function releaseDraft(env, draft) {
  env.state.urls.delete(draft.url);
  env.state.revoked.push(draft.url);
}

// VM 对象与当前 Node realm 不同，用字段值比较持久化的纯数据。
const plain = value => JSON.parse(JSON.stringify(value));

test('保存原图和选区，重启后能反复重裁；每次都读取完整原图而不是上次裁剪图', async () => {
  const env = environment(), api = env.load();
  env.state.dimensionsByMarker.set(1, { width: 3200, height: 1800 });
  env.state.dimensionsByMarker.set(2, { width: 900, height: 900 });
  env.state.dimensionsByMarker.set(3, { width: 1600, height: 900 });
  const source = await api.prepareClientWallpaper(png('cat.png', 1));
  const firstCrop = { ratio: 1, view: { zoom: 2, centerX: .65, centerY: .6 } };
  assert.equal(await api.chooseClientWallpaper(png('cat-wallpaper.png', 2), 'contain', { source, crop: firstCrop }), true);
  assert.equal(api.readClientAppearance().width, 900, '显示用图片保持实际裁剪尺寸');
  assert.equal(env.state.record.original.width, 3200);
  assert.equal(env.state.record.original.name, 'cat.png');
  assert.deepEqual(plain(env.state.record.crop), firstCrop);
  releaseDraft(env, source);

  const reopened = env.load();
  const draft = await reopened.prepareSavedClientWallpaper();
  const originalRecord = env.state.record;
  const currentUrl = reopened.readClientAppearance().wallpaperUrl;
  assert.equal(draft.width, 3200);
  assert.equal(draft.height, 1800);
  assert.equal(draft.name, 'cat.png');
  assert.equal(draft.fit, 'contain');
  assert.equal(draft.limitedSource, false);
  assert.deepEqual(plain(draft.crop), firstCrop);
  assert.equal(env.state.record, originalRecord, '进入编辑不写数据库');
  assert.equal(reopened.readClientAppearance().wallpaperUrl, currentUrl, '进入编辑不替换当前背景');
  assert.deepEqual(await draft.blob.arrayBuffer(), await source.blob.arrayBuffer(), '读回完整原图字节');

  const nextCrop = { ratio: 16 / 9, view: { zoom: 1, centerX: .5, centerY: .5 } };
  assert.equal(await reopened.chooseClientWallpaper(png('cat-wallpaper.png', 3), 'cover', { source: draft, crop: nextCrop }), true);
  releaseDraft(env, draft);
  assert.equal(env.state.record.width, 1600);
  assert.equal(env.state.record.original.width, 3200, '扩大选区不能以旧方形图作为原图');
  const again = await reopened.prepareSavedClientWallpaper();
  assert.deepEqual(plain(again.crop), nextCrop);
  assert.equal(again.fit, 'cover');
  assert.deepEqual(await again.blob.arrayBuffer(), await source.blob.arrayBuffer());
  releaseDraft(env, again);
  await reopened.resetClientAppearance();
  assert.equal(env.state.record, undefined, '恢复默认同时删除原图、裁剪图和选区');
  await assert.rejects(() => reopened.prepareSavedClientWallpaper(), /未找到/);
});

test('重新编辑取消不写库，不改显示；切换铺满/完整显示仍保留原图与选区', async () => {
  const env = environment(), api = env.load();
  const source = await api.prepareClientWallpaper(png('original.png'));
  const crop = { ratio: 1.731, view: { zoom: 2.5, centerX: .48, centerY: .6 } };
  await api.chooseClientWallpaper(png('crop.png'), 'contain', { source, crop });
  releaseDraft(env, source);
  const before = api.readClientAppearance(), record = env.state.record;
  const draft = await api.prepareSavedClientWallpaper();
  assert.equal(api.readClientAppearance(), before);
  assert.equal(env.state.record, record);
  draft.crop.view.zoom = 3;
  assert.equal(record.crop.view.zoom, 2.5, '编辑选区不是数据库对象的可变引用');
  releaseDraft(env, draft);
  assert.equal(env.state.urls.size, 1, '取消只释放草稿，仍保留当前显示 URL');
  await api.setClientWallpaperFit('cover');
  assert.equal(env.state.record.original, record.original);
  assert.deepEqual(plain(env.state.record.crop), crop);
  const reopened = await api.prepareSavedClientWallpaper();
  assert.equal(reopened.fit, 'cover');
  assert.equal(reopened.crop.ratio, 1.731, '上次窗口比例不是重新读取当前窗口而得');
  releaseDraft(env, reopened);
});

test('旧版只有裁剪图时允许继续编辑并保留受限标记，重新上传原图后解除限制', async () => {
  const env = environment(), api = env.load();
  env.state.record = { blob: png('legacy.png'), name: 'legacy.png', width: 1920, height: 1080, fit: 'contain' };
  const draft = await api.prepareSavedClientWallpaper();
  assert.equal(draft.limitedSource, true);
  assert.equal(draft.crop.ratio, 1920 / 1080);
  const crop = { ratio: 1, view: { zoom: 1.5, centerX: .6, centerY: .5 } };
  await api.chooseClientWallpaper(png('legacy-wallpaper.png'), draft.fit, { source: draft, crop, limitedSource: draft.limitedSource });
  releaseDraft(env, draft);
  const again = await env.load().prepareSavedClientWallpaper();
  assert.equal(again.limitedSource, true, '不能把保存过一次的旧裁剪图谎称为原图');
  assert.deepEqual(plain(again.crop), crop);
  releaseDraft(env, again);
  const replacement = await api.prepareClientWallpaper(png('new-original.png'));
  await api.chooseClientWallpaper(png('new-wallpaper.png'), 'cover', { source: replacement, crop });
  releaseDraft(env, replacement);
  const replaced = await api.prepareSavedClientWallpaper();
  assert.equal(replaced.limitedSource, false);
  assert.equal(replaced.name, 'new-original.png');
  releaseDraft(env, replaced);
});

test('原图损坏或读取失败仅阻止再次编辑，保留当前可显示的壁纸并释放解码 URL', async () => {
  const env = environment(), api = env.load();
  await api.chooseClientWallpaper(png('current.png'));
  const current = api.readClientAppearance().wallpaperUrl;
  const original = env.state.record.original;
  env.state.record.original = { ...original, blob: new Blob(['<svg/>'], { type: 'image/png' }) };
  await assert.rejects(() => api.prepareSavedClientWallpaper(), /仅支持/);
  assert.equal(api.readClientAppearance().wallpaperUrl, current);
  assert.equal(env.state.urls.size, 1);
  env.state.record.original = original;
  env.state.failDecode = true;
  await assert.rejects(() => api.prepareSavedClientWallpaper(), /解码/);
  assert.equal(env.state.urls.size, 1);
  env.state.failDecode = false;
  env.state.failRead = new Error('read denied');
  await assert.rejects(() => api.prepareSavedClientWallpaper(), /read denied/);
  assert.equal(api.readClientAppearance().wallpaperUrl, current);
});

test('损坏选区退回完整原图，不能让 NaN、非法中心或缩放值进入编辑器', async () => {
  const env = environment(), api = env.load();
  await api.chooseClientWallpaper(png());
  for (const crop of [null, {}, { ratio: Number.NaN },
    { ratio: 1, view: { zoom: 5, centerX: .5, centerY: .5 } },
    { ratio: -1, view: { zoom: 1, centerX: .5, centerY: .5 } },
    { ratio: 1, view: { zoom: 1, centerX: 2, centerY: .5 } },
  ]) {
    env.state.record.crop = crop;
    const draft = await api.prepareSavedClientWallpaper();
    assert.deepEqual(plain(draft.crop), { ratio: 1920 / 1080, view: { zoom: 1, centerX: .5, centerY: .5 } });
    releaseDraft(env, draft);
  }
  assert.equal(env.state.urls.size, 1);
});

test('存储不足或非法原图/选区不替换任何已保存内容；失败后同一原图草稿可重试', async () => {
  const env = environment(), api = env.load();
  await api.chooseClientWallpaper(png('old.png'));
  const record = env.state.record, current = api.readClientAppearance().wallpaperUrl;
  const source = await api.prepareClientWallpaper(png('new-original.png'));
  const crop = { ratio: 1, view: { zoom: 2, centerX: .5, centerY: .5 } };
  assert.equal(await api.chooseClientWallpaper(png(), 'contain', { source, crop: { ...crop, ratio: 0 } }), false);
  assert.equal(env.state.record, record);
  assert.equal(await api.chooseClientWallpaper(png(), 'contain', { source: { ...source, blob: new Blob(['bad']) }, crop }), false);
  assert.equal(env.state.record, record);
  env.state.failWrite = new DOMException('full', 'QuotaExceededError');
  assert.equal(await api.chooseClientWallpaper(png('new-crop.png'), 'contain', { source, crop }), false);
  assert.equal(api.readClientAppearance().wallpaperUrl, current);
  assert.equal(api.readClientAppearance().wallpaperFit, 'cover');
  assert.equal(env.state.record, record);
  assert.match(api.readClientAppearance().error, /存储空间不足/);
  assert.equal(env.state.urls.size, 2, '保存失败也保留原图草稿，取消或成功后再释放');
  env.state.failWrite = null;
  assert.equal(await api.chooseClientWallpaper(png('new-crop.png'), 'contain', { source, crop }), true);
  assert.equal(env.state.record.original.name, 'new-original.png');
  assert.deepEqual(plain(env.state.record.crop), crop);
  releaseDraft(env, source);
  assert.equal(env.state.urls.size, 1);
});

test('壁纸和透明度持久化，重新初始化后恢复；初始化只执行一次', async () => {
  const env = environment(), api = env.load();
  const first = api.initializeClientAppearance();
  assert.equal(first, api.initializeClientAppearance());
  await first;
  assert.equal(api.readClientAppearance().transparency, 25);
  await api.chooseClientWallpaper(png());
  api.setClientPanelTransparency(48);
  assert.equal(api.readClientAppearance().wallpaperName, 'wallpaper.png');
  assert.equal(env.state.record.blob.type, 'image/png');
  assert.equal(env.state.urls.size, 1, '只保留当前壁纸 URL，验证用的临时 URL 已释放');
  const reopened = env.load();
  await reopened.initializeClientAppearance();
  assert.equal(reopened.readClientAppearance().wallpaperName, 'wallpaper.png');
  assert.equal(reopened.readClientAppearance().transparency, 48);
  assert.equal(reopened.readClientAppearance().width, 1920);
});

test('同一 WebView 内模块热更新保留壁纸、初始化和订阅，旧工作区与新设置页同步', async () => {
  const env = environment(), session = env.session(), workspace = session.load();
  await workspace.chooseClientWallpaper(png('cat.png'));
  workspace.setClientPanelTransparency(80);
  let applied = workspace.readClientAppearance();
  const release = workspace.subscribeClientAppearance(() => { applied = workspace.readClientAppearance(); });
  const settings = session.load();
  assert.equal(settings.readClientAppearance(), workspace.readClientAppearance(), '新旧消费者必须共享同一快照');
  assert.equal(settings.initializeClientAppearance(), workspace.initializeClientAppearance(), '不能重复从数据库初始化');
  const originalUrl = applied.wallpaperUrl;
  settings.setClientPanelTransparency(55);
  assert.equal(applied.transparency, 55, '旧根背景订阅必须收到新设置页的变化');
  settings.setClientReadabilityProtection(false);
  assert.equal(applied.readabilityProtection, false);
  await settings.chooseClientWallpaper(png('new.png'));
  assert.equal(applied.wallpaperName, 'new.png');
  assert.ok(env.state.revoked.includes(originalUrl));
  assert.equal(env.state.urls.size, 1, '热更新不创建重复 URL 或泄漏旧图');
  await settings.resetClientAppearance();
  assert.equal(applied.wallpaperUrl, null, '恢复默认同时清空旧根背景');
  release();
  settings.setClientPanelTransparency(75);
  assert.equal(applied.transparency, 25, '旧订阅可正常解除');
});

test('保存图片期间热更新不会读取旧数据库结果或允许重复操作，提交后设置页同步', async () => {
  const env = environment(), session = env.session(), workspace = session.load();
  let resumeWrite, startedWrite;
  env.state.holdWrite = {
    wait: new Promise(resolve => { resumeWrite = resolve; }),
    started: () => startedWrite(),
  };
  const started = new Promise(resolve => { startedWrite = resolve; });
  const saving = workspace.chooseClientWallpaper(png('cat.png'));
  await started;
  assert.equal(env.state.record, undefined, '数据库事务此时还没提交');
  const settings = session.load();
  await settings.initializeClientAppearance();
  assert.equal(settings.readClientAppearance().busy, true, '新设置页必须保留正在保存状态');
  await settings.chooseClientWallpaper(png('duplicate.png'));
  resumeWrite();
  await saving;
  assert.equal(settings.readClientAppearance(), workspace.readClientAppearance());
  assert.equal(settings.readClientAppearance().wallpaperName, 'cat.png');
  assert.equal(settings.readClientAppearance().busy, false);
  assert.equal(env.state.record.name, 'cat.png');
  assert.equal(env.state.urls.size, 1);
});

test('裁剪草稿不写入存储或改变当前壁纸；取消释放临时 URL，失败可重试', async () => {
  const env = environment(), api = env.load();
  assert.equal(await api.chooseClientWallpaper(png('old.png')), true);
  const original = api.readClientAppearance();
  const draft = await api.prepareClientWallpaper(png('candidate.png'));
  assert.equal(draft.name, 'candidate.png');
  assert.equal(api.readClientAppearance(), original);
  assert.equal(env.state.record.name, 'old.png');
  assert.equal(env.state.urls.size, 2, '原壁纸 URL 与草稿 URL 各一份');
  // 组件取消或卸载时释放草稿，不触碰已保存的壁纸。
  // URL 的释放属于组件生命周期，模拟与组件相同的 revoke 行为。
  env.state.urls.delete(draft.url);
  env.state.revoked.push(draft.url);
  assert.equal(env.state.urls.size, 1);
  await assert.rejects(() => api.prepareClientWallpaper(new File(['bad'], 'bad.jpg')), /仅支持/);
  assert.equal(api.readClientAppearance(), original);
  env.state.failWrite = new Error('save failed');
  assert.equal(await api.chooseClientWallpaper(png('cropped.png')), false);
  assert.equal(api.readClientAppearance().wallpaperUrl, original.wallpaperUrl);
  assert.equal(env.state.record.name, 'old.png');
  env.state.failWrite = null;
  assert.equal(await api.chooseClientWallpaper(png('cropped.png')), true);
});

test('方形壁纸完整显示方式随图片保存，重启/热更新保留；修改失败不改变现有方式', async () => {
  const env = environment(), session = env.session(), api = session.load();
  env.state.dimensions = { width: 1080, height: 1080 };
  await api.chooseClientWallpaper(png('square.png'), 'contain');
  const url = api.readClientAppearance().wallpaperUrl;
  assert.equal(api.readClientAppearance().wallpaperFit, 'contain');
  assert.equal(env.state.record.fit, 'contain');
  assert.equal(session.load().readClientAppearance().wallpaperFit, 'contain');
  const reopened = env.load();
  await reopened.initializeClientAppearance();
  assert.equal(reopened.readClientAppearance().wallpaperFit, 'contain');
  await api.setClientWallpaperFit('cover');
  assert.equal(api.readClientAppearance().wallpaperFit, 'cover');
  assert.equal(api.readClientAppearance().wallpaperUrl, url, '只改显示方式不重建图片 URL');
  assert.equal(env.state.record.fit, 'cover');
  env.state.failWrite = new Error('fit save failed');
  await api.setClientWallpaperFit('contain');
  assert.equal(api.readClientAppearance().wallpaperFit, 'cover');
  assert.equal(api.readClientAppearance().error, 'fit save failed');
  env.state.failWrite = null;
  await api.resetClientAppearance();
  assert.equal(api.readClientAppearance().wallpaperFit, 'cover');
});

test('旧图片没有显示方式时默认铺满；热更新旧快照新增字段不丢失壁纸', async () => {
  const env = environment(), session = env.session(), api = session.load();
  await api.chooseClientWallpaper(png());
  delete env.state.record.fit;
  const reopened = env.load();
  await reopened.initializeClientAppearance();
  assert.equal(reopened.readClientAppearance().wallpaperFit, 'cover');
  const snapshot = api.readClientAppearance(), url = snapshot.wallpaperUrl;
  delete snapshot.wallpaperFit;
  const updated = session.load();
  assert.equal(updated.readClientAppearance().wallpaperFit, 'cover');
  assert.equal(updated.readClientAppearance().wallpaperUrl, url);
});

test('非法文件、过大图片、解码失败和写入失败不覆盖旧壁纸', async () => {
  const env = environment(), api = env.load();
  await api.chooseClientWallpaper(png('old.png'));
  const original = api.readClientAppearance().wallpaperUrl;
  for (const file of [
    new File(['<svg></svg>'], 'fake.png', { type: 'image/png' }),
    new File([], 'empty.png'),
    new File([new Uint8Array(api.MAX_WALLPAPER_BYTES + 1)], 'large.png'),
  ]) {
    await api.chooseClientWallpaper(file);
    assert.ok(api.readClientAppearance().error);
    assert.equal(api.readClientAppearance().wallpaperUrl, original);
  }
  env.state.dimensions.width = 9000;
  await api.chooseClientWallpaper(png());
  assert.match(api.readClientAppearance().error, /8192/);
  env.state.dimensions.width = 1920;
  env.state.failDecode = true;
  await api.chooseClientWallpaper(png());
  assert.match(api.readClientAppearance().error, /解码/);
  env.state.failDecode = false;
  env.state.failWrite = new DOMException('full', 'QuotaExceededError');
  await api.chooseClientWallpaper(png());
  assert.match(api.readClientAppearance().error, /存储空间不足/);
  assert.equal(api.readClientAppearance().wallpaperUrl, original);
  assert.equal(env.state.record.name, 'old.png');
  assert.equal(env.state.urls.size, 1, '失败时也释放未采用的 Blob URL');
  assert.equal(api.readClientAppearance().busy, false);
});

test('成功替换释放旧 URL；恢复默认清除存储并恢复透明度', async () => {
  const env = environment(), api = env.load();
  await api.chooseClientWallpaper(png('old.png'));
  const original = api.readClientAppearance().wallpaperUrl;
  await api.chooseClientWallpaper(png('new.png'));
  assert.ok(env.state.revoked.includes(original));
  api.setClientPanelTransparency(70);
  await api.resetClientAppearance();
  assert.equal(api.readClientAppearance().wallpaperUrl, null);
  assert.equal(api.readClientAppearance().transparency, 25);
  assert.equal(env.state.record, undefined);
  assert.equal(env.state.urls.size, 0);
  const reopened = env.load();
  await reopened.initializeClientAppearance();
  assert.equal(reopened.readClientAppearance().wallpaperUrl, null);
});

test('透明度范围校验和存储异常处理；删除失败回滚透明度偏好', async () => {
  const env = environment(), api = env.load();
  await api.chooseClientWallpaper(png());
  api.setClientPanelTransparency(-10);
  assert.equal(api.readClientAppearance().transparency, 0);
  api.setClientPanelTransparency(200);
  assert.equal(api.readClientAppearance().transparency, 100);
  api.setClientPanelTransparency(35.4);
  api.setClientPanelTransparency(Number.NaN);
  assert.equal(api.readClientAppearance().transparency, 35);
  env.state.failPreference = new Error('storage denied');
  api.setClientPanelTransparency(70);
  assert.equal(api.readClientAppearance().transparency, 35);
  assert.equal(api.readClientAppearance().error, 'storage denied');
  env.state.failPreference = null;
  env.state.failWrite = new Error('delete failed');
  await api.resetClientAppearance();
  assert.ok(api.readClientAppearance().wallpaperUrl);
  assert.equal(api.readClientAppearance().transparency, 35);
  assert.equal(env.state.preferences.get('agent-ssh-panel-transparency-v1'), '35');
});

test('已保存的损坏数据不阻止启动，仍可以重新选择有效图片', async () => {
  const env = environment();
  env.state.record = { blob: 'not a blob', name: 'broken.png' };
  env.state.preferences.set('agent-ssh-panel-transparency-v1', 'invalid');
  const api = env.load();
  await api.initializeClientAppearance();
  assert.equal(api.readClientAppearance().ready, true);
  assert.equal(api.readClientAppearance().transparency, 25);
  assert.ok(api.readClientAppearance().error);
  await api.chooseClientWallpaper(png());
  assert.equal(api.readClientAppearance().error, null);
  assert.ok(api.readClientAppearance().wallpaperUrl);
});

test('拖动滑块仅更新背景变量，不反复写 data-wallpaper 触发终端主题重绘', async () => {
  const env = environment(), api = env.load();
  const properties = new Map();
  let attributeWrites = 0, cleanup;
  const root = {
    dataset: new Proxy({}, { set(target, key, value) { if (key === 'wallpaper') attributeWrites++; target[key] = value; return true; } }),
    style: {
      getPropertyValue: key => properties.get(key) ?? '',
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: key => properties.delete(key),
    },
  };
  const hookSource = readFileSync(new URL('../src/state/useClientAppearance.ts', import.meta.url), 'utf8');
  const hookContext = vm.createContext({
    exports: {}, document: { documentElement: root },
    require(name) {
      if (name === 'react') return { useLayoutEffect: callback => { cleanup = callback(); } };
      return api;
    },
  });
  vm.runInContext(ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, hookContext);
  hookContext.exports.useApplyClientAppearance();
  await api.chooseClientWallpaper(png());
  const count = attributeWrites;
  for (let value = 0; value <= 100; value++) api.setClientPanelTransparency(value);
  assert.equal(attributeWrites, count);
  assert.equal(properties.get('--client-panel-opacity'), '0%');
  assert.equal(root.dataset.wallpaperProtection, 'true');
  assert.equal(root.dataset.wallpaperReadability, 'true');
  assert.equal(properties.get('--client-wallpaper-blur'), '4.00px');
  api.setClientReadabilityProtection(false);
  assert.equal(root.dataset.wallpaperProtection, 'false');
  assert.equal(root.dataset.wallpaperReadability, 'false');
  assert.equal(properties.get('--client-wallpaper-blur'), '0.00px');
  assert.equal(attributeWrites, count, '保护开关也不触发 xterm 底色重绘');
  await api.setClientWallpaperFit('contain');
  assert.equal(properties.get('--client-wallpaper-size'), 'contain');
  assert.equal(root.dataset.wallpaperFit, 'contain');
  assert.equal(attributeWrites, count, '显示方式不触发终端重绘');
  cleanup();
  assert.equal(root.dataset.wallpaper, undefined);
  assert.equal(root.dataset.wallpaperProtection, undefined);
  assert.equal(root.dataset.wallpaperReadability, undefined);
  assert.equal(properties.has('--client-wallpaper-blur'), false);
  assert.equal(properties.has('--client-wallpaper-size'), false);
  assert.equal(root.dataset.wallpaperFit, undefined);
});

/** 样式契约检查不替代 WebView 截图验收，防止重新引入多层主题底色和空白漏底。 */
const wallpaperCss = readFileSync(new URL('../src/wallpaper.css', import.meta.url), 'utf8');
const wallpaperRules = [...wallpaperCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('工作区与空白间距共用根背景遮罩，所有规则仅在设置壁纸时生效', () => {
  assert.ok(wallpaperRules.every(rule => rule.selector.startsWith(":root[data-wallpaper='true']")));
  const backdrop = wallpaperRules.find(rule => rule.selector.endsWith('#root::before'));
  assert.match(backdrop.body, /inset:\s*0/);
  assert.match(backdrop.body, /linear-gradient\(var\(--client-wallpaper-tint\),\s*var\(--client-wallpaper-tint\)\),\s*var\(--client-wallpaper-image\)/);
  assert.match(backdrop.body, /background-size:\s*100% 100%, var\(--client-wallpaper-size, cover\)/);
  assert.match(wallpaperRules.find(rule => rule.selector.includes("[data-wallpaper-fit='contain']")).body, /transform:\s*none/);
  const panels = wallpaperRules.find(rule => rule.selector.includes('.app-shell .terminal-tabs'));
  assert.match(panels.body, /background:\s*transparent/);
  for (const selector of ['.central-workspace', '.terminal-workspace', '.terminal-body', '.command-shelf-inner']) {
    assert.ok(panels.selector.includes(selector));
  }
  assert.ok(wallpaperRules.every(rule => [...rule.body.matchAll(/(?:^|;)\s*opacity\s*:\s*([^;]+)/g)]
    .every(([, value]) => value.trim() === '1')), '不能淡化前景；占位文字可以显式设为完全不透明');
});

test('命令、连接、聊天的内部主题底色清除，选中与悬停底色也使用透明度变量', () => {
  const cards = wallpaperRules.find(rule => rule.selector.includes('.command-row,') && rule.selector.includes('.chat-composer textarea'));
  assert.match(cards.body, /background:\s*transparent/);
  for (const selector of ['.command-categories button', '.sidebar-host', '.terminal-tab', '.theme-switcher']) {
    assert.ok(cards.selector.includes(selector));
  }
  assert.ok(cards.selector.includes('.modal *'), '浮层控件须排除在背景清除规则之外');
  const selected = wallpaperRules.find(rule => rule.selector.includes('.command-categories button.selected'));
  assert.match(selected.body, /background:.*var\(--client-panel-opacity/);
  const hovered = wallpaperRules.find(rule => rule.selector.includes(':hover:not(:disabled)'));
  assert.match(hovered.body, /background:.*var\(--client-panel-opacity/);
});

test('设置页独立背景变量与自定义选择器均覆盖，不影响 portal 选项浮层或壁纸预览', () => {
  const variables = wallpaperRules.find(rule => rule.selector === ":root[data-wallpaper='true'][data-theme] .settings-page");
  assert.match(variables.body, /--settings-panel:\s*transparent/);
  assert.match(variables.body, /--settings-panel-soft:\s*transparent/);
  assert.match(variables.body, /--settings-selection-bg:.*var\(--client-panel-opacity/);
  assert.ok(!/--theme-panel\s*:/.test(variables.body), '不能把 portal 使用的根级主题底色也清空');
  const controls = wallpaperRules.find(rule => rule.selector.includes('.settings-control,') && rule.selector.includes('.ui-select-trigger,'));
  assert.match(controls.body, /background:\s*transparent/);
  assert.ok(controls.selector.includes('button:not(:where(.primary-button, .danger-button, .toggle))'));
  for (const selector of ['.settings-certificate-action', '.settings-certificate-icon', '.settings-input-suffix']) {
    assert.ok(controls.selector.includes(selector));
  }
  assert.ok(controls.selector.includes("[role='listbox'] *"), '浮层控件须排除');
  assert.ok(!controls.selector.includes('.appearance-preview'), '不能覆盖壁纸预览图片');
  assert.ok(!wallpaperRules.some(rule => rule.selector.includes('.ui-select-menu')), '下拉菜单不应透明');
  const selected = wallpaperRules.find(rule => rule.selector.includes('.settings-reasoning-card.selected'));
  assert.ok(selected.selector.includes('.settings-path-preset-list button.selected'));
  assert.ok(selected.selector.includes('.settings-storage-card.selected'));
  assert.match(selected.body, /background:\s*var\(--settings-selection-bg\)/);
});

test('可读性保护默认启用、独立保存；关闭后可恢复完全透明且失败不谎报保存', async () => {
  const env = environment(), api = env.load();
  assert.equal(api.readClientAppearance().readabilityProtection, true);
  assert.equal(api.wallpaperReadability(25, true).blur, 0);
  assert.equal(api.wallpaperReadability(49, true).strengthenText, false);
  assert.equal(api.wallpaperReadability(50, true).strengthenText, true);
  assert.equal(api.wallpaperReadability(100, true).blur, 4);
  assert.equal(api.wallpaperReadability(999, true).blur, 4);
  assert.equal(api.wallpaperReadability(100, false).blur, 0);
  api.setClientReadabilityProtection(false);
  const reopened = env.load();
  assert.equal(reopened.readClientAppearance().readabilityProtection, false);
  env.state.failPreference = new Error('storage denied');
  reopened.setClientReadabilityProtection(true);
  assert.equal(reopened.readClientAppearance().readabilityProtection, false);
  assert.equal(reopened.readClientAppearance().error, 'storage denied');
});

test('保护仅柔化底层图片，遮罩有最低值，文字对比随主题切换', () => {
  const protection = wallpaperRules.find(rule => rule.selector === ":root[data-wallpaper='true'][data-wallpaper-protection='true']");
  assert.match(protection.body, /--client-wallpaper-minimum-tint:\s*65%/);
  assert.match(protection.body, /max\(var\(--client-panel-opacity/);
  const darkProtection = wallpaperRules.find(rule => rule.selector.includes("[data-wallpaper-protection='true'][data-theme='dark']"));
  assert.match(darkProtection.body, /--client-wallpaper-minimum-tint:\s*70%/);
  const filtered = wallpaperRules.filter(rule => /(?:^|;)\s*filter\s*:/.test(rule.body));
  assert.equal(filtered.length, 1);
  assert.ok(filtered[0].selector.endsWith('#root::before'), '不能模糊整个应用或终端');
  for (const themeSelector of ["[data-wallpaper-readability='true']", "[data-wallpaper-readability='true'][data-theme='dark']"]) {
    const palette = wallpaperRules.find(rule => rule.selector === `:root[data-wallpaper='true']${themeSelector}`);
    assert.match(palette.body, /--theme-text-muted:/);
    assert.match(palette.body, /--accent-danger-ink:/);
  }
});

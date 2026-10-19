import { APP_VERSION } from './appRuntime';

// Select by the package version so future releases do not need a second version constant.
const releases = import.meta.glob<string>(['../../docs/releases/v*.md', '!../../docs/releases/*-*.md'], {
  eager: true, query: '?raw', import: 'default',
});
export const CURRENT_RELEASE = {
  version: APP_VERSION,
  notes: releases[`../../docs/releases/v${APP_VERSION}.md`]?.trim() || '此版本未提供更新说明。',
};
